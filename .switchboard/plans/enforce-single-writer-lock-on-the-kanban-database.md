# Two processes on one board silently destroy each other's data — enforce a single-writer lock at the database chokepoint

## Goal

Make concurrent write access to a Switchboard board **impossible**, not merely discouraged, by acquiring an OS-enforced exclusive lock at `KanbanDatabase.forWorkspace` and refusing to flush without it. A second server, or a script run against a live board, must fail loudly and immediately instead of overwriting the board.

### Problem Analysis

The board is not a concurrently-accessible database. It is a **whole-file image**, and every writer replaces all of it.

`KanbanDatabase` uses **sql.js** (`package.json`: `sql.js ^1.14.1`) — SQLite compiled to WebAssembly:

- Open loads the entire file into memory as one image: `new SQL.Database(new Uint8Array(fileBuffer))` (`src/services/KanbanDatabase.ts:6928`, `:7006`).
- Persist exports that image and replaces the file wholesale: `const data = this._db.export()` → `fs.writeFileSync(tmpPath, Buffer.from(data))` → `fs.renameSync(tmpPath, this._dbPath)` (`:1807-1811`). Four `export()` sites exist — `:1698`, `:1807`, `:7365`, `:9741`.
- Writes are **debounced** via `_persistDebounceTimer` (`:1801-1804`), so mutations are coalesced and the flush lands well after the change.
- sql.js is WASM with no VFS file locking. There is no journal, no WAL, no `busy_timeout`, and **no lock of any kind anywhere in the codebase** — `grep` for `.lock`, `O_EXCL`, `'wx'` and `flock` across `KanbanDatabase.ts` and `src/standalone/bootstrap.ts` returns nothing.

The consequence: two processes holding the same board each have a complete private copy. Each flush overwrites the entire file. **The last writer wins totally, and every change the other process made since its own open is destroyed** — no error, no conflict, no detection, no recovery. The debounce widens the window; the atomic rename guarantees the destruction is clean rather than a torn file.

Three distinct ways this happens today:

1. **Extension-after-standalone.** `npx switchboard` is running on a folder; the user opens VS Code on that folder. The extension's only pre-start guard is `if (this.suppressLocalApiServer || globalThis.__SWITCHBOARD_STANDALONE_WORKSPACE_ROOT)` (`src/services/TaskViewerProvider.ts:3198-3202`) — **both are in-process flags**, set by `src/standalone/bootstrap.ts:1023` and `src/standalone/vscodeShim.ts:456` inside the standalone process. A separate VS Code process sees neither and calls nothing equivalent to `findRunningInstance`. It starts its own server and opens its own DB image.
2. **Any script against a live board.** `move-card.js:117` requires `KanbanDatabase` directly as an HTTP fallback, and `get-state.js` opens it as its only path. Either, run while a server is live, is a third full-image writer.
3. **The extension writes independently of its API server.** There are **136 `KanbanDatabase.forWorkspace` / `new KanbanDatabase` call sites** outside tests — 23 in `TaskViewerProvider.ts`, 17 in `KanbanProvider.ts`, 14 each in `PlanningPanelProvider.ts` and `DesignPanelProvider.ts`, 11 in `extension.ts`, 7 in `PlanIngestionEngine.ts`. So `suppressLocalApiServer` does **not** make a host read-only; it only stops the HTTP server. Gating the server would not gate the writes.

The one direction that *is* guarded is standalone-after-anything: `findRunningInstance` (`src/standalone/cli.ts:323-330`) reads the port file and probes `/health`, and `cli.ts:1234-1239` exits 1 with *"Reusing is not supported (single writer)"*. That is the correct intent — but it is advisory (a check-then-act with a TOCTOU window), it depends on a port file existing, it guards only the CLI entry point, and it does nothing about scripts or about the extension.

### Root Cause

