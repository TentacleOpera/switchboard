# Hidden, Batched Terminal Creation with Mixed-Provider Allocation

## Goal

Let one call create N agent terminals split across several roles, and let those terminals be **hidden** — excluded from the terminals pane, from the sidebar fleet list, and (critically) from every role-based dispatch resolver — while remaining fully addressable by name for prompt delivery and kill.

### The problem

A planner that wants twenty improver workers today has exactly one option: twenty separate `ptyCreateTerminal` calls, each producing a terminal that renders in the pane grid and, worse, joins the pool that `_tryFleetDeliveryForRole` and autoban select from. Twenty hidden-intent workers become twenty visible dispatch targets, so the next kanban dispatch for that role can land a coding job inside an improver.

Two assumptions are baked into terminal creation, both correct for a human clicking in the UI and both wrong for agent-created workers:

1. **Everything created is rendered and selectable.** `PtyFleetService.updateRegistryState()` (`src/standalone/ptyFleetService.ts:320-348`) persists the whole fleet into `runtime.terminals`, and `ptyListTerminals` returns the whole fleet in one `terminals` array that the webview renders unfiltered (`src/webview/terminals.js:816` — `fleetList = data.terminals`) and that six extension call sites use for role-based target selection.
2. **One terminal at a time, one role at a time.** There is no notion of "give me N terminals split across these roles," so a batch is N round-trips with no all-or-nothing validation.

### Root cause

Terminal *visibility* and terminal *existence* are the same fact in this codebase. `ptyListTerminals` has exactly one output array, and every consumer — renderer, dispatch resolver, registry mirror, addressing lookup — reads it. There is no way to be live-and-addressable without also being renderable-and-selectable. The whole of this plan is introducing that distinction and then auditing every consumer against it.

### Why mixed providers matter

A role already determines the CLI, the auth, and therefore the bill: `GlobalIntegrationConfigService.getAgentStartupCommands()` is a `Record<role, command>`, and roles are user-extensible via `CustomAgentConfig` / `parseCustomAgents`. Splitting a batch across roles spreads the work across independent subscriptions and independent rate limits — which is also why this design needs no *token* concurrency cap. It still needs a *process* concurrency discipline, for a completely different reason (see Complex / Risky).

---

> **Superseded — "Nothing in `LocalApiServer.ts` creates a terminal … the capability is reachable only from the webview, so a planner agent cannot spin up workers."**
> **Reason:** False at HEAD, verified. `POST /terminals/verb/ptyCreateTerminal` is routed at `src/services/LocalApiServer.ts:3542-3544` and implemented by all three hosts — the pty-host child (`src/standalone/ptyHost.ts:69-85`), the standalone host (`src/standalone/bootstrap.ts:1184-1199`), and the extension proxy (`src/services/TaskViewerProvider.ts:2062-2083` → `_ptyHostVerb`). `PtyFleetService.create()` also injects `SWITCHBOARD_API_TOKEN` into every spawned shell's environment (`ptyFleetService.ts:155-160`) *precisely so* an agent inside a terminal can call this API back. An agent can already create a terminal over HTTP today.
> **Replaced with:** The gap is not creation. It is (a) hidden-ness and (b) batch allocation. Both are additive changes to the existing verb rail, which makes this plan smaller than it was and moves its centre of gravity from "add an endpoint" to "audit every consumer of the fleet list."

> **Superseded — "expose `POST /terminals/kill { name }` here alongside creation, since the planner cannot kill what it cannot address."**
> **Reason:** `ptyCloseTerminal` already exists and already does exactly this, in all three hosts (`ptyHost.ts:86-89`, `bootstrap.ts:1201-1204`, proxied at `TaskViewerProvider.ts:2097`). It resolves through `fleet.kill(payload.name)` → `this.terminals.get(name)`, the full map — so it will reach a hidden terminal with no change at all, provided hidden-ness is implemented as a *projection* filter and not by removing the handle from the fleet map.
> **Replaced with:** No kill endpoint is built. Instead, an explicit verification case asserts `ptyCloseTerminal` still resolves a hidden terminal by name.

