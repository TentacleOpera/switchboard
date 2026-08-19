# The API server port file goes missing from eligible workspace roots and never comes back

## Goal

`.switchboard/api-server-port.txt` is the documented discovery path that every dispatched agent is told to read in order to reach the LocalApiServer. On this machine it is **absent from the Switchboard repo root while the server is live and serving that root**, and the 30-second watchdog that exists to repair exactly this never fires. Make the port file's presence in every eligible root a maintained invariant rather than a one-shot side effect of server start: write it on workspace-folder change as well as on start, have the watchdog verify and repair **per root** instead of accepting any one root as proof of health, and stop one host's shutdown from deleting a file another host's live server still depends on.

### Problem analysis and root cause

Observed live, 2026-08-19, extension host = Devin (PID 2514), server listening on 49703:

```
GET /health -> {"status":"ok","port":49703,"roots":[
  "/Users/patrickvuleta/Documents/Gitlab",
  "/Users/patrickvuleta/Documents/GitHub/switchboard",
  "/Users/patrickvuleta/Documents/Gitlab/analytics-dashboard",
  "/Users/patrickvuleta/Documents/GitHub/pixel-spritesheet-studio"]}
```

| root | `.switchboard/` | `api-server-port.txt` | `workspace-id` |
|---|---|---|---|
| `Documents/Gitlab` | yes | **49703** | yes |
| `Documents/GitHub/switchboard` | yes | **MISSING** | yes |
| `Documents/Gitlab/analytics-dashboard` | yes | **49703** | yes |
| `Documents/GitHub/pixel-spritesheet-studio` | no (not eligible) | — | — |

Three of four roots are eligible. Two carry the correct current port. The one that does not is the repo every agent in this workspace actually runs in. `workspaceDatabaseMappings` is `{enabled: false, mappings: []}`, so `_filterMappedRoots` and `_validateNoSwitchboardPollution` both no-op — neither the mapped-child filter nor the pollution deleter is involved, and the surviving `workspace-id` in that root independently rules out the pollution deleter (it removes both files together).

Three defects compose, all in `src/services/TaskViewerProvider.ts`.

**A. The write is one-shot at server start; nothing re-runs it.**
`_startLocalApiServer` (`:3583-3600`) writes the port file to `_filterPortFileEligibleRoots(allRoots)` once, immediately after `start()` resolves, where `allRoots` was captured at `:2648`. `TaskViewerProvider` has **no `onDidChangeWorkspaceFolders` subscription** — `DesignPanelProvider`, `PlanningPanelProvider`, `GlobalPlanWatcherService` and `KanbanProvider` all subscribe, the owner of the port file does not. A root added to the window after the server started therefore never receives a port file, and no later event produces one.

**B. The watchdog's existence check is OR across roots, so it can never see a per-root gap.**
`_checkApiServerLiveness` (`:3634-3660`):

```ts
let portFileExists = eligibleRoots.length === 0;
for (const root of eligibleRoots) {
    const portFilePath = path.join(root, '.switchboard', 'api-server-port.txt');
    if (fs.existsSync(portFilePath)) { portFileExists = true; break; }   // <-- ANY root satisfies it
}
if (serverAlive && portFileExists) return; // healthy
```

One root holding the file marks the whole fleet healthy. With `Documents/Gitlab` and `analytics-dashboard` holding `49703`, the watchdog has reported healthy every 30 seconds for the entire session while the Switchboard root has had nothing. **This is the defect that turns any transient loss into a permanent one** — whatever removed or skipped the file, a per-root check would have rewritten it within 30 seconds.

**C. Stop unlinks from every root; start writes only to eligible roots — and neither is scoped to the instance that owns the file.**
`_stopLocalApiServer` (`:3672-3683`) unlinks `api-server-port.txt` from every `_filterMappedRoots(this._getWorkspaceRoots())` root unconditionally, with no check that the file belongs to *this* server. Two Switchboard hosts are running on this machine (Devin PID 2514, Antigravity PID 3710 — the latter answers on 50109 but not with a Switchboard catalog, i.e. its API server is not currently up). A second host that shares a root and stops its server deletes the port file out from under the first host's live server. The lifecycle is asymmetric by construction: **any** host's stop deletes, only that host's own start rewrites — and per defect B, the surviving host's watchdog never notices.

A and C are two different ways the file goes missing. B is why it stays missing. Fixing B alone makes the system self-healing regardless of which of the other two caused a given instance; fixing all three removes the cause as well as the symptom.

### Blast radius — this is the documented contract, not an incidental file

