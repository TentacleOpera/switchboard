# Terminal log session boundaries not created on clear button or copy-prompt dispatch

## Goal

Terminal session logs must roll to a new session file when the user clicks the clear button on a terminal pane and when a new planning prompt is dispatched via the copy-prompt button flow. Today, neither action triggers `onSessionBoundary` — the log file continues accumulating output in the same session document, so a cleared terminal starting fresh work reads as a continuation of the old session instead of a new document.

### Problem Analysis

**The clear button sends `/clear` to the pty but never tells the log writer to roll.** The terminal pane's clear button (`terminals.js:6083-6094`) calls `clearTerminal(name)`, which POSTs `/terminals/verb/ptyClearTerminal` (`terminals.js:8895-8908`). The verb handler in both hosts calls `clearPty(handle)` — which writes `/clear` to the pty — but does NOT call `terminalLogWriter.onSessionBoundary(terminalName)`. In the standalone host (`bootstrap.ts:1753-1762`), the handler is:

```typescript
case 'ptyClearTerminal': {
    const handle = ptyFleetService.get(payload.name);
    if (!handle) { return { success: false, error: `No such terminal: ${payload.name}` }; }
    if (handle.agentInstanceId) { seatBlockCache.delete(handle.agentInstanceId); }
    lastWorkContextByTerminal.delete(payload.name);
    if (handle.status === 'active') { await clearPty(handle); }
    return { success: true };
}
```

No `terminalLogWriter.onSessionBoundary(payload.name)` call. In the extension pty host child (`ptyHost.ts:198-203`), the same gap:

```typescript
case 'ptyClearTerminal': {
    const handle = fleet.get(payload.name);
    if (!handle) { return { success: false, error: `No such terminal: ${payload.name}` }; }
    if (handle.status === 'active') { await clearPty(handle); }
    return { success: true };
}
```

Also no `terminalLogWriter.onSessionBoundary(payload.name)` call.

**The copy-prompt button copies to clipboard but the manual paste that follows has no system event.** The copy-prompt button in the kanban pane (`terminals.js:7289-7330`) calls `/kanban/verb/promptSelected`, which copies a planning prompt to the system clipboard. The user then manually pastes it into a terminal. Because the paste is a user action — not a system-delivered prompt via `ptySendPrompt` — the `onPromptDelivered` callback in `sendPromptToPty` (`ptyPromptDelivery.ts:203-204`) is never fired, so `terminalLogWriter.onPrompt()` is never called. No heading is written, and no session boundary is created.

Even when a prompt IS delivered via `ptySendPrompt` (the system dispatch path), `onPromptDelivered` only writes a `##` heading — it does NOT roll the session file. The heading gives the document an outline, but the session file itself continues. The user's expectation is that a new planning prompt starts a new session document, matching the mental model that "a cleared terminal starting fresh work is a new session" (the original plan's own language at `terminal-session-logs-as-readable-markdown.md:67`).

**Session boundaries today are wired only to `queue/done`.** The `onTerminalContextCleared` callback (`LocalApiServer.ts:374`) fires only from `_runQueueDone` (`LocalApiServer.ts:2500-2508` for kanban seats, `:3015-3024` for team seats). In the standalone host, this calls `terminalLogWriter.onSessionBoundary(terminalName)` (`bootstrap.ts:2792-2793`). In the extension host, it forwards `ptyRollLogSession` to the pty host child (`TaskViewerProvider.ts:3760-3763`, `ptyHost.ts:319-328`). The clear button and copy-prompt flow bypass `queue/done` entirely, so they bypass the session roll.

### Root Cause

