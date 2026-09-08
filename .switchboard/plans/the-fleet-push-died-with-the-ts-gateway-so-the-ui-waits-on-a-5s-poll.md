# The Fleet Push Died With the TS Gateway, So Every Terminal State Change Waits on a 5-Second Poll

## Goal

A terminal appearing, exiting or changing state reaches the UI immediately, as a push — and the 5-second fleet poll that stood in for it is deleted, not kept. Polling is for state that changes outside the application; terminal state never does.

### Problem analysis

**Reported as "startup takes ages".** Observed: cards render, then Start Team does nothing for ~20 s, then the workspace attaches in the terminals sidebar, then another 5–10 s before Start Team responds. Measured against a live board over the tailnet, the cause is not slowness anywhere — it is a dead push and a 5-second poll standing in for it.

**The page boot is fast and is not the problem.** Instrumenting the terminals page from a real browser:

```
DOMContentLoaded                                    180ms
getKanbanStructure, getStartupCommands, 13x getSetting,
first ptyListTerminals — ALL COMPLETE BY            218ms
```

Thirteen sequential `loadSetting` round-trips look alarming and cost ~50 ms in total. They are not worth touching.

**Everything after 218 ms is one poll.** The same capture:

```
ptyListTerminals   5163ms   (gap 4945ms)
ptyListTerminals  10160ms   (gap 4985ms)
ptyListTerminals  15170ms   (gap 5003ms)
ptyListTerminals  20162ms   (gap 4964ms)
```

Four ticks to 20 s — the operator's "about 20 seconds" is four poll cycles, and the "5–10 s after that" is one or two more. Each step of *seat exists → workspace attaches → Start Team enables* is a separate transition, and each waits for the next tick because nothing tells the UI sooner.

**The push exists on the client and never arrives.** Measured directly: subscribe to the hub on `surfaces=terminals,common`, create a seat, watch.

```
seat create issued at   +2007ms
create returned at      +2851ms
pushes AFTER create:    kanbanStructure@7238ms
```

**No `terminalsChanged`.** The client is built to consume it — the handler is at `terminals.js:894`, and its own comments describe the intended pairing: *"fleet poll (5s), every terminalsChanged push and every collapse toggle"* (`terminals.js:171`), *"every push (5s poll + terminalsChanged)"* (`terminals.js:1281`). The poll was designed as the backstop. It is now the only mechanism.

**Root cause: the only broadcaster is retired code.** A repo-wide search finds exactly one `broadcastWs('terminalsChanged', ...)` call site — `terminalWsGateway.ts:696`, inside `this.fleetService.onDidChange(...)`. That file's `TerminalWsGateway` class is never constructed in production: `bootstrap.ts` does not import or instantiate it, and `ptyHost.ts` is a 7-line retired stub that throws. The fleet moved into the Go PTY host child (`e26ac375`), and the standalone host now uses `GoPtyFleetProjection` (`bootstrap.ts:3282`) — which has its own `onDidChange` emitter (`goPtyFleetProjection.ts:100`) that fires on create/kill/rename, but **nobody subscribes to it**. Nothing in `src/standalone/` broadcasts the verb at all.

So the Go host owns the fleet and tells no one when it changes. `terminals.js:2259` still documents the old contract — *"The gateway broadcasts terminalsChanged from inside fleetService.create()"* — describing a call site that no longer runs.

**Same shape as the rest of the extraction.** The Go host reimplemented the fleet's *verbs* and dropped its *notifications*, exactly as it reimplemented output framing, input framing and the origin check without matching the client. Verb-reachability audits stay green because every verb still answers; what went missing is a broadcast nobody's test asserts.