> **Superseded — "Boot reconcile must reap hidden workers left behind by a crashed extension … hidden rows need the same treatment or they accumulate invisibly across restarts."**
> **Reason:** Already satisfied, provided the row keeps `ideName: PTY_IDE_NAME`. `PtyFleetService.purgePtyTerminals` (`ptyFleetService.ts:405-424`) deletes any row where `item.purpose === 'pty' **|| item.ideName === PTY_IDE_NAME**`, and `updateRegistryState`'s merge loop drops prior rows on the same two-part test (`ptyFleetService.ts:325-329`). The original plan read only the `purpose` half of both tests and therefore invented work that already exists.
> **Replaced with:** A guardrail rather than a feature: hidden rows MUST carry `ideName: PTY_IDE_NAME`. A verification case asserts hidden rows are reaped by the existing purge with no change to `purgePtyTerminals`.

> **Superseded — "Local unpushed work has added a **linkup** feature … **No trace of it exists in this branch**."**
> **Reason:** Linkup has landed in this branch. `src/webview/terminals.js` carries `btn-link-up` / `openLinkModal` / `syncLinkUpEnabled` (lines 574-575, 1451, 5242); `bootstrap.ts:1255-1288` implements the explicit-`clearBeforePrompt` precedence the link-relay plan specified; `PtyFleetService.create()` carries the `SWITCHBOARD_API_TOKEN` env injection that plan required; and `bootstrap.ts:1599` names the relay recipe directly. The source plan is `.switchboard/plans/feature_plan_20260808124500_terminal-pane-link-relay-message-to-another-terminal.md`.
> **Replaced with:** The reconcile step is answered, not deferred. Linkup mints **no** new terminal identity scheme — it addresses terminals by `friendlyName`, the identifier `ptySendPrompt`, `ptyCloseTerminal`, `fleet.get()` and `runtime.terminals` have always used. This plan adopts `friendlyName` and introduces nothing parallel.

> **Superseded — the `POST /terminals/create` REST endpoint shape.**
> **Reason:** pty operations are deliberately **not** REST routes and deliberately **not** in the verb catalog. `src/test/pty-route-surface-contract.test.js:70-87` asserts that no `pty*` verb leaks into `KANBAN_VERBS` or `protocol-catalog.json`, because `verb-returns:check` reconciles case-label counts against allowlist size and would trip. They are served by the dedicated `/terminals/verb/` route, which is why the link-relay plan could state "no new verb, no catalog regeneration, no `verbSchemas.ts` entry."
> **Replaced with:** One new verb, `ptyCreateBatch`, on the existing rail — plus a `hidden` field on `ptyCreateTerminal`. The new verb is added to `PTY_VERBS` in the contract test so the catalog-isolation assertions cover it.

## Metadata

**Complexity:** 6
**Tags:** backend, api, infrastructure, cli, reliability, feature
**Project:** Browser Switchboard

## User Review Required

None. Every open question is decided here: batch creation is a new verb on the existing `/terminals/verb/` rail (not a REST route), hidden-ness is a projection filter (not a fleet-map exclusion), creation is sequential (not concurrent), validation is all-or-nothing before the first spawn, and no kill endpoint is added because one already exists.

## Complexity Audit

### Routine

- The creation primitive, its three host implementations, its route, and its auth check all exist. This plan threads one boolean through them and adds one loop.
- `fleet.get(name)` / `fleet.kill(name)` read the full `terminals` map, so hidden terminals stay addressable for free — no change to `ptySendPrompt`, `ptyClearTerminal`, `ptyRenameTerminal` or `ptyCloseTerminal`.
- `purgePtyTerminals` and `updateRegistryState` already key on `ideName === PTY_IDE_NAME` as well as `purpose === 'pty'`, so hidden rows are reaped and re-merged correctly with no change (see the superseded callout above).
- The sibling-key projection shape is a **port, not an invention**: `ptyListTerminals` already returns a `liveness` sibling array for exactly this reason, and the comment at `ptyHost.ts:78-90` spells out the failure mode of the alternative (appending to `terminals`, where `fleetList = data.terminals` renders every entry as a permanent ghost row).
- `SYSTEM_ONLY_ROLES` (`GlobalIntegrationConfigService.ts:436`) is a one-line addition and already does what is wanted for the role picker.