The path is named as *the* discovery mechanism in agent-facing prompt text throughout the codebase: the reviewer delegation step (`agentPromptBuilder.ts:1824`), the researcher hand-off (`agentPromptBuilder.ts:965`), `teamWiring.ts:57`, `:80`, `:365`, `:400`, `:409`, `:419`, `schedulerPresets.ts:18`, `PlanIngestionEngine.ts:1488`, `agentGroupInstantiation.ts:232`, `linkPresets.ts:117`, and the memo/feature-creation prompt at `TaskViewerProvider.ts:6240`. An agent that follows its own instructions in this repo reads a missing file and concludes the extension is not running.

Only one of those call sites documents a fallback — the researcher hand-off explicitly says "if the file is missing, skip the POST and fall back to the chat-summary prompt". The rest, including every delegation and team-report path, state the read as though it always succeeds. This was hit for real in this session: a reviewer agent instructed to delegate fixes to a coder terminal read the missing file, correctly concluded it had no route, and stopped — while the server was live the whole time on 49703 and reachable the moment the port was found another way.

## Metadata

**Tags:** backend, reliability, bugfix, api
**Complexity:** 4

## User Review Required

None. Each defect has one defensible resolution and none of them is a preference call: a per-root invariant must be checked per root; a file must be rewritten when the set of roots changes; and a shutdown must not delete a file that names a port it does not own. No new settings, no new modes, no UI.

## Complexity Audit

### Routine
- Extracting the existing write loop into one `_writePortFilesToEligibleRoots()` helper — the loop body already exists verbatim at `:3590-3599`; three callers replace one inline copy.
- Subscribing `TaskViewerProvider` to `onDidChangeWorkspaceFolders` and calling that helper — the pattern is already used by four sibling providers.