The session boundary hook was wired to a single trigger — `queue/done`'s `onTerminalContextCleared` callback — and the two other paths that reset a terminal's context (the clear button's `ptyClearTerminal` verb and a new prompt dispatched after a copy-prompt copy) were never connected to it. The log writer has the method (`onSessionBoundary`) and both hosts have the writer instance, but neither call site was added.

## Metadata

**Complexity:** 4
**Tags:** bugfix, backend, frontend
**Project:** Browser Switchboard

## User Review Required

No — the fix is a wiring gap (missing `onSessionBoundary` calls at two existing trigger points). The approach is mechanical: add calls at the same server-side points where terminal context is reset. The one design decision (roll before vs. after `sendPromptToPty`) is resolved in the Proposed Changes with a clear rationale. No user-facing behavior change beyond the log file rolling as expected.

## Complexity Audit

### Routine

- Adding `terminalLogWriter.onSessionBoundary(payload.name)` to the `ptyClearTerminal` verb handler in `bootstrap.ts` (one line).
- Adding `terminalLogWriter.onSessionBoundary(payload.name)` to the `ptyClearTerminal` verb handler in `ptyHost.ts` (one line).
- Adding `terminalLogWriter.onSessionBoundary(payload.name)` to the `ptySendPrompt` verb handler in both hosts, so a new prompt delivery rolls the session file (a few lines per host).

### Complex / Risky

- **Copy-prompt flow has no system delivery event.** The copy-prompt button copies to clipboard; the user pastes manually. There is no hook point in the system that knows when the paste happens. The fix is to roll the session when `ptySendPrompt` delivers a new prompt (which covers the system dispatch path), and to also roll on `ptyClearTerminal` (which covers the manual clear-then-paste path). A user who copies a prompt, manually clears the terminal, then pastes will get a new session file from the clear. A user who copies a prompt and pastes it WITHOUT clearing first will get a new session file from the `ptySendPrompt` delivery — but only if they dispatch via the system. For the pure manual paste (copy to clipboard, paste by hand, no system verb), there is no event to hook; this is an inherent limitation of the clipboard flow, not a wiring gap.
- **`ptySendPrompt` rolling on every prompt may fragment sessions.** If an orchestrator sends multiple prompts in sequence (e.g. a fix-after-review cycle), each would roll to a new file. This may or may not be desired. The fix should roll only when `clearBeforePrompt` is true (the system dispatch path that resets context), not on every prompt delivery. A prompt sent without clearing continues the same session — only a context reset starts a new one.

## Edge-Case & Dependency Audit

**Migration.** None. No existing log files change shape; new session files are created going forward.

**Side effects.** More session files on disk — each clear and each context-resetting dispatch creates a new file. The writer already handles this (rotation is a session roll, not a rename). The sidebar lists sessions by mtime, so more files just means more entries.

**Race conditions.** `onSessionBoundary` calls `rollSession`, which closes the current fence, generates a new session ID, and writes a new header. This is synchronous in the writer's internal state (the async part is the file write chain). A flush arriving during the roll is fine — the roll updates `state.filePath` synchronously, so the flush's `enqueueWrite` captures the new path. This is the same discipline the `queue/done` path already relies on.

**Both-host parity.** The fix must be applied in both `bootstrap.ts` (standalone) and `ptyHost.ts` (extension pty child). The standalone host has `terminalLogWriter` in scope; the pty host child also has `terminalLogWriter` in scope (it's constructed at `ptyHost.ts:54`). The extension host's `TaskViewerProvider.ts` does NOT have the writer — it forwards `ptyRollLogSession` to the child. For `ptyClearTerminal`, the extension host already forwards the verb to the child (`TaskViewerProvider.ts` → `_ptyHostVerb`), so the child's handler is where the roll belongs — same as `ptyRollLogSession`.

**`ptyClearAllTerminals`.** The bulk clear verb (`ptyHost.ts:210-213`, `bootstrap.ts` equivalent) clears all active terminals. Each cleared terminal should also roll its session. The fix should iterate and call `onSessionBoundary` for each.

**Bare `/clear` via `sendToTerminal`.** The sidebar's "CLEAR TERMINALS" button posts `sendToTerminal` with `input: '/clear'`, which routes through the `ptyWrite` branch, not `ptyClearTerminal` (`TaskViewerProvider.ts:493-500`, `bootstrap.ts:2228-2238`). This path also does not roll the session. The fix should hook the bare `/clear` on the `ptyWrite` path as well, or accept that only the explicit `ptyClearTerminal` verb rolls (the bare `/clear` path is a legacy route).

**Verified: `handle.name` and `handle.friendlyName` are always identical.** The fleet's `rename()` method (`ptyFleetService.ts:881-882`) updates BOTH `handle.friendlyName` and `handle.name` to the new alias — they never diverge. The log writer's `onRename` rekeys its internal map to match. So `onSessionBoundary(handle.name)` and `onSessionBoundary(handle.friendlyName)` are equivalent. Use `handle.name` for consistency with the `onPromptDelivered` callback (`ptyPromptDelivery.ts:204`), which keys the log writer's state map.

**Verified: `onSessionBoundary` is a no-op when no state exists.** `terminalLogWriter.ts:325-326` returns early if `!this.terminals.get(terminalName)`. A terminal that has never produced output has no log file to roll — calling `onSessionBoundary` on it is safe and does nothing.

## Dependencies

- None — this is a standalone bugfix with no prerequisite plans or sessions.

## Adversarial Synthesis

Key risks: (1) rolling before `sendPromptToPty` means the `/clear` echo lands in the new session file — a minor cosmetic issue, not a correctness one; (2) the bare `/clear` via `sendToTerminal` path is not covered, but the terminal pane's clear button uses the explicit `ptyClearTerminal` verb, so the stated goal is met; (3) the proposed integration tests require a running host — the existing test file uses source-text pattern matching, so the tests should match that style. Mitigations: accept the `/clear` echo cosmetic issue; document the bare-`/clear` gap as a known limitation; rewrite tests as source-text assertions matching the existing contract test style.

## Proposed Changes

### `src/standalone/bootstrap.ts` — roll session on `ptyClearTerminal`

**Context.** The `ptyClearTerminal` verb handler at `:1753-1762` clears the pty but does not roll the log session.

**Change.** Add `terminalLogWriter?.onSessionBoundary(payload.name)` after `clearPty(handle)`, before `return { success: true }`:

```typescript
case 'ptyClearTerminal': {
    const handle = ptyFleetService.get(payload.name);
    if (!handle) { return { success: false, error: `No such terminal: ${payload.name}` }; }
    if (handle.agentInstanceId) { seatBlockCache.delete(handle.agentInstanceId); }
    lastWorkContextByTerminal.delete(payload.name);
    if (handle.status === 'active') { await clearPty(handle); }
    // Roll the log session — a cleared terminal starting fresh work is a new document.
    terminalLogWriter?.onSessionBoundary(payload.name);
    return { success: true };
}
```

Also add the same call to the `ptyClearAllTerminals` handler (find the handler that iterates active terminals and calls `clearPty` on each — add `terminalLogWriter?.onSessionBoundary(name)` inside the loop).

### `src/standalone/ptyHost.ts` — roll session on `ptyClearTerminal` and `ptyClearAllTerminals`

**Context.** The `ptyClearTerminal` handler at `:198-203` and `ptyClearAllTerminals` at `:210-213` have the same gap.

**Change.** Add `terminalLogWriter.onSessionBoundary(payload.name)` after `clearPty(handle)`:

```typescript
case 'ptyClearTerminal': {
    const handle = fleet.get(payload.name);
    if (!handle) { return { success: false, error: `No such terminal: ${payload.name}` }; }
    if (handle.status === 'active') { await clearPty(handle); }
    // Roll the log session — a cleared terminal starting fresh work is a new document.
    terminalLogWriter.onSessionBoundary(payload.name);
    return { success: true };
}
```

For `ptyClearAllTerminals`, iterate the active terminals and call `onSessionBoundary` for each:

```typescript
case 'ptyClearAllTerminals': {
    const active = fleet.listActive();
    await Promise.all(active.map(t => clearPty(t)));
    for (const t of active) { terminalLogWriter.onSessionBoundary(t.name); }
    return { success: true, cleared: active.length };
}
```

### `src/standalone/ptyHost.ts` — roll session on `ptySendPrompt` when `clearBeforePrompt` is true

**Context.** The `ptySendPrompt` handler at `:278-308` delivers a prompt via `sendPromptToPty`. When `clearBeforePrompt` is true, the terminal's context is reset before the prompt is written — this is the system dispatch path that corresponds to "a new planning prompt starting fresh work." The `onPromptDelivered` callback writes a heading but does not roll the session file.

**Decision: roll BEFORE `sendPromptToPty` when `clearBeforePrompt` is true.**

> **Superseded:** Roll the session AFTER `sendPromptToPty` completes, gated on `clearBeforePrompt === true`.
> **Reason:** `onPromptDelivered` fires DURING `sendPromptToPty` (at `ptyPromptDelivery.ts:203-204`, before the submit CR), writing the `##` heading to the CURRENT session file. If the roll happens after `sendPromptToPty` returns, the heading is in the OLD file while the prompt's output (which arrives asynchronously after the function returns) goes to the NEW file. That splits a single logical entry across two files — the heading is orphaned from its output.
> **Replaced with:** Roll BEFORE `sendPromptToPty`. The old session file closes with whatever output preceded the clear. `onPromptDelivered` then writes the heading to the NEW session file, and the prompt's output also flows into the new file. The `/clear` command's echo (written inside `sendPromptToPty`'s clear branch) lands in the new file — a minor cosmetic issue: the new file starts with a few lines of `/clear` echo before the header. This is acceptable because `rollSession → writeHeader` writes the `# Terminal log:` header first, and the `/clear` echo is clearly the transition.

**Change.** Add the session roll before the `sendPromptToPty` call, gated on `clearBeforePrompt`:

```typescript
case 'ptySendPrompt': {
    const handle = fleet.get(payload.name);
    if (!handle) { return { success: false, error: `No such terminal: ${payload.name}` }; }
    if (handle.status !== 'active') { return { success: false, error: `Terminal ${payload.name} is not active` }; }
    // Roll the log session BEFORE delivery when context will be reset —
    // the old session ends here, and the prompt + its output flow into
    // the new session file.
    if (payload.clearBeforePrompt === true) {
        terminalLogWriter.onSessionBoundary(payload.name);
    }
    try {
        const readiness = await sendPromptToPty(handle, payload.data || '', {
            clearBeforePrompt: payload.clearBeforePrompt === true,
            clearBeforePromptDelayMs: typeof payload.clearBeforePromptDelayMs === 'number'
                ? payload.clearBeforePromptDelayMs
                : undefined,
            clearReadinessMode: payload.clearReadinessMode === 'auto' || payload.clearReadinessMode === 'manual'
                ? payload.clearReadinessMode
                : undefined,
            onPromptDelivered: (terminalName, promptText) => terminalLogWriter.onPrompt(terminalName, promptText),
        });
        return { success: true, readiness: readiness || undefined };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
}
```

### `src/standalone/bootstrap.ts` — same `ptySendPrompt` roll for the standalone host

**Context.** The standalone host's `deliverPrompt` function (`bootstrap.ts:432-437`) calls `sendPromptToPty` with `onPromptDelivered` wired. The `ptySendPrompt` verb handler at `:1771` calls `deliverPrompt`.

**Change.** In `deliverPrompt`, add the session roll immediately before the `sendPromptToPty` call (at `:432`), gated on `clearBeforePrompt`:

```typescript
// In deliverPrompt, right before the sendPromptToPty call at :432:
if (opts?.clearBeforePrompt && terminalLogWriter) {
    terminalLogWriter.onSessionBoundary(handle.name);
}
```

Use `handle.name` (not `handle.friendlyName`) for consistency with the `onPromptDelivered` callback at `:434-435`, which keys the log writer's state map. Both are always identical (verified: `ptyFleetService.ts:881-882` updates both on rename), but `handle.name` is the canonical key the log writer uses.

This covers all callers of `deliverPrompt` that pass `clearBeforePrompt: true`, not just the `ptySendPrompt` verb — including the card dispatch path at `bootstrap.ts:2173` (`deliverPrompt(terminal, prompt, getPromptDeliveryOptions())`).

### `src/test/terminal-session-log-contract.test.js` — add source-text tests for clear and prompt session rolls

**Context.** The existing contract test file uses source-text pattern matching (reading source files and asserting regex matches), not integration tests. For example, the existing session-boundary test at `:534` asserts `assert.match(BOOTSTRAP_SRC, /onTerminalContextCleared:[\s\S]{0,200}onSessionBoundary\(/, ...)`. The new tests must match this style — they assert the `onSessionBoundary` call is present in the verb handlers' source text, not that a running host produces two log files.

**New source-text tests:**

1. **`ptyClearTerminal` rolls the session in both hosts:** assert `BOOTSTRAP_SRC` matches `/case 'ptyClearTerminal'[\s\S]{0,400}onSessionBoundary\(/` and `PTYHOST_SRC` matches the same pattern. Verifies the roll call is present in the clear handler, not just the queue/done path.
2. **`ptyClearAllTerminals` rolls all active terminals in both hosts:** assert `BOOTSTRAP_SRC` matches `/case 'ptyClearAllTerminals'[\s\S]{0,300}onSessionBoundary\(/` and `PTYHOST_SRC` matches the same. Verifies the per-terminal roll is inside the clear-all loop.
3. **`ptySendPrompt` rolls when `clearBeforePrompt` is true in `ptyHost.ts`:** assert `PTYHOST_SRC` matches `/case 'ptySendPrompt'[\s\S]{0,600}clearBeforePrompt[\s\S]{0,200}onSessionBoundary\(/`. Verifies the roll is gated on `clearBeforePrompt` and placed before `sendPromptToPty`.
4. **`deliverPrompt` rolls when `clearBeforePrompt` is true in `bootstrap.ts`:** assert `BOOTSTRAP_SRC` matches `/deliverPrompt[\s\S]{0,2000}clearBeforePrompt[\s\S]{0,100}onSessionBoundary\(/`. Verifies the roll is in `deliverPrompt`, gated on `clearBeforePrompt`, before the `sendPromptToPty` call.
5. **`ptySendPrompt` does NOT roll when `clearBeforePrompt` is false:** assert the roll call is inside a `clearBeforePrompt === true` or `opts?.clearBeforePrompt` guard, not unconditional. A negative source-text assertion: the `onSessionBoundary` call in the `ptySendPrompt`/`deliverPrompt` context must be preceded by a `clearBeforePrompt` guard within 200 chars.

## Verification Plan

### Goal Invariants

- Clicking the clear button on a terminal pane starts a new log session file; the old session is preserved.
- Dispatching a prompt with `clearBeforePrompt: true` starts a new log session file; the heading and output appear in the new file.
- Dispatching a prompt with `clearBeforePrompt: false` does NOT roll the session; the heading appears in the current file.
- `ptyClearAllTerminals` rolls every active terminal's session.
- Both hosts (standalone and extension) roll sessions on the same triggers.
- The `onSessionBoundary` call in `ptyClearTerminal` is present in both `bootstrap.ts` and `ptyHost.ts` source text.
- The `onSessionBoundary` call in `ptySendPrompt`/`deliverPrompt` is gated on `clearBeforePrompt === true`, not unconditional.

### Automated Tests

- **Source-text: clear verb rolls session** — assert `onSessionBoundary` is present in the `ptyClearTerminal` handler source in both hosts.
- **Source-text: clear-all rolls all** — assert `onSessionBoundary` is present in the `ptyClearAllTerminals` handler source in both hosts.
- **Source-text: prompt with clear rolls** — assert `onSessionBoundary` is present in the `ptySendPrompt`/`deliverPrompt` handler source, gated on `clearBeforePrompt`.
- **Source-text: prompt without clear does not roll** — assert the `onSessionBoundary` call is inside a `clearBeforePrompt` guard, not unconditional.

### Manual Verification

- Run a terminal, produce output, click the clear button, produce more output. Open the log view and confirm two sessions appear in the sidebar.
- Dispatch a planning prompt via the system (not copy-prompt) with `clearBeforePrompt: true`. Confirm the heading and output appear in a new session file.
- Copy a prompt via the copy-prompt button, click the clear button, then paste the prompt manually. Confirm a new session file was created by the clear, and the pasted prompt's output flows into it.
- Verify in BOTH hosts: standalone and extension.