The single-writer requirement is real and was **known** — the CLI's refusal message names it explicitly, and the `EADDRINUSE` comment at `cli.ts:1350-1357` reasons carefully about not stacking "two engines importing the same plan files". But it was enforced at **one entry point** (the standalone CLI's launch path) rather than at the **resource** (the database). Every other way to reach the DB — a second editor process, a helper script, any of the 136 `forWorkspace` sites — bypasses the guard entirely, because the guard was never where the data is.

The deeper cause is that a whole-file image store was given a multi-process API surface. With `export()`-and-replace semantics, "one writer" is not a policy choice; it is a correctness precondition, and it must be enforced where the write happens.

### Non-goals

- **Replacing sql.js with a real multi-process SQLite driver.** That would make concurrency genuinely safe rather than merely prevented, and is the right long-term answer, but it is a large migration touching all 136 call sites and every migration path. This plan makes the current engine safe. Note the swap as a future direction.
- **Merging concurrent edits.** With whole-file images there is nothing to merge. Prevention only.
- **Read concurrency.** Readers are safe and must stay safe — a reader loads an image and never exports. Read-only access must remain unlocked, or the kanban query skill and `get-state.js` break.
- **Migrations.** No on-disk format change. The lock file is new state; a stale one is reclaimed, never migrated.

## Metadata

**Complexity:** 7
**Tags:** database, reliability, backend, bugfix, devops, api

## Proposed Changes

1. **Acquire the lock at the resource, not the entry point.** Gate `KanbanDatabase.forWorkspace` (`src/services/KanbanDatabase.ts:1258`) — the cached factory all 136 sites funnel through. Locking here is what makes the guarantee hold for a second editor, a helper script, and a future caller nobody has written yet.

2. **Use an OS-enforced exclusive create, not a check-then-act.** `fs.openSync(lockPath, 'wx')` — `O_CREAT|O_EXCL` is atomic in the kernel, so two racing processes cannot both succeed. Do **not** implement `if (!exists) create`; that reintroduces the TOCTOU window the current advisory check already has. Lock path: `.switchboard/kanban.db.lock`, beside the DB it guards, keyed to the resolved DB path rather than the workspace root (a custom `kanban.dbPath` and workspace mappings mean two roots can legitimately share one DB — `_redirectToParentIfMapped` at `:1165` exists for exactly that, and the lock must follow the DB).

3. **Record enough in the lock to adjudicate staleness.** JSON: `pid`, `hostKind` (`extension` | `standalone` | `script`), `port` (if any), `startedAt`, `dbPath`, and a random `nonce`. The nonce is what makes PID recycling detectable — a recycled PID plus a matching start time is otherwise indistinguishable from the original owner.

4. **Reclaim a stale lock, bounded and atomically.** On `EEXIST`: read the lock, test liveness with `process.kill(pid, 0)` (`ESRCH` ⇒ dead), and where a port is recorded, additionally probe `/health` and require the returned `pid` to match — reusing the reasoning already documented at `src/standalone/cli.ts:296-299` about never trusting a port that a non-Switchboard service might hold. If dead: unlink and retry the exclusive create **once**. If the retry also hits `EEXIST`, another process won the reclaim — treat it as held and stand down. Never loop unbounded; never force-unlink a live owner.

5. **Refuse to flush without ownership — the belt to step 1's braces.** Gate all four `export()` sites (`:1698`, `:1807`, `:7365`, `:9741`) and the debounced `_persist` on holding the lock. A process that somehow obtained a DB handle without the lock must be **incapable** of writing, not merely unlikely to. This is the check that makes the guarantee robust against a call path nobody audited.

6. **Open read-only when the lock is held, and make read-only actually read-only.** A reader loads an image and never exports, so it cannot clobber. Set an explicit `readOnly` flag on the instance so every mutation path throws a typed, named error rather than mutating an image that will never be persisted — a silent no-op write is a worse failure than a thrown one.