### Complex / Risky
- **Changing the watchdog from OR to per-root must not create a restart storm.** Today a falsy `portFileExists` triggers a full `stop()` + `_startLocalApiServer()`. If the check becomes per-root while the remediation stays "restart the server", a single unwritable root would restart the server every 30 seconds forever. The two concerns must be separated: a **dead server** restarts; **missing port files under a live server** are rewritten in place, with no restart and no `stop()`. Getting this backwards converts a silent missing-file bug into a loud server-thrash bug, which is strictly worse (cf. the extension-host refresh-storm failure mode).
- **Scoping the stop-path unlink to this instance's own file.** The guard is to read the file and unlink only when its contents equal this server's port. That is correct for the shared-root case and is a no-op for the single-host case. The failure mode if got wrong is a stale port file outliving its server, which sends agents at a dead port — a different and quieter failure than the current one, so the read must be defensive (unreadable/garbage contents → unlink, matching today's behaviour).
- **The write is `writeFile(.tmp)` + `rename`, and the `.tmp` has its own cleanup path.** `LocalApiServer.ts:654` sweeps `api-server-port.txt.tmp`. Adding two more callers of the write increases the rate of tmp-file creation; the rename is atomic so this is safe, but the new callers must reuse the same tmp+rename shape rather than a bare `writeFile`, or a reader can observe a truncated port.

## Edge-Case & Dependency Audit

**Race conditions** — the watchdog (30s interval) and the folder-change handler can both call the write helper concurrently. The tmp+rename shape makes each write atomic, and both write identical content, so interleaving is benign. The tmp path must stay per-root (it already is: `portFilePath + '.tmp'`), or two roots would contend on one temp name.

**Stop vs watchdog async race** — `_checkApiServerLiveness` is invoked via `void this._checkApiServerLiveness()` (`:3628`), making it fire-and-forget async. `_stopLocalApiServer` clears the interval timer (`:3669-3671`) but cannot cancel an in-flight tick already `await`-ing a write. Sequence: watchdog tick fires → detects missing files → begins `_writePortFilesToEligibleRoots` (awaiting rename) → `_stopLocalApiServer` is called → clears timer → unlinks files → `this._localApiServer.stop()` → watchdog's rename completes → **file re-created pointing to a now-dead port.** The plan's faster write path (rewrite without restart) makes this window more likely to hit than today's full-restart path. Mitigation: the write helper (or each call site) must re-check `this._localApiServer?.isListening()` immediately before the rename, bailing out if the server is no longer live. This same guard also protects the folder-change handler from writing during a restart window.

**Multi-host** — two Switchboard hosts sharing a root is the observed configuration on this machine, not a hypothetical. Both write the same filename with *different* ports. Last writer wins, and that is acceptable: either port reaches a live server. What is not acceptable is today's behaviour where one host's shutdown leaves the shared root with no port at all. Scoping the unlink to a matching port is what fixes that; it deliberately does not attempt to arbitrate which host "owns" a shared root, because both are legitimately serving it.

**Never create `.switchboard/`** — `_filterPortFileEligibleRoots` exists precisely so the port writer cannot convert an unrelated open repo into a managed workspace. Every new call path must go through it. This is the scaffold-litter guard and must not be bypassed for convenience in the folder-change handler, where a freshly added unrelated folder is exactly the risk.

**Migration** — none needed, and none should be written. The port file is ephemeral runtime state, regenerated on every server start, and is git-ignored (`.gitignore:52`, `.switchboard/*`). It is not user data and has no on-disk format to migrate. A stale file from a previous session is already handled by being overwritten on start.

**Not in scope** — the agent-facing prompt text that reads the file. Making ~12 call sites fall back gracefully is a separate concern and the wrong layer to fix this at: the contract should hold, not be worked around. If it is later decided that delegation prompts need a documented fallback, that is its own card. Additionally, `agentGroupInstantiation.ts:232` tells agents to try `.switchboard/api-port` as a fallback filename, but no such file is ever written anywhere in the codebase — this is a pre-existing dead reference, not something this plan introduces or needs to fix.

## Dependencies

- None. `_filterPortFileEligibleRoots`, `_filterMappedRoots`, the watchdog and the diagnostics channel all already exist.

## Adversarial Synthesis

Key risks: (1) turning a silent bug into a restart storm by conflating "dead server" with "missing files" in the watchdog — mitigated by splitting the two failure paths; (2) a stop-vs-watchdog async race where a fire-and-forget watchdog tick completes a write after `_stopLocalApiServer` has unlinked and stopped — mitigated by a liveness re-check inside the write helper before the rename; (3) the folder-change handler writing garbage during a restart window — mitigated by the same liveness guard; (4) bypassing the eligibility filter in the folder-change handler — mitigated by routing every path through `_filterPortFileEligibleRoots`. The three-defect fix is the correct scope; fixing B alone would self-heal but leave 30-second windows on folder adds and cross-host stops.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — one write helper, three callers

Extract the existing loop at `:3590-3599` unchanged (tmp + rename, per-root try/catch, warning to `_apiServerDiagnosticsChannel`):

```ts
/** Write the current port to every eligible root. Idempotent; safe to call repeatedly.
 *  NEVER mkdir .switchboard/ — eligibility is the scaffold-litter guard.
 *  Liveness guard: re-check this._localApiServer?.isListening() immediately before
 *  the rename. A fire-and-forget watchdog tick or a folder-change handler can be
 *  mid-await when _stopLocalApiServer fires — without this guard, the rename
 *  completes after stop, re-creating a file that points at a dead port. */
private async _writePortFilesToEligibleRoots(port: number): Promise<void> {
    if (!this._localApiServer || !this._localApiServer.isListening()) return;
    /* moved body: for each eligible root, writeFile(.tmp) + rename, per-root try/catch */
}
```

Called from `_startLocalApiServer` (replacing the inline loop), from the watchdog's repair branch, and from the new folder-change handler. The liveness guard inside the helper protects all three callers from the stop-vs-watchdog async race and from writing during a restart window.

### 2. `src/services/TaskViewerProvider.ts` — watchdog checks per root and repairs without restarting

Replace the OR loop at `:3641-3648`. Separate the two failure modes:

```ts
const serverAlive = !!this._localApiServer && this._localApiServer.isListening();

if (!serverAlive) {
    // unchanged: stop any half-dead instance and restart
}

// Server is alive. A missing port file is a file problem, not a server problem —
// rewrite it in place. Restarting here would thrash the server every interval
// for as long as any one root stays unwritable.
const missing = eligibleRoots.filter(r => !fs.existsSync(path.join(r, '.switchboard', 'api-server-port.txt')));
if (missing.length > 0) {
    this._apiServerDiagnosticsChannel.appendLine(
        `[TaskViewerProvider] API server watchdog: port file missing in ${missing.length} eligible root(s); rewriting: ${missing.join(', ')}`
    );
    await this._writePortFilesToEligibleRoots(this._localApiServer!.getPort());
}
```

The empty-eligible-roots case stays satisfied (`missing.length === 0`), preserving today's guard against restarting a healthy server in a window with no eligible root.

### 3. `src/services/TaskViewerProvider.ts` — rewrite on workspace-folder change

Subscribe to `vscode.workspace.onDidChangeWorkspaceFolders` alongside the sibling providers (`DesignPanelProvider`, `PlanningPanelProvider`, `GlobalPlanWatcherService`, `KanbanProvider` — all already subscribe). Register the subscription in the same disposables list used by the other providers in `TaskViewerProvider`'s activate/register path. On change, call `_writePortFilesToEligibleRoots(this._localApiServer!.getPort())` — but only when `this._localApiServer?.isListening()` is true. The liveness guard inside the helper (see change #1) is the second line of defense, but the call site should skip the call entirely when the server is not live to avoid passing a stale or zero port. No restart, no `stop()`.

### 4. `src/services/TaskViewerProvider.ts` — stop unlinks only its own port file

At `:3675-3679`, guard the unlink on contents. **Capture the port before any stop/unlink sequence** — `const myPort = this._localApiServer.getPort()` must be called while `_localApiServer` is still non-null (it is, per the `:3673` guard), because a future refactor that moves `stop()` before the cleanup loop would silently make `getPort()` return 0 and the contents check would never match:

```ts
// Only remove a port file that names THIS server. Two hosts can legitimately share
// a root (observed: Devin + Antigravity); an unconditional unlink deletes the file a
// still-live server depends on. Unreadable/garbage contents → unlink (today's behaviour).
const myPort = this._localApiServer.getPort();
```

For each root in `_filterMappedRoots(this._getWorkspaceRoots())` (note: the stop path uses `_filterMappedRoots`, not `_filterPortFileEligibleRoots` — roots without `.switchboard/` are naturally excluded because the `readFile` will throw ENOENT): read the file, compare to `myPort`, unlink on match or on unreadable/unparseable contents (ENOENT, EACCES, garbage, wrong format), leave a foreign port in place. The `unlink().catch(() => {})` pattern is preserved for safety.

## Verification Plan

### Automated
- **New:** `src/test/api-server-port-file-contract.test.js`, run by a new `test:contract:api-server-port-file` script, **wired into `.github/workflows/integration-tests.yml` in the same commit** — a check defined but not invoked is the "green while incomplete" hole this repo's own reviewer prompt hunts for. Behavioural, against temp-directory fixtures, asserting:
  - all eligible roots receive the file, and a root without `.switchboard/` receives nothing and has no directory created;
  - with a live server and the file deleted from **one of several** eligible roots, a watchdog tick rewrites that root and does **not** call `stop()` — this fails on current code, where the surviving files short-circuit the check;
  - with the server dead, a tick still restarts (regression guard on the split);
  - stop unlinks a file whose contents match this port, leaves one naming a different port, and unlinks an unreadable one;
  - adding an eligible root after start produces a port file without a server restart;
  - **liveness guard:** when `_localApiServer` is null or not listening, `_writePortFilesToEligibleRoots` is a no-op — no file is written, no port `0` is emitted;
  - **stop-vs-watchdog race:** when `_stopLocalApiServer` is called while a watchdog write is in-flight (simulated by awaiting the write helper's `writeFile` but calling stop before the `rename`), the rename is skipped (liveness guard fires) and no file re-appears after stop.
- `npm run test:contract:seat-safeguards`, `npm run test:contract:orchestrator-tick` — both exercise dispatch paths that name the port file. Establish their pre-existing pass/fail counts **before** starting; `seat-safeguards` has been observed at 95 passed / 3 failed from unrelated concurrent work on `TaskViewerProvider.ts`.
- `npm run compile-tests` must be clean for `TaskViewerProvider.ts` and `npm run lint` must stay green. Note `compile-tests` has been observed red with 3 pre-existing errors in `TaskViewerProvider.ts` (`showInfoMessage` on `HostUI`, `OrchestratorSeat` ×2) from concurrent work; those must be resolved or confirmed unrelated before this card's compile result means anything.
- `npm run catalog:check`, `npm run parity:check` — unaffected by design; run to confirm.

### Manual
1. Open a multi-root window with two or more roots that have `.switchboard/`. Confirm every eligible root holds the same port and that it matches `GET /health`.
2. `rm` the port file from one root only. Within 30 seconds, confirm it reappears with the correct port, that the server's PID is unchanged, and that the diagnostics channel names the repaired root.
3. Add a third eligible folder to the window. Confirm it receives a port file without a server restart.
4. Add a folder with **no** `.switchboard/`. Confirm no directory and no port file are created in it.
5. With two hosts (Devin + Antigravity) sharing a root, stop one host's server. Confirm the shared root still holds a port file naming the surviving server, and that an agent in that root can reach it.
6. From a dispatched agent in this repo, follow the reviewer delegation step verbatim — read the port file, `POST /terminals/verb/ptySendPrompt` — and confirm it reaches the target terminal with no out-of-band port discovery.

**Recommendation:** Complexity 4 → **Send to Coder.**