**Both hosts are broken, not just standalone.** The extension host does not run an in-process fleet either — `extension.ts` has zero references to `PtyFleetService`, `TerminalWsGateway`, or `terminalsChanged`. `TaskViewerProvider.ts` (the extension host's PTY verb handler) delegates all PTY verbs to `PtyHostSupervisor.request()` (the Go child via stdio) and never broadcasts `terminalsChanged`. The extension host is equally dependent on the 5-second poll.

## Metadata

- **Complexity:** 6
- **Tags:** bugfix, performance, reliability, ui, backend

## User Review Required

None.

## Complexity Audit

### Routine
- Deleting `startFleetPoll`/`stopFleetPoll` and the `setInterval` call in `terminals.js:7985-8001` — a localized, single-file removal.
- Subscribing to `GoPtyFleetProjection.onDidChange` in `bootstrap.ts` and calling `server.broadcastWs('terminalsChanged', {}, SURFACES.terminals)` — one subscription, one broadcast line, mirroring the retired `terminalWsGateway.ts:695-697` pattern.
- Adding `server.broadcastWs('terminalsChanged', {}, SURFACES.terminals)` after `ptyCreateTerminal`/`ptyCloseTerminal`/`ptyRenameTerminal` in `TaskViewerProvider.handlePtyVerb` — the extension host's equivalent, mirroring the existing `terminalsGroupsChanged` broadcast at `TaskViewerProvider.ts:4186`.
- Deleting or marking `terminalWsGateway.ts` as retired — the file is already dead code.

### Complex / Risky
- **Exit detection in the standalone host.** `GoPtyFleetProjection.onDidChange` fires on `create()` (`goPtyFleetProjection.ts:239`), `kill()` (`:383`), and `rename()` (`:396`) — but NOT on natural CLI exit. Exit is detected by the `{"t":"exit"}` WebSocket message in `attachLiveStream` (`goPtyFleetProjection.ts:517-521`), which sets `handle.status = 'exited'` and fires per-handle `exitListeners`, but does NOT emit a fleet change event. Without an additional `this.emitter.emit('change', { type: 'closed', name })` in the exit handler, the push will not fire when a CLI dies on its own — the exact case where a stale UI is most misleading.
- **Exit detection in the extension host.** `TaskViewerProvider` does not have `GoPtyFleetProjection` or `attachLiveStream`. It delegates to `_ptyHostVerb` (stdio to the Go child). The Go child sends `{"t":"exit"}` directly to the browser via WebSocket, bypassing Node entirely. There is no Node-side exit detection to hook into. Covering exit pushes in the extension host requires a new Go→Node notification channel, which is out of scope for this plan.
- **Both-hosts divergence.** The fix must land in both `bootstrap.ts` (standalone) and `TaskViewerProvider.ts` (extension). The standalone host can cover operator mutations AND exits (via `GoPtyFleetProjection`); the extension host can only cover operator mutations. This asymmetry must be documented, not hidden.
- **Push storms during team start.** Starting a team creates several seats in quick succession. The `onDidChange` subscription will fire once per create. The client already coalesces (it refetches on any push), but a burst of 6+ pushes in 200 ms is wasteful. A debounce on the emitter side is preferable, but the last push must not be dropped.
- **Removing the poll makes the push load-bearing.** Any fleet change that fails to emit becomes a visible, immediate bug instead of a five-second delay nobody files. That is the argument for deletion, not against it — but it means the emitter must cover every mutation before the poll goes, not after.

## Edge-Case & Dependency Audit

1. **Both hosts — corrected.**

   > **Superseded:** "The extension host still runs the in-process fleet and its own broadcast path; the fix must not double-emit there. Diff the composition roots by hand — the extension may already be correct, which is exactly why nobody noticed."
   > **Reason:** Verified by code inspection: `extension.ts` has zero references to `PtyFleetService`, `TerminalWsGateway`, or `terminalsChanged`. `TaskViewerProvider.ts` delegates all PTY verbs to `PtyHostSupervisor.request()` (the Go child via stdio) and never broadcasts `terminalsChanged` — its only terminal-related broadcast is `terminalsGroupsChanged` (`TaskViewerProvider.ts:4186`). The extension host does NOT run an in-process fleet and does NOT have its own broadcast path. Both hosts are equally broken.
   > **Replaced with:** The fix must land in BOTH hosts. In standalone: subscribe to `GoPtyFleetProjection.onDidChange` in `bootstrap.ts` and broadcast. In extension: broadcast after `ptyCreateTerminal`/`ptyCloseTerminal`/`ptyRenameTerminal` in `TaskViewerProvider.handlePtyVerb`. There is no double-emit risk — neither host emits today. The extension host cannot cover natural CLI exit without a new Go→Node notification channel (see Complexity Audit).

2. **Surface scoping.** The push must go to `SURFACES.terminals` (`wsHub.ts:41`). Broadcast to `all` and every panel wakes for a change it does not render — the fan-out problem the surface scoping exists to prevent. The existing `terminalsGroupsChanged` broadcasts in `bootstrap.ts:2102,2176` already use `SURFACES.terminals`; match that.

3. **Push storms during team start.** Starting a team creates several seats in quick succession. The `onDidChange` subscription fires per mutation; the client coalesces (it refetches on any push). A short debounce (e.g. 50–100 ms trailing) on the broadcast is preferable to N pushes in 200 ms, but the last push must not be dropped — it is the one that matters.

4. **Ordering against the create response.** For roles with a startup command the create response is withheld ~750 ms (`SHELL_READINESS_DELAY_MS`); measured at 844 ms here. A push that lands before that response must not make the client render a seat it is about to be told about again — the client's existing refetch-on-push handles this, but assert it rather than assume. The `terminals.js:9249-9255` comment already documents this race: the gateway used to broadcast from inside `fleetService.create()` 750 ms before the response resolved, and the client handled it.

5. **Do not treat the 13 settings loads as the problem.** They complete inside 218 ms. Serialising them is untidy; it is not the bug, and changing them here would mask whether the push fix worked.

6. **Removing the poll makes the push load-bearing, which is the point.** Any fleet change that fails to emit becomes a visible, immediate bug instead of a five-second delay nobody files. That is the argument for deletion, not against it — but it means change 1's emitter must cover every mutation before the poll goes, not after.

7. **Sibling plan dependency.** The sibling plan *Four Polls That Ask the App About Its Own Events* retains its own polls (fleet-tab in `shell.js`, kanban-pane in `terminals.js`) until their own pushes exist. This plan deletes only the `terminals.js:7985` fleet poll (`startFleetPoll`/`stopFleetPoll`). The sibling plan's `shell.js:530` fleet-tab poll is NOT touched here — it covers hop state (`getHopState`), which no push carries.

## Dependencies

- None. This plan is self-contained. The sibling plan *Four Polls That Ask the App About Its Own Events* records this plan as a prerequisite for its recommended future work (hop-state push), but this plan has no executable dependency on it.

## Adversarial Synthesis

Key risks: (1) the original plan assumed the extension host already had the broadcast — it does not, so the fix must land in both composition roots or the extension diverges; (2) `GoPtyFleetProjection.onDidChange` does not fire on natural CLI exit, so subscribing to it alone leaves the "seat reads active for 5 s after it dies" case unfixed in standalone; (3) the extension host has no Node-side exit detection at all, so exit pushes are standalone-only without a new Go→Node channel. Mitigations: wire both hosts for operator mutations; add an `emitter.emit('change', {type:'closed',name})` to the `{"t":"exit"}` handler in `GoPtyFleetProjection.attachLiveStream` for standalone exit coverage; document the extension-host exit gap as a known limitation and open a follow-up card for the Go→Node notification channel.

## Proposed Changes

### 1. `src/standalone/bootstrap.ts` — Subscribe to `GoPtyFleetProjection.onDidChange` and broadcast `terminalsChanged`

**Context:** `GoPtyFleetProjection` (`goPtyFleetProjection.ts:100`) already has an `onDidChange` emitter that fires `{type:'created'}` on `create()` (`:239`), `{type:'closed'}` on `kill()` (`:383`), and `{type:'renamed'}` on `rename()` (`:396`). Nobody subscribes. This is the one-emitter pattern the plan advocates — and it is the same pattern the retired `terminalWsGateway.ts:681-698` used (subscribe to `fleetService.onDidChange`, broadcast `terminalsChanged`).

**Implementation:** After `ptyFleetService` is constructed (`bootstrap.ts:3282`), add:

```typescript
ptyFleetService.onDidChange(() => {
    try { server?.broadcastWs('terminalsChanged', {}, SURFACES.terminals); } catch { /* broadcast failure must not crash the fleet */ }
});
```

This covers every operator-initiated mutation that goes through `GoPtyFleetProjection.create/kill/rename` — including `ptyCreateTerminal`, `ptyCloseTerminal`, `ptyRenameTerminal`, `ptyCreateBatch`, and `spawnDelegates` (which calls `create` per child). No per-verb-call-site emission needed; the projection is the single chokepoint.

**Debounce:** A team start fires 6+ creates in ~200 ms. Add a trailing debounce (50–100 ms) on the broadcast so the hub sends one push, not six. The debounce must be trailing-edge only — a leading-edge debounce would drop the first create's push, which is the one the operator is waiting for. Implementation: a simple `let pushTimer: NodeJS.Timeout | null = null;` that clears and resets on each event, and fires the broadcast on expiry.

**Edge cases:** The subscription must be wired AFTER `server` is available. `bootstrap.ts` constructs `ptyFleetService` at `:3282` and `server` (LocalApiServer) earlier in the boot sequence, so `server` is in scope. Wrap in `try/catch` — a broadcast failure must not crash the fleet.

### 2. `src/services/goPtyFleetProjection.ts` — Emit a fleet change event on natural CLI exit

**Context:** The `attachLiveStream` method (`:480-524`) opens a WebSocket to the Go child for each terminal. When the CLI exits, the Go child sends `{"t":"exit"}` (`:517-521`), which sets `handle.status = 'exited'` and fires per-handle `exitListeners` — but does NOT emit a fleet change event. So `onDidChange` subscribers never learn about natural exits.

**Implementation:** In the `socket.on('message')` handler for `message.t === 'exit'` (`:517-521`), after setting `handle.status = 'exited'` and firing `exitListeners`, add:

```typescript
this.emitter.emit('change', { type: 'closed', name });
```

This makes the `onDidChange` subscription from change 1 fire on exit too. The client's `fetchTerminalList()` will refetch and see `status: 'exited'` in the `ptyListTerminals` projection (`bootstrap.ts:2226`).

**Edge cases:** The exit event may arrive after `kill()` has already removed the handle from the cache and emitted `{type:'closed'}`. In that case, the handle is gone from `this.cache` but the WebSocket may still deliver the final `{"t":"exit"}`. The extra emit is harmless — the client coalesces, and a second push for an already-closed seat is a no-op refetch. Do NOT guard with `if (this.cache.has(name))` — that would suppress the exit push for a seat that was killed while still running (the `kill()` path deletes from cache before the WebSocket closes).

### 3. `src/services/TaskViewerProvider.ts` — Broadcast `terminalsChanged` after operator mutations (extension host)

**Context:** `TaskViewerProvider.handlePtyVerb` (`:3913`) delegates to `_ptyHostVerb` and already broadcasts `terminalsGroupsChanged` after team-wiring succeeds (`:4186`). The same pattern applies to `terminalsChanged` for create/close/rename.

**Implementation:** After the existing `if (['ptyCreateTerminal', 'ptyCreateBatch', 'ptyCloseTerminal', 'ptyRenameTerminal'].includes(verb))` block (`:4123-4194`), add a broadcast when the verb succeeded:

```typescript
if (['ptyCreateTerminal', 'ptyCreateBatch', 'ptyCloseTerminal', 'ptyRenameTerminal'].includes(verb)
    && result && result.success !== false) {
    this._broadcaster?.push({ type: 'terminalsChanged' }, SURFACES.terminals);
}
```

This mirrors the `terminalsGroupsChanged` push at `:4186`. Use `this._broadcaster?.push(...)` (the extension host's broadcast seam), not `server.broadcastWs(...)` (the standalone seam). Import `SURFACES` from `wsHub.ts` if not already imported.

**Debounce:** Same trailing-debounce as change 1 — a team start fires multiple creates. Apply the same trailing-edge-only debounce.

**Exit gap — acknowledged limitation:** The extension host does NOT have `GoPtyFleetProjection` or `attachLiveStream`. The Go child sends `{"t":"exit"}` directly to the browser via WebSocket, bypassing Node. There is no Node-side exit detection to hook into. Covering exit pushes in the extension host requires a new Go→Node notification channel (the supervisor protocol is request-response only today). This is out of scope for this plan. Open a follow-up card. The 5-second poll deletion (change 5) will make this gap visible — a seat that dies will show as active until the operator interacts with the panel (visibilitychange fires `fetchTerminalList` at `terminals.js:1253`). That is a better failure mode than the current 5-second staleness for EVERYTHING.

### 4. Delete or resurrect the dead gateway, deliberately

`terminalWsGateway.ts` is the only file that calls `broadcastWs('terminalsChanged', ...)` and nothing constructs it. The `status-pane-mode-contract.test.js:227-256` test asserts that `bootstrap.ts` and `ptyHost.ts` each have exactly one `new TerminalWsGateway(...)` construction — but `bootstrap.ts` no longer has one (it uses `GoPtyFleetProjection`), and `ptyHost.ts` is a 7-line retired stub. That test is stale and will fail if run.

**Implementation:** Either:
- **(a) Delete `terminalWsGateway.ts`** and the stale test assertions in `status-pane-mode-contract.test.js:227-256` that pin its construction. The class is dead code — no production path constructs it. The test file's other assertions (suspend/resume, content-free collapse) may reference the gateway class directly and need updating to use `GoPtyFleetProjection` instead.
- **(b) Keep it with a deprecation header** recording that it is retired, the fleet moved to the Go child, and `GoPtyFleetProjection.onDidChange` + `bootstrap.ts` now own the broadcast. Update the stale test to not assert construction in files that no longer construct it.

Option (a) is cleaner — dead code is a trap. But the test file may have other uses of `TerminalWsGateway` that need migration. The implementer should check `grep -r 'TerminalWsGateway' src/test/` before choosing.

### 5. Delete the fleet poll in `src/webview/terminals.js`

**Context:** `startFleetPoll()` (`terminals.js:7985-7995`) sets a 5-second `setInterval` calling `fetchTerminalList()`. It is called from `init()` at `:1256`. `stopFleetPoll()` (`:7997-8002`) clears it. The poll skips when the tab is hidden (`:7992`).

**Implementation:** Delete `startFleetPoll()`, `stopFleetPoll()`, the `fleetPollTimer` variable (`:90`), and the `startFleetPoll()` call at `:1256`. Keep the `visibilitychange` listener at `:1252-1254` — it fires `fetchTerminalList()` on regain, which is still needed for the extension-host exit gap (a visibility regain refetches and discovers exits the push couldn't cover).

**Justification for deletion (not demotion):**

- **Reconnect gaps** are already covered. `wsHub.ts:399` sends a `__resync` on every connect and `transport.js:222` fires `sbTransportReconnected`. A reconnect reconciles everything before the poll could.
- **Dropped pushes** are not a failure mode. WebSocket runs on TCP: a message is delivered or the connection breaks, and a break reconnects, which resyncs. There is no silent-loss case to catch.
- **Liveness** is already known to the client. It stamps `lastFrameAt`, `firstFrameAt` and `lastPrintableAt` on every output frame (`terminalViewport.js:931-944`, assigned at `:1574-1611`). It is watching the stream directly.
- **The polled `lastDataAt` is not read anywhere in `src/webview/`.** Zero references. The field this poll refreshes is never consumed.

What remains is a browser tab asking the server, 17,280 times a day per panel, whether someone pressed a button — a question the system *originates* and therefore already knows the answer to. Measured: 3.5 KB and 21.8 ms per call, 103,680 calls and 363 MB/day across six open panels, ~2.6% of a core continuously. On a 12-seat fleet the payload roughly doubles.

**Polling is for state that changes outside the application.** Plan files qualify: an agent writes one, a `git pull` lands one, and nothing in-process emitted an event. Terminal state does not — every change to it is something this system did.

**And the poll is why this bug survived.** It kept the UI correct-but-slow, so a completely dead push presented as sluggishness rather than a break. Had nothing covered for it, the missing broadcast would have failed loudly the day the Go host landed. Leaving it in place preserves exactly that camouflage for the next notification someone forgets to wire.

**Caveat — extension host exit gap:** With the poll gone, a CLI that dies in the extension host will show as active until the operator interacts with the panel (visibilitychange fires `fetchTerminalList` at `:1253`). This is a narrower failure mode than the current 5-second staleness for everything. The standalone host does not have this gap (change 2 covers exit via `GoPtyFleetProjection`). The follow-up card for the Go→Node notification channel (change 3) closes it fully.

## Verification Plan

### Automated Tests

1. Subscribe to the hub on `surfaces=terminals,common`, create a seat, and assert a `terminalsChanged` push arrives **within 1 s** — the check that fails today, where nothing arrives at all.
2. Kill a seat's CLI externally and assert a push follows; the sidebar must not show it active for five more seconds. (Standalone only — the extension host exit gap is documented.)
3. Start a team and assert the sidebar populates without waiting for a poll tick — measure from the create call to the DOM update and require well under 5 s.
4. With the poll disabled entirely, the UI still tracks every fleet change. This is what proves the push is the primary path rather than a duplicate of the poll.
5. No periodic `ptyListTerminals` request exists at rest. Open the panel, leave it idle for two minutes, and assert **zero** fleet requests after the initial load — today there are 24.
6. A panel subscribed to a different surface receives no terminal pushes.
7. The extension host emits exactly one push per mutation, not two. Verify by inspecting `TaskViewerProvider.handlePtyVerb` — the `terminalsChanged` broadcast must not duplicate the `terminalsGroupsChanged` broadcast (they are different verbs for different purposes).
8. The standalone host emits a push on natural CLI exit (not just operator kill). Kill a seat by sending `exit` to its CLI, not by calling `ptyCloseTerminal`, and assert the push fires.
9. The stale `status-pane-mode-contract.test.js:227-256` test (asserting `new TerminalWsGateway(...)` in `bootstrap.ts` and `ptyHost.ts`) is updated or deleted — it will fail against the current code.

### Goal Invariants

- Assert `startFleetPoll` is absent from `src/webview/terminals.js` (grep returns zero matches).
- Assert `fleetPollTimer` is absent from `src/webview/terminals.js` (grep returns zero matches).
- Assert `ptyFleetService.onDidChange` is called exactly once in `src/standalone/bootstrap.ts` (the subscription that wires the broadcast).
- Assert `broadcastWs('terminalsChanged'` appears in `src/standalone/bootstrap.ts` (the broadcast call inside the subscription).
- Assert `terminalsChanged` appears in `src/services/TaskViewerProvider.ts` (the extension host's broadcast after mutation verbs).
- Assert `this.emitter.emit('change', { type: 'closed'` appears in the `{"t":"exit"}` handler in `src/services/goPtyFleetProjection.ts` (the exit-detection emit).
- Assert `new TerminalWsGateway(` is absent from `src/standalone/bootstrap.ts` (the retired class is not reconstructed).

## Outstanding Questions

- **[user]** The extension host cannot push on natural CLI exit without a new Go→Node notification channel (the supervisor protocol is request-response only). Should a follow-up card be opened for that channel, or is operator-mutation-only coverage acceptable for the extension host until then? — proceeding on the assumption that operator-mutation-only is acceptable for now, with the visibilitychange refetch as the fallback for exit discovery.
- **[user]** Should `terminalWsGateway.ts` be deleted (option a) or kept with a deprecation header (option b)? The stale test in `status-pane-mode-contract.test.js:227-256` must be updated either way. — proceeding on the assumption that deletion is preferred (dead code is a trap), but the implementer should verify no test directly instantiates `TerminalWsGateway` for non-construction assertions before deleting.

## Implementation Summary

Implemented all five changes. (1) `bootstrap.ts` now subscribes to `GoPtyFleetProjection.onDidChange` with a 75ms trailing-edge debounce and broadcasts `terminalsChanged` to `SURFACES.terminals` — the closure uses `server?.broadcastWs` so a change event before `server` is assigned is a no-op. (2) `goPtyFleetProjection.ts` emits `{type:'closed',name}` in the `{"t":"exit"}` handler so natural CLI exit reaches subscribers (not just operator kill). (3) `TaskViewerProvider.ts` broadcasts `terminalsChanged` after `ptyCreateTerminal`/`ptyCreateBatch`/`ptyCloseTerminal`/`ptyRenameTerminal` on success, with the same trailing debounce; the extension-host exit gap is documented inline as a known limitation. (4) Chose option (b): `terminalWsGateway.ts` is kept with an `@deprecated` header (the behavioural ring-buffer/backpressure tests in `terminal-content-free-collapse-contract.test.js` still exercise it), and the stale `status-pane-mode-contract.test.js` assertion was rewritten to assert neither root constructs it. (5) Deleted `startFleetPoll`/`stopFleetPoll`/`fleetPollTimer` and the `startFleetPoll()` call from `terminals.js`; kept the `visibilitychange` regain refetch as the extension-host exit-gap fallback. All seven goal invariants verified by grep.

## Review Findings

Files changed in review: `src/services/TaskViewerProvider.ts` (moved the extension-host `terminalsChanged` push from `handlePtyVerb` to `_ptyHostVerb`'s `finally` — the wrapper is bypassed by `ptyStartTeam`/`startTeamForWorkspace`, the autoban create, `createHeadWithDelegates`, `createDelegatesOnly` and the dispatch-time create, so Start Team would have had no push at all with the poll gone; added `TERMINAL_MUTATION_VERBS`, `_scheduleTerminalsChangedPush`, and a dispose-time timer clear), `src/test/shell-agent-dock.test.js` (a CI-gated assertion still required `startFleetPoll` to exist in `terminals.js` and was failing), `src/test/standalone-fleet-seam-contract.test.js` (four new CI-gated tests pinning the bootstrap subscription, the exit emit, the `_ptyHostVerb` push seam and the poll's absence), `src/webview/terminals.js` (three comments still described the retired gateway as the broadcaster). Validation: `compile-tests` clean; `status-pane-mode` 30/0, `shell-agent-dock` 60/0, `shell-terminal-strip` 75/0, `terminal-content-free-collapse` 32/0, `standalone-fleet-seam` 17/0, `pty-host-gating` pass, `broadcast-hub-headless` 11/0, `wshub-reaper` 4/0, and `catalog/push-routing/standalone-parity/parity/mirror` checks all pass; `pty-route-surface` fails to load on a pre-existing `Cannot find module 'vscode'` in this environment (reproduced with the change stashed). All seven Goal Invariants verified by grep. Remaining risk: the plan's Automated items 1–8 are live-hub behavioural checks that were never written, so nothing executable proves a push actually *arrives* — the new tests pin only that the emitter, subscription, broadcast and surface tag are joined up.

## Deferred Findings

- MAJOR — extension-host natural-CLI-exit gap: no Node-side exit detection exists, so a CLI that dies on its own reads active until a visibilitychange refetch. Declared out of scope by the plan (needs a Go→Node notification channel). `src/services/TaskViewerProvider.ts:1451`
- MAJOR — the plan's `### Automated` items 1–8 were never implemented as executable checks; the core mechanism (a `terminalsChanged` push reaching a subscribed client within 1 s) has no automated discriminator. Static wiring is now pinned instead. `src/test/standalone-fleet-seam-contract.test.js:1`
- NIT — `startFleetPoll`'s `isKanbanDock` suppression has no successor: the `terminalsChanged` handler is unconditional, so a kanban-dock panel now refetches the fleet it does not render on every fleet change. Still far below the deleted 5 s poll's traffic. `src/webview/terminals.js:890`
- NIT — `terminalWsGateway.ts` retained (option b) rather than deleted; the class stays dead-but-tested via `terminal-content-free-collapse-contract.test.js`. `src/standalone/terminalWsGateway.ts:392`
- MAJOR (re-graded after measurement; pre-existing, untouched, needs its own card) — `_ptyHostVerb` prefers `_ptyHostSupervisor` over `_fleetVerb`, and standalone wires both (`bootstrap.ts:1478`, `:3959`), so its creates never touch `GoPtyFleetProjection`. `refresh()` has exactly two callers (constructor, top of `create()`) — no timer — and standalone's `ptyListTerminals` returns `ptyFleetService.list()` (`bootstrap.ts:2259`), the cache. So a bypassed seat is missing from the sidebar, from `getLiveness()` (the 10 s activity-light sweep falls through to the blind timer), from `listActive()` turn-end recipient resolution, and has no live stream, so the new natural-exit emit does not fire for it. Reachable in standalone via `createFleetTerminalAndDeliver` (Planning/sidebar dispatch to a role with no seat) and `ensureWorktreeTerminals` → `_createAutobanTerminal` (worktree create). NOT team start (`setAgentGroupInstantiator` uses `ptyFleetService.create()`), NOT `addCoderTerminalFromKanban` (extension-only). Invisible on the extension host, whose arm returns the Go host's own reply — so this becomes a first-class defect as the extension host is deprecated. `src/services/TaskViewerProvider.ts:1343`
- MAJOR — false docblock, unrelated to this plan: `KanbanProvider.ts:376-379` says `_createAutobanTerminal` "always fails" on standalone because it calls `vscode.window.createTerminal` (citing a line that has moved). It no longer calls `createTerminal` at all — it succeeds on standalone, down the bypass above. The comment will stop the next reader from looking. `src/services/KanbanProvider.ts:376`
- NIT — `singletonDuplicates` is also an `onDidChange` event type (`goPtyFleetProjection.ts:173`), so it now triggers a fleet push too. Harmless (a refetch), but the subscription is broader than "roster changed". `src/services/goPtyFleetProjection.ts:173`