7. **Standalone loser: keep the existing refusal, back it with the lock.** `cli.ts:1234-1239` already exits 1 with the right message. Re-express it in terms of lock acquisition so the advisory probe is no longer the thing being trusted, and extend the message to name the owning `hostKind` and `pid` from the lock — "already running" is far more actionable when it says *which* process.

8. **Extension loser: attach to the owner rather than degrade.** *Recommended, and the one substantive design decision here.* When the extension cannot take the lock, it should not start a server or open the DB for writing. Instead point the sidebar and panels at the **owning server's** port, read from the port file. The machinery already exists: the extension serves the same browser board and shares the panel HTML (`src/services/TaskViewerProvider.ts:4036-4044`), and `suppressLocalApiServer` (`:4420`) is already the "this host runs no server of its own" mode — this makes it reachable from a cross-process signal instead of only an in-process flag. The user gets one working board instead of two boards racing.

9. **Fall back to a signposted read-only board if attach is not viable**, with a banner naming the owning process and pid. **Do not fail silently and do not present a writable UI that discards writes** — that is the current behavior's failure mode dressed up as a feature.

10. **Reload a read-only image on change.** A read-only holder's in-memory snapshot goes stale the moment the owner flushes, so it must watch the DB path's mtime and reload, or explicitly display its snapshot age. A board silently showing a five-minute-old state is a new bug introduced by this fix, and must not be shipped.

11. **Remove `move-card.js`'s direct-DB fallback** (`.agents/skills/kanban_operations/move-card.js:117`). With the token plan landing, the HTTP path works under both hosts, so the fallback's only remaining function is to write a full DB image from a script process while a server may be live — the exact clobber this plan exists to prevent. Delete it rather than lock-gating it: a card move that silently bypasses the API also bypasses provenance stamping. If a DB fallback must survive, it acquires the lock like any other writer and reports refusal.

12. **Make `get-state.js` explicitly read-only** — it only reads, so it must open with the read-only flag and take no lock, proving the read path stays unblocked.

13. **Release on every exit path.** Unlink alongside the existing port/pid file teardown: `src/standalone/bootstrap.ts:3220` (`instance.stop()`) and `:3226` (`syncUnlinkPortFile`, the signal path), and the extension's stop path (`src/services/TaskViewerProvider.ts:4348-4358`). A crash leaves a stale lock, which step 4 reclaims — that is the designed path, not a failure.

14. **Do not add the lock to the watchdog's health predicate.** `_checkApiServerLiveness` (`:4315-4324`) checks port-file existence and would restart-loop on a legitimately absent file; the comment there says so. The lock must not become a second such trigger.

## Edge-Case & Dependency Audit

- **The lock must never be the thing that breaks a working single-host setup.** The overwhelmingly common case is one host, no contention. Acquisition must be fast, must not block on a network round-trip in the happy path, and any unexpected error acquiring it must be surfaced loudly rather than silently degrading a working board to read-only. Verification step 2 is the guard.
- **PID recycling.** `process.kill(pid, 0)` succeeding proves *a* process exists, not *the* process. Require the `/health` pid match where a port is recorded, and the `nonce` where it is not.
- **Network filesystems.** `O_CREAT|O_EXCL` is not reliably atomic on all network filesystems. A board on a network share is out of scope, but the limitation must be stated in the lock file's own header comment and in the error text, so a user hitting it gets a diagnosis instead of a mystery.
- **Reclaim races.** Two processes can both observe a dead owner and both attempt reclaim. Step 4's "retry once, then stand down" resolves this: exactly one `wx` create succeeds. **Test this concurrently, not sequentially** — a sequential test cannot fail.
- **Mapped workspaces and custom DB paths.** `_redirectToParentIfMapped` (`:1165`) means several roots can share one DB, and `kanban.dbPath` can point anywhere. Keying the lock to the resolved DB path is what makes it correct; keying it to the workspace root would let two roots write one DB. Cover both configurations in tests.
- **`forWorkspace` is cached.** Acquisition must happen on first real open, not on every cache hit, or the lock is re-acquired per call. Equally, `resetInstance`/close paths (`:1418-1434`, `:2003-2047`) must not release a lock the process still needs.
- **The extension opens the DB before its server starts.** Several of the 136 sites run during activation. So lock acquisition must precede the earliest DB open in the extension's activation sequence, not sit inside `_startLocalApiServer`. Find the earliest open in `extension.ts` (11 sites) and place acquisition ahead of it.
- **The dispose-time sync flush** (`:1805-1815`) runs during teardown, when ownership may already have been released. Order teardown so the final flush happens **before** the lock is released, or a legitimate last write is refused by the very guard meant to protect it.
- **`BoardSnapshotPublisher` and the `kanban-board.md` mirror** are additional write paths. Confirm whether they route through `_persist` or write independently; an independent writer outside the gate is a hole.
- **Two servers is currently *possible*, so users may have live boards mid-clobber.** Nothing can recover already-lost data, but the release note should say plainly what the failure was and that it is now prevented.