### Complex / Risky

- **Hidden must mean "not selectable", not just "not drawn". This is the whole plan.** Six extension call sites resolve a dispatch target by matching `role` against `ptyListTerminals().terminals`:
  - `TaskViewerProvider.ts:973-983` — agentCompleted broadcast terminal-name resolution
  - `TaskViewerProvider.ts:8393-8402` — `_getAgentNameForRole` pty-fleet branch
  - `TaskViewerProvider.ts:13056-13066` — browser "send to terminal" (`apiOriginated`)
  - `TaskViewerProvider.ts:18978-18987` — `_tryFleetDeliveryForRole`, **the kanban dispatch path**
  - `TaskViewerProvider.ts:19026-19033` — the "is it a browser terminal?" warning branch
  - `TaskViewerProvider.ts:19101-19110` — `_dispatchExecuteMessage` name lookup
  Plus autoban, which selects from `_resolveAutobanEffectivePool(role, …)` (`TaskViewerProvider.ts:8739`). Ten hidden `planner`-role improvers would join the planner pool and start receiving board dispatches. A design that only hides rows from the webview ships this bug while every visual check passes.
- **Three implementations must move in lockstep.** `ptyCreateTerminal` exists three times — `ptyHost.ts:69`, `bootstrap.ts:1184`, and the extension proxy at `TaskViewerProvider.ts:2062`. `ptyListTerminals` exists three times as well, and the two full ones already differ (`bootstrap.ts:1206-1237` adds `parents`/`parentRoot` inline; the extension proxy adds them *after* the child returns, at `TaskViewerProvider.ts:2101-2110`). A `hidden` split applied to two of the three produces a host where hidden workers are visible — the PRD's two-layer completion rule (#7) in its most literal form.
- **Concurrent spawn is a correctness hazard, not just a perf one.** `injectStartupCommand` (`ptyFleetService.ts:222-238`) waits `SHELL_READINESS_DELAY_MS` (750 ms) and then **types** the startup command via `sendText`. Twenty shells racing that same typed-injection path is the single most likely source of a garbled or dropped startup command — the sibling `role-grid-fill-terminals.md` plan reaches the same conclusion independently for nine terminals. Twenty PTYs also consume file descriptors in a process that already holds the API server, the WS gateway and the database; the default macOS soft `ulimit -n` is low enough that this is worth measuring rather than assuming (see Uncertain Assumptions).
- **Partial failure must not be laundered into success.** A batch that creates 12 of 20 and reports `{success:true}` leads a planner to dispatch 20 plans at 12 workers. The convention at `LocalApiServer.ts:2102-2114` exists for exactly this.
- **Name generation is a silent-collision surface.** `create()` resolves collisions by counting up from `${role}-1` (`ptyFleetService.ts:141-146`). A batch that passes an explicit `name` for every worker will silently coalesce onto suffixed names; a batch that passes none gets `improver-claude-1 … -10`, which is what the caller wants. The batch verb must therefore **not** accept a per-worker `name`.
- **The PTY pool this batch draws from is system-wide and other applications leak into it.** macOS caps *total* pseudo-terminals across every process at `kern.tty.ptmx_max` — **511** by default on macOS 13-16, hard kernel ceiling 999. Claude Desktop and Gemini CLI both have documented master-FD leaks that exhaust exactly this pool (`anthropics/claude-code` #59839/#61358/#68439, `google-gemini/gemini-cli` #15945/#26327/#27628), and the symptom is that *every* app on the machine — Terminal, iTerm, VS Code — stops being able to open a terminal. A 32-PTY batch is therefore taking a visible bite out of a shared pool that may already be badly depleted by software Switchboard does not control. This is not a reason to shrink the cap; it is a reason the failure must be *reported accurately* rather than read as a Switchboard bug (see the error-classification change below).
- **Self-exited handles may retain their master FD, and hidden workers self-exit routinely.** `create()`'s `onExit` sets `handle.status = 'exited'` and leaves the handle in `this.terminals` — it never calls `handle.kill()` or disposes the pty (`ptyFleetService.ts:196-205`). Only `kill()` and `disposeAll()` invoke `handle.kill()`. Per node-pty's documented leak mechanism, a master handle not explicitly killed or destroyed keeps `/dev/ptmx` open in the parent even after the child dies. A batch worker whose agent CLI exits on its own is exactly this case, so 32 finished workers could hold 32 master FDs against the 511 system pool until the host process exits. **Verify with `lsof -p <ptyHost pid> | grep -c ptmx` before and after letting a worker exit on its own** — this is a pre-existing behaviour that batch scale makes matter, not a defect introduced by this plan.

### Resolved by research (2026-08-08)

- **`MAX_BATCH = 32` is safe and stays.** Each live PTY holds exactly **one** master FD in the parent; sequential creation adds only **2** transient pipe FDs at a time (the `spawn-helper` IPC pair). A 32-PTY batch on top of a realistic baseline (~20 FDs for stdio, libuv, SQLite's three handles, and the listening sockets) puts the host around **54 FDs + active connections** — an order of magnitude under even the worst default soft limit.
- **The relevant soft limit is 256, not 1024, and Node will not raise it for you.** macOS processes launched by `launchd` (which includes the VS Code extension host, and therefore the pty-host child it forks) inherit `RLIMIT_NOFILE` soft = **256**; a shell-launched `npx switchboard` gets 256 or 1024. Node.js — unlike Go 1.19+ and Bun — does **not** auto-bump the soft limit to the hard limit at startup. At 256 the PTY ceiling is roughly 200-220, so 32 is comfortable, but a batch cap above ~150 would need an explicit `setrlimit` via a native addon. Do not raise `MAX_BATCH` without doing that first.
- **Sequential creation is confirmed correct, and costs ~24 seconds.** Concurrent spawn is documented as unreliable for exactly the reason this plan assumed: shells reset line discipline (`termios`) during startup, so writes issued before readiness are wiped, and 32 simultaneous forks additionally cause CPU and I/O contention. The 750 ms delay already in `injectStartupCommand` matches the recommended 500-750 ms minimum. The consequence is a **~24 s** wall-clock batch for 32 workers (32 × 0.75 s) — the caller must be told this is not an instant operation, and the HTTP response must not be expected inside a short timeout.
- **The teardown design already matches best practice.** The documented `SIGABRT` risk is node-pty issue #904: a native `ThreadSafeFunction` calling into a V8 isolate that is already tearing down. The mitigation is explicitly killing every PTY and awaiting exit before process exit — which is what `disposeAll()`'s SIGTERM → grace → SIGKILL does, with the synchronous `exit` reaper as last resort. No change; larger fleets simply widen the exposure window, which is one more reason not to raise the cap.
- **Host RAM, not FDs, is the real ceiling.** The parent-side cost of 32 PTYs is under ~10 MB (≈15 KB native + ≈100 KB V8 + ≈64 KB kernel ring buffers each). The **child** CLI processes cost **5-50+ MB RSS each** — so a 32-worker batch of agent CLIs is **160 MB to 1.6 GB** of host memory. State this in the batch verb's documentation; it is the number that will actually bite a user, and it is invisible from every metric this codebase currently exposes.

## Edge-Case & Dependency Audit

**Race Conditions**
- `updateRegistryState` serialises through `_registryWrite` (`ptyFleetService.ts:322-347`), so a burst of creations cannot interleave read-modify-write cycles. Sequential creation makes this moot anyway, but do not remove the serialisation.
- A hidden terminal that self-exits mid-batch fires `onExit` → `updateRegistryState` → `{type:'closed'}`, and the `recentlyClosed` tombstone path is unchanged. Hidden terminals must appear in `getLiveness()` exactly as they do today — the activity-light sweep must not be blinded by hidden-ness.
- Two batches requested concurrently for the same role will interleave in the name counter. That is correct behaviour (both get distinct names); no lock is needed.

**Security**
- `_handleTerminalVerb` gates on `_checkAuth(req, true)` (`LocalApiServer.ts:1687-1691`). No change. Under standalone the session token is required; under the extension host `getAuthToken()` is effectively empty and loopback trust applies (`LocalApiServer.ts:545-548, 578-580`). Batch creation inherits this unchanged — it must not add its own bypass.
- The batch verb spawns processes. Cap the total per call (see Proposed Changes) so a malformed allocation cannot fork-bomb the host.
- Role strings arrive over HTTP and are used as map keys and in generated names. They must be validated against the known role set before use, never interpolated into a shell string.

**Side Effects**
- `_ptyTerminalNames` feeds `getRegisteredTerminals` (`TaskViewerProvider.ts:2128-2143`), which is `/kanban/dispatch`'s "is any terminal live?" pre-flight. Hidden workers must **not** enter it, or a dispatch that should 409 will instead pass and then fail to find a target.
- `updateMirrorRegistry` (`TaskViewerProvider.ts:2021-2048`) rewrites `runtime.terminals` from the child's `terminals` array. It must be taught to mirror hidden rows too (stamped `hidden: true`), or hidden workers vanish from `/health` and from the boot reap.
- `sanitizePaneAssignments` / `checkSoloNotFound` / `renderSidebarList` in the webview all key off `fleetList`. Excluding hidden from `data.terminals` means none of them need to change — that is the point of the projection design.

**Dependencies & Conflicts**
- `src/standalone/ptyFleetService.ts`, `src/standalone/ptyHost.ts`, `src/standalone/bootstrap.ts`, `src/services/TaskViewerProvider.ts`, `src/services/GlobalIntegrationConfigService.ts`, `src/test/pty-route-surface-contract.test.js`.
- **No** change to `src/webview/terminals.js` or `terminals.html`. If a change there turns out to be required, the projection design has been implemented wrongly.
- **No** `verbSchemas.ts` entry, **no** `protocol-catalog.json` regeneration, **no** allowlist change — pty verbs are excluded from all three by contract.
- Unreleased dev work on the PTY fleet; no shipped on-disk state changes shape. The `hidden` key is additive to `runtime.terminals` rows and older readers ignore unknown keys.
- Conflicts with `role-grid-fill-terminals.md` only at the level of intent (visible grid vs hidden fleet). They touch different files and can both land; see that plan's own framing.

## Dependencies

None — ships standalone. The parallel planner lane (`plan-update-notifies-planner.md`) consumes the workers this creates, and `improver-prompt-and-planner-lifecycle.md` governs what those workers do.

## Adversarial Synthesis

**Risk Summary.** The dominant risk is a hidden terminal that is invisible but still *selectable*: six role-matching call sites plus autoban's pool resolver read the same `terminals` array the webview renders, so a hide implemented only in the UI ships a fleet of decoys that quietly absorb board dispatches while every screenshot looks right. Second is host drift — `ptyCreateTerminal` and `ptyListTerminals` each exist three times and the two full `ptyListTerminals` implementations already diverge, so a two-of-three change produces a host where hidden means nothing. Third is the typed startup-command injection: 750 ms of `sendText` per shell, raced twenty ways, is the most likely source of workers that launch with no agent in them. Mitigations: implement hidden-ness as a sibling-key projection (the proven `liveness` shape) so the default array every consumer already reads is the *safe* one; change all three hosts in one commit with a per-host assertion; create sequentially and report partial failure explicitly.

## Proposed Changes

### `src/standalone/ptyFleetService.ts`

**Context.** `create()` at line 140 takes four positional args and builds `ExtendedTerminalHandle`; `updateRegistryState()` at 320 projects the fleet into `runtime.terminals`.

**Logic.** Add a fifth optional options argument rather than a fifth positional flag — the signature is already at its readable limit.

```ts
export interface CreateOptions { hidden?: boolean }

public async create(
    role: string,
    friendlyName?: string,
    cwd?: string,
    worktreePath?: string,
    opts?: CreateOptions
): Promise<ExtendedTerminalHandle>
```

- `ExtendedTerminalHandle` and `FleetTerminalInfo` gain `hidden?: boolean`.
- `updateRegistryState` writes `hidden: t.hidden === true` alongside the existing fields. **`ideName` stays `PTY_IDE_NAME` and `purpose` stays `'pty'`** — changing either breaks the merge/purge tests documented in the superseded callout above, and both are load-bearing.
- `getLiveness()` is unchanged: hidden terminals report liveness like any other.

**Edge cases.** A hidden terminal that is `rename()`d keeps its `hidden` flag (the handle is mutated in place, not rebuilt). `disposeAll()` and the `exit` reaper are role- and visibility-blind and need no change.

### `src/standalone/ptyHost.ts` and `src/standalone/bootstrap.ts`

**Context.** Both implement `ptyCreateTerminal` and `ptyListTerminals`; `bootstrap.ts`'s list arm additionally resolves `parents`/`parentRoot`.

**Logic — `ptyCreateTerminal`.** Pass `{ hidden: payload.hidden === true }` through to `create()`. Echo `hidden` in the returned terminal projection.

**Logic — `ptyListTerminals`.** Split the projection:

```ts
const all = fleet.list();
return {
    success: true,
    terminals: project(all.filter(t => !t.hidden)),   // unchanged shape, unchanged consumers
    hiddenTerminals: project(all.filter(t => t.hidden)),
    liveness: fleet.getLiveness(),
};
```

The `terminals` key keeps its exact current meaning. This is the same decision, for the same reason, as the `liveness` sibling key — see the comment at `ptyHost.ts:78-90` and mirror it here.

**Logic — new verb `ptyCreateBatch`.** Payload:

```jsonc
{
  "allocation": [ { "role": "improver-claude", "count": 10 },
                  { "role": "improver-devin",  "count": 10 } ],
  "hidden": true,
  "cwd": "/repo",
  "worktreePath": null
}
```

Behaviour, in order:

1. **Validate everything before spawning anything.** Reject with `{success:false, error}` if: `allocation` is absent/empty/not an array; any `count` is not a positive integer; the summed count exceeds `MAX_BATCH` (see below); any `role` has no configured startup command in `getAgentStartupCommands()`. Zero terminals are created on any of these paths.
2. **Create sequentially**, awaiting each `create()` — which already awaits `injectStartupCommand`'s readiness delay — before starting the next.
3. **Report honestly, and classify the failure.** Return `{ success: true, created: [...], failed: [{ role, reason, kind }] }` where `created` carries `{ friendlyName, role, hidden }` per worker. If `failed` is non-empty the caller sees it; there is no path that returns a bare `{success:true}` while workers failed. If *every* worker failed, return `success: false`.

   `pty.spawn()` throws **synchronously**, and the thrown message distinguishes resource exhaustion from a bad launch — a distinction the caller cannot otherwise make and will otherwise mis-attribute. Classify on the message:

   | Message contains | `kind` | Meaning to surface |
   | :--- | :--- | :--- |
   | `posix_openpt failed: Device not configured` (macOS, `ENXIO`/`ENOENT`) | `pty-pool-exhausted` | The **machine's** system-wide PTY pool (`kern.tty.ptmx_max`, default 511) is full — often because another app is leaking. Not a Switchboard fault; tell the user to check `sysctl kern.tty.ptmx_max` and `lsof /dev/ptmx \| wc -l` |
   | `posix_openpt failed: No space left on device` (Linux, `ENOSPC`) | `pty-pool-exhausted` | Same, against `/proc/sys/kernel/pty/max` (default 4096) |
   | `posix_openpt failed: Too many open files` (`EMFILE`) | `fd-limit` | **This process** hit its `RLIMIT_NOFILE` soft limit (256 under `launchd`). Raise the limit or lower the batch |
   | `posix_openpt failed: File table overflow` (`ENFILE`) | `fd-limit` | Kernel global file table full |
   | `posix_spawnp failed …` / `spawn-helper ENOENT` | `spawn-failed` | The PTY allocated fine; the **role's startup command or cwd** is wrong. A Switchboard/config fault |
   | anything else | `unknown` | Pass the message through verbatim |

   The split matters because the two classes call for opposite responses: `pty-pool-exhausted` and `fd-limit` mean *stop and shrink the batch*, `spawn-failed` means *fix the role config*. A batch that reports both as one opaque string sends the user to debug the wrong layer. On the **first** `pty-pool-exhausted` or `fd-limit`, abort the remaining allocation immediately rather than grinding out 20 more identical failures.
4. **No per-worker `name`.** Names come from `create()`'s `${role}-N` generator so pool membership and collision handling stay identical to the single-add path.
5. **Document the cost in the verb's response.** Include `estimatedDurationMs` (`count × SHELL_READINESS_DELAY_MS`) so a caller knows a 32-worker batch is a ~24-second operation, not an instant one.

`MAX_BATCH` is a constant in `ptyFleetService.ts` (start at 32) — a fork-bomb guard, not a rate limit. Exceeding it is a validation error naming the cap, never a silent truncation.

**Edge cases.** A partial batch leaves its already-created workers alive and named in `created[]` — the caller can kill them. Do not auto-roll-back: killing shells the caller may already have addressed is worse than reporting the truth.

### `src/services/TaskViewerProvider.ts`

**Context.** The proxy at 2054-2113, the mirror at 2021-2048, the registered-names callback at 2128-2143, and the six role-matching call sites listed in the Complexity Audit.

**Logic.**
- Proxy: forward `hidden` on `ptyCreateTerminal`; add `ptyCreateBatch` to the `['ptyCreateTerminal','ptyCloseTerminal','ptyRenameTerminal']` list that triggers `updateMirrorRegistry` (a batch changes the registry exactly as a create does).
- `ptyListTerminals` post-processing: apply the existing `parents`/`parentRoot` enrichment to **both** `terminals` and `hiddenTerminals` so a hidden worker in a worktree still resolves its parent root.
- `updateMirrorRegistry`: mirror `[...terminals, ...hiddenTerminals]`, stamping `hidden: true` on the latter. Without this, hidden workers are absent from `runtime.terminals`, `/health` and the boot reap.
- `_ptyTerminalNames`: populate from `terminals` **only**. This is what keeps hidden workers out of `getRegisteredTerminals` and therefore out of `/kanban/dispatch`'s pre-flight.
- The six role-matching sites: no code change is required *if and only if* they continue to read `res.terminals`. Add a one-line comment at `_tryFleetDeliveryForRole` (18978) recording that `terminals` excludes hidden by contract, so a future author does not "helpfully" concatenate `hiddenTerminals` in.
- `_resolveAutobanEffectivePool`: audit its source. If it reads `runtime.terminals` rather than the verb, it must filter `entry.hidden !== true` explicitly — the registry mirror *does* contain hidden rows by design.

### `src/services/GlobalIntegrationConfigService.ts`

**Context.** `SYSTEM_ONLY_ROLES` at 436; `getPtyVisibleRoles` at 443.

**Logic.**
- Add batch-only improver roles to `SYSTEM_ONLY_ROLES` so they never appear in the role picker or the OPEN AGENT TERMINALS path. Note explicitly in the comment block that this gates the **picker only** — it does not hide a running terminal, which is what the `hidden` flag is for. The original plan conflated the two.
- Add a workspace-level default allocation setting (`batchAllocation`, shape `Array<{role, count}>`, default `[]`) read by callers that want "the usual mix" without restating it. An empty default means the batch verb always requires an explicit `allocation` until the user configures one — no implicit spawning.

### `src/test/pty-route-surface-contract.test.js`

Add `'ptyCreateBatch'` to `PTY_VERBS` (line 26-29) so the catalog- and allowlist-isolation assertions cover the new verb.

## Verification Plan

### Automated Tests

1. **Allocation.** `[{role:A,count:10},{role:B,count:10}]` creates 20 terminals, 10 per role, each carrying its own role's startup command.
2. **Validation precedes creation.** An allocation containing one role with no configured startup command returns `success:false` and creates **zero** terminals. Same for a non-integer count, an empty allocation, and a sum over `MAX_BATCH`.
3. **Sequential creation.** Assert `create()` calls do not overlap (instrument `injectStartupCommand` entry/exit) for a batch of 5.
4. **Hidden is not listed.** `ptyListTerminals` returns hidden workers in `hiddenTerminals` and **not** in `terminals`, in all three host implementations. Assert visible terminals created the normal way are unaffected and that the `terminals` projection is byte-identical to today's for an all-visible fleet.
5. **Hidden is not selectable.** With 3 hidden `planner`-role workers and zero visible ones, assert `_tryFleetDeliveryForRole('planner', …)` returns false and `getRegisteredTerminals()` omits them — i.e. `/kanban/dispatch` still 409s "no live terminal".
6. **Hidden is still addressable.** A hidden terminal can be found by `fleet.get(name)`, receives a prompt via `ptySendPrompt`, and is killed via `ptyCloseTerminal` — with no change to those arms.
7. **Registry mirror.** Hidden rows reach `runtime.terminals` with `hidden:true`, `purpose:'pty'`, `ideName:PTY_IDE_NAME`.
8. **Boot reap (no new code).** Persist hidden rows from a prior run; assert the **unmodified** `purgePtyTerminals` drops them and starts no replacements.
9. **Liveness unaffected.** A hidden terminal appears in `getLiveness()` and its tombstone is recorded on kill, exactly as a visible one.
10. **Role picker.** Batch-only roles added to `SYSTEM_ONLY_ROLES` are absent from `getPtyVisibleRoles().visibleAgents`.
11. **Partial failure.** A mixed allocation where one role fails mid-batch returns `created` plus a populated `failed[]`; assert no path returns `success:true` with a non-empty `failed[]` and no other signal, and that an all-failed batch returns `success:false`.
12. **Route-surface contract.** `pty-route-surface-contract.test.js` passes with `ptyCreateBatch` added — no catalog entry, no allowlist entry, reachable on `/terminals/verb/`.

13. **Error classification.** Force each failure class and assert `kind`: an unset/bad startup command → `spawn-failed`; a batch run with the process soft limit lowered (`ulimit -n 64`) → `fd-limit`; and — where reproducible — a machine near `kern.tty.ptmx_max` → `pty-pool-exhausted`. Assert the first `fd-limit`/`pty-pool-exhausted` aborts the remaining allocation instead of retrying per worker.
14. **FD accounting.** Record `lsof -p <host pid> | grep -c ptmx` before a batch, after creation, after killing every worker via `ptyCloseTerminal`, and after letting one worker's CLI exit **on its own**. The first three should return to baseline. The fourth is the open question in the Complex / Risky section — if the count does not drop, the self-exit path needs an explicit dispose, and that is a pre-existing leak worth its own fix.

### Manual (VSIX)

15. Create a 6-terminal batch split across two provider roles with `hidden:true`. Confirm: nothing new appears in the terminals sidebar or pane grid; `/health` **does** list them (they are real); a board dispatch for that role still reports no live terminal; `ptySendPrompt` to one by name lands; `ptyCloseTerminal` removes it. Then restart and confirm the boot reap cleared any survivors.
16. Run a 32-worker batch and time it. Confirm it completes in roughly 24 s, that no HTTP timeout fires, and note the host's RAM delta — expect 160 MB-1.6 GB depending on the agent CLIs involved.

## Resolved Assumptions

Both previously-flagged uncertainties were researched and are now settled; do **not** re-open them.

- **`node-pty` fleet ceiling.** One master FD per live PTY in the parent, plus 2 transient pipe FDs per in-flight spawn. Binding limits: `RLIMIT_NOFILE` soft = **256** under macOS `launchd` (Node does not auto-raise it), then `kern.tty.ptmx_max` = **511** system-wide on macOS (hard cap 999); on Linux, soft = **1024** under systemd, then `/proc/sys/kernel/pty/max` = **4096**. `MAX_BATCH = 32` is safe with wide margin and is retained. A cap above ~150 would require an explicit `setrlimit` through a native addon first.
- **N-API teardown instability at fleet scale.** The `SIGABRT` risk is node-pty issue #904 — a `ThreadSafeFunction` calling into a V8 isolate already in teardown. The documented mitigation (explicitly kill every PTY and await exit before process exit) is already what `disposeAll()` implements. No change required; larger fleets only widen the window.
- Two hazards the research surfaced that were *not* previously flagged are recorded in Complex / Risky above: the system-wide PTY pool being drained by other applications' documented leaks, and the possible master-FD retention on the self-exit path.

## Recommendation

Complexity 6 → **Send to Coder.**