## Dependencies

- **`switchboard-clients-send-api-auth-header.md`** — soft, for step 11 only. Deleting `move-card.js`'s DB fallback is safe once its HTTP path is authenticated under standalone. If this plan lands first, lock-gate the fallback instead of deleting it, and delete it when the client plan lands.

Otherwise independent. This plan supersedes the pre-existing-race note in `publish-agent-api-token-for-out-of-process-agents.md`.

## Verification Plan

1. `npm run compile` — 0 errors.
2. **The happy path, first and most important.** Single extension host, no contention: open VS Code on a workspace, exercise the board (create, move, delete, dispatch, feature grouping) and confirm the lock is acquired once, all writes persist, and nothing is read-only. Repeat for a single `npx switchboard`. A regression here is worse than the bug being fixed.
3. **The bug, reproduced then fixed.** Run `npx switchboard` on a folder, then open VS Code on the same folder. *Before* the change: confirm both servers run and that a card moved in one is destroyed by the other's next flush — capture the DB before and after to prove the data loss. *After*: the extension must not open the DB for writing, and the board must remain consistent under changes from both UIs.
4. `node --test src/test/kanban-single-writer-lock-contract.test.js` covering: exclusive acquisition; second acquirer refused; **concurrent** reclaim of a stale lock resolving to exactly one winner (spawn real processes, not sequential calls); a live owner never reclaimed; recycled-PID rejection via nonce and `/health` pid mismatch; every `export()` site refusing without ownership; read-only open taking no lock.
5. `npx switchboard` twice — the second still exits 1, and now names the owning host kind and pid.
6. Run `move-card.js`, `create-feature.js` and `get-state.js` against a live board: the writers go over HTTP and succeed; `get-state.js` reads with no lock; nothing writes a DB image.
7. `SIGKILL` a server, then start another — the stale lock is reclaimed cleanly with no manual cleanup. Repeat for `SIGTERM` and a clean `switchboard stop`, since `syncUnlinkPortFile` is a distinct path.
8. Confirm the read-only board reloads on the owner's flush (step 10) rather than showing a frozen snapshot.
9. Custom `kanban.dbPath` and a mapped parent/child workspace: two roots sharing one DB must contend for **one** lock.
10. Confirm the final dispose-time flush persists — mutate, immediately quit, reopen, and verify the change survived. This is the ordering trap in the audit.
11. `npm run standalone-parity:check` plus a hand diff of the two composition roots for the acquisition seam.

## Outstanding Questions

- **Step 8 vs step 9** is the one open call: should a losing extension **attach** to the owning server (one working board, more plumbing) or show a **read-only** board with a banner (simpler, worse UX)? Recommended: attach. Confirm before implementing, since it sets the shape of the extension-side work.
- Should the long-term fix be swapping sql.js for a driver with real multi-process locking? It would turn prevention into genuine safety. Out of scope here; worth its own plan once this lock is in place.
