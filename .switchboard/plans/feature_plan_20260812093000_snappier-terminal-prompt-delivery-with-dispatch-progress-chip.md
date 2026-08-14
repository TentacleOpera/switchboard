# Snappier PTY Prompt Delivery With A Dispatch Progress Chip In The Pane Header

## Goal

Cut the dead time between "drop a card on a terminal pane" and "the agent starts working", and give the operator a visible in-progress signal in the pane header for the whole window between the `/clear` and the submitted prompt.

### Problem analysis

Dropping a plan onto a terminal pane in the browser cockpit currently takes **~2.4–3 seconds of visibly nothing**. The pane shows the agent's idle prompt the entire time, so the operator cannot tell whether the drop registered, whether the fetch failed, or whether they should drop again. Rapid double-drops are a direct consequence.

### Root cause

Two separate causes compose.

**Cause 1 — the delivery pipeline is paced for VS Code's `sendText`, not for a directly-owned PTY.**

`src/standalone/ptyPromptDelivery.ts:21-54` (`sendPromptToPty`) is the delivery path for every browser-cockpit dispatch. Its timings are:

| Step | Delay | Line |
| --- | --- | --- |
| after `/clear\r` | `clearBeforePromptDelayMs ?? 2000` | `ptyPromptDelivery.ts:29-30` |
| between 256-byte chunks | `CHUNK_DELAY_MS = 30` | `ptyPromptDelivery.ts:5, 41` |
| before submitting `\r` | `100` | `ptyPromptDelivery.ts:45` |
| before the CLI confirm `\r` | `200` | `ptyPromptDelivery.ts:50` |

The 2000 ms clear settle dominates. That number was inherited from the VS Code terminal path, where delivery goes through `vscode.Terminal.sendText` / `workbench.action.terminal.paste` — an *indirect* channel with clipboard round-trips, focus acquisition retries and IPC hops. `src/services/terminalUtils.ts:50-57` documents exactly that reasoning for its own constants (`PRE_PASTE_SETTLE_MS = 200`, `POST_PASTE_SETTLE_MS()` = 100 local / 300 remote, both already reduced from 800).

The standalone PTY path has none of that indirection: `handle.write()` goes straight to the pty master fd. Nothing needs 2000 ms to settle — the delay only has to cover the CLI's own `/clear` slash-command round trip, which is a local process re-render. The same file already differentiates local from remote for the VS Code path; the PTY path never got the equivalent treatment and simply kept the pessimistic constant.

**Cause 1a — the config surface is larger and more entangled than a "change the default" edit can reach.**

> **Superseded:** *"The default is set in three places that must move together, or the config surface and the code disagree: `src/standalone/bootstrap.ts:193`, `src/services/TaskViewerProvider.ts:2113`, `src/standalone/ptyPromptDelivery.ts:29`."*
> **Reason:** Both line numbers are wrong (`bootstrap.ts:193` is not the read; `TaskViewerProvider.ts:2113` is `getRoleConfig`, not a delay read), and the count is wrong by more than half. `terminal.clearBeforePromptDelay` is read at **eight** sites, and — decisively — they are not all the same *kind* of path. Treating them as one homogeneous set is what makes the naive "move the default to 600" edit both incomplete and unsafe.
> **Replaced with:** the site inventory and the two-regime analysis below.

Verified read sites for `terminal.clearBeforePromptDelay` at HEAD:

| # | Site | Delivery channel | Move to 600? |
| --- | --- | --- | --- |
| 1 | `src/standalone/ptyPromptDelivery.ts:29` — in-function `?? 2000` | **PTY** | ✅ |
| 2 | `src/standalone/bootstrap.ts:199` — `getPromptDeliveryOptions()` | **PTY** | ✅ |
| 3 | `src/services/TaskViewerProvider.ts:2142` — proxy inject for `ptySendPrompt` | **PTY** | ✅ |
| 4 | `src/services/TaskViewerProvider.ts:19427` — `_ptyHostVerb('ptySendPrompt', …)` | **PTY** | ✅ |
| 5 | `src/services/TaskViewerProvider.ts:4883` — Phone-a-Friend, `pasteTextViaClipboard` + `sendRobustText` | **vscode.Terminal** | ❌ |
| 6 | `src/services/TaskViewerProvider.ts:19510` — `handleKanbanBatchTrigger`, clipboard paste + `sendRobustText` | **vscode.Terminal** | ❌ |
| 7 | `src/services/KanbanProvider.ts:464` — `_clearTerminalBeforePromptDelay` cache | **vscode.Terminal** | ❌ |
| 8 | `package.json:322` — contributed `default: 2000` | **both** | ⚠️ see below |

**One key, two latency regimes.** Sites 5–7 are the clipboard/`sendRobustText` path whose indirection is the *original justification* for 2000 ms — the same justification this plan cites to argue the PTY path does not need it. They read the same configuration key. So:

- Lowering the **contributed default** (site 8) to 600 also drops the VS Code path to 600 for every install that never set the value explicitly. On a published extension with ~4,000 installs, that is a silent behaviour change on the path where 2000 was earned, and its failure mode is the destructive one this plan's own edge-case audit names: a truncated prompt the agent then acts on.
- **Not** changing site 8 makes the code edits at sites 2–4 inert. `vscode.workspace.getConfiguration('switchboard').get<number>(key, 600)` returns the *contributed* default (2000) whenever `package.json` declares one; the inline fallback applies only when the setting is entirely undefined. Editing `get(…, 600)` while `package.json` still declares `2000` changes nothing at all.

  **Confirmed by research (2026-08-12).** The VS Code API docs for `WorkspaceConfiguration.get<T>(section, defaultValue)` state the `defaultValue` argument is used *only when no value could be found*. A contributed `"default"` registers a value at the base of the configuration hierarchy, so a value **is** found and the argument is ignored. `WorkspaceConfiguration.inspect(key)` is the supported way to tell an operator-set value from a contributed default: `globalValue` / `workspaceValue` / `workspaceFolderValue` are `undefined` when the operator has not set that scope. Two gotchas this design must respect, both now handled in `resolvePtyClearDelay` below: (a) test `!== undefined`, never truthiness — both keys allow `0`, and an explicit `0` would otherwise read as unset; (b) never infer "unset" by comparing the effective value to `defaultValue` — an operator who explicitly sets the same number as the default is still an operator who set it.

The resolution is a **separate PTY-scoped key**, not a move of the shared one. See Proposed Changes §2.

**Cause 2 — the whole delivery window is silent in the UI.**

`src/webview/terminals.js:3596-3609` (inside `wireTerminalDropTarget`, which opens at `3474`) awaits `POST /terminals/verb/ptySendPrompt`, and the server does not respond until `sendPromptToPty` has fully resolved. So the browser sits inside a single un-awaited-looking `fetch` for the entire clear+chunk+submit window with **no DOM change at all**. There is no spinner, no chip, no disabled state. `showPaneToast` fires only on failure (`terminals.js:3606`) or on success-after-the-fact via `attributeDropDispatch`.

The pane header already has a first-class, single-writer chip mechanism for exactly this class of transient state — `syncInputStateChip` (`terminals.js:3203-3221`), driven by an `is-input-*` class on the pane and rendered into `.pane-title`. Nothing hooks it to dispatch. And the codebase explicitly forbids the tempting alternative of writing a notice into the xterm buffer (`terminals.js:3223-3236`: "Writing a notice into the terminal buffer makes it CONTENT, not chrome ... it corrupts a TUI's screen buffer"). So the chip is the sanctioned home.

### Why these two ship together

They are one interaction, not two. The chip's lifetime is defined by the delivery timeline — shortening the timeline without the chip leaves a still-silent ~800 ms, and adding the chip without shortening the timeline leaves the operator watching a spinner for 3 seconds. Neither half delivers the ask alone.

## Metadata

- **Complexity:** 5
- **Tags:** frontend, backend, ui, ux, performance, reliability
- **Project:** Browser Switchboard
- **Feature:** b34dfbb3-d1f1-406e-ad95-459e38ceef81

## User Review Required

None. The one decision that could have gone to the user — whether to retune the shared `terminal.clearBeforePromptDelay` or introduce a PTY-scoped key — is resolved here in favour of a new key, because retuning the shared one silently changes VS Code-path behaviour on ~4,000 shipped installs. That is a migration-safety call, not a preference.

## Complexity Audit

### Routine

- Lowering the three PTY-only constants in `ptyPromptDelivery.ts` (`CHUNK_DELAY_MS`, submit settle, confirm-Enter settle).
- Adding a `.pane-dispatch-state` CSS rule to `terminals.html` mirroring `.pane-input-state` (822-865), including its density variant.
- Adding the chip element and its create/remove helper in `terminals.js`, modelled 1:1 on `syncInputStateChip` / `refreshInputState`.

### Complex / Risky

- **Choosing the new clear delay.** Too low and the prompt's first bytes are swallowed by the CLI's `/clear` re-render, which is a silent data-loss failure — the agent gets a truncated prompt and starts work on it. Mitigation: keep it configurable, land at 600 ms rather than the theoretical floor, and verify against the slowest-clearing agent available (see Verification Plan).
- **A new shipped setting, not a retuned one.** Introducing `terminal.ptyClearBeforePromptDelay` means the two delivery channels can be tuned independently, which is correct — but it also means an operator who previously set `terminal.clearBeforePromptDelay` to tune the PTY path will find that key no longer steers it. Handled by a fallback: the PTY sites read the new key and fall back to the *explicitly set* old key before falling back to 600. See §2.
- **Chip lifecycle across pane reassignment.** Panes are *reused*, not rebuilt (`updatePaneElement`'s invariant at `terminals.js:3815-3820`). A chip keyed to a pane index rather than to a terminal name would strand on whatever terminal lands in that slot next. The chip must be keyed on the terminal NAME and reconciled in `updatePaneElement`, exactly as `syncInputStateChip` is.
- **Overlap with the existing input-state chip.** Both want the same corner of `.pane-title`. They must not both render; dispatch state wins while it is active. The *ordering* of the two sync calls is load-bearing — see Edge-Case audit items 6 and 7, which correct the naive placement.

## Edge-Case & Dependency Audit

### Race Conditions

1. **Concurrent dispatches to the same terminal.** `withTerminalLock` (`ptyPromptDelivery.ts:9-14`) serialises them, so the second request's response can be seconds late. The chip must be refcounted per terminal (or keyed by an in-flight set), not a boolean, or the first completion clears the second's chip.
2. **The 5s fleet poll runs concurrently with a dispatch.** `updatePaneElement` rebuilds `.pane-title` from scratch on every tick, so the chip is destroyed and must be re-derived from the in-flight map on each render — never left where the previous render put it.
3. **Terminal closed mid-dispatch.** `updatePaneElement` runs on the next fleet poll and finds no entry; the chip must be dropped by the same sanitisation that drops the assignment (`sanitizePaneAssignments`, `terminals.js:1689`).

### Security

4. **No new endpoint, no new payload field.** The chip is driven entirely by the existing `POST /terminals/verb/ptySendPrompt` request/response lifecycle in the browser. The new setting is read host-side only. No CSP change, no new input reaching the DOM as markup.

### Side Effects

5. **Truncated prompt on too-short a clear delay.** The failure is silent and destructive (the agent acts on a partial prompt). The clamp at `ptyPromptDelivery.ts:30` (`Math.min(10000, Math.max(0, delay))`) stays, so an operator can restore 2000 via config without a code change.
6. **Chip call ordering in `updatePaneElement`.**

   > **Superseded:** Reconcile the chip "immediately **after** the existing `syncInputStateChip(paneEl, titleEl, state)` call (`terminals.js:3924`)".
   > **Reason:** Two defects. (a) The line is `3930`, not 3924. (b) More importantly the order is backwards. `syncInputStateChip` is being modified by this plan to early-return when the pane carries `.is-dispatching`. Panes are reused and that class is never cleared by anything else, so on a render where the dispatch has *just ended* — or where the pane has been reassigned to a different terminal — `syncInputStateChip` runs first, sees a stale `.is-dispatching`, and suppresses the input chip. `syncDispatchChip` then removes the class one line later. Net effect: a pane loses its input-state chip for a full poll cycle after every dispatch and after every reassignment.
   > **Replaced with:** Call `syncDispatchChip` **before** `syncInputStateChip`, so the class is authoritative by the time the input chip decides whether to render. DOM order is irrelevant (the two are mutually exclusive by construction), so the swap is free.

7. **Restoring the input chip when a dispatch ends out-of-band.**

   > **Superseded:** `refreshDispatchState(name)` repaints only the dispatch chip.
   > **Reason:** It repaints only the dispatch chip, which is exactly the bug. `endDispatchIndicator` → `refreshDispatchState` → `syncDispatchChip(false)` removes the chip and the class, but nothing re-renders the *input-state* chip that was suppressed while the dispatch was live. The header stays missing its `connecting` / `read-only` / `paste queued` chip until the next 5s poll or the next socket transition — precisely the states the input chip exists to surface.
   > **Replaced with:** `refreshDispatchState` calls `refreshInputState(name)` after syncing the dispatch chip. `refreshInputState` (`terminals.js:3175-3184`) already re-derives the state, re-stamps the `is-input-*` class and calls `syncInputStateChip`, which now correctly sees the cleared `.is-dispatching`. One extra call, no new logic.

8. **`clearBeforePrompt: false` callers must see no chip-stuck state.** `src/standalone/delegation.ts:225` and `terminals.js:7813` both send with `clearBeforePrompt: false`. The chip must be driven by the request/response lifecycle, not by an assumption that a clear happened.
9. **Failed / rejected dispatch.** On a non-2xx or `success:false` the chip must clear before `showPaneToast` fires, or a failure toast sits next to a "dispatching…" chip. Use `finally`, not the success path — a rejected `fetch` must not strand the chip.
10. **Terse layouts.** `isTerseLayout()` (`terminals.js:3811-3813`) returns true for 2x3/3x3, where `syncInputStateChip` collapses the label to a bare dot. The dispatch chip must follow the same rule or it eats the terminal name at density, and it needs the matching CSS density rule (`terminals.html:861-865` is the input chip's equivalent — the original proposal omitted it, leaving a 4px gap beside an empty label).
11. **Shift-drop path is unaffected.** `terminals.js:3583-3590` writes bracketed paste straight down the WebSocket and never calls `ptySendPrompt`. It is already instantaneous; do not add a chip there.
12. **`clearPty` shares the file but not the pacing.** `ptyPromptDelivery.ts:64-70` writes `/clear\r` for the header's `clear` button and has no settle delay at all. It is untouched by this plan; do not "unify" it with the dispatch path, and note the pane button already has its own 600 ms feedback window (`withClearingFeedback`, `terminals.js:6044-6053`).
13. **No confirmation dialogs, no new modal.** Per `CLAUDE.md`, the chip is chrome only.

### Dependencies & Conflicts

14. **Shares `updatePaneElement`'s assigned branch and `terminals.html` with two sibling subtasks.** *Show The CLI Brand Icon In Each Terminal Pane Header* hoists `fleetItem`/`agentLabel` to the top of the same `if (assignedName)` block and prepends an `<img>` to `.pane-title` — which shifts every line number below it, including the `syncInputStateChip` call this plan targets. *Kanban-Mode Pane In terminals.html Cannot Scroll Its Card List* edits `terminals.html:721-722` and `1037-1046`. Per the project PRD's orchestration discipline (*"One agent stream per provider file … the same file serialises"*), these must not be applied concurrently. **This subtask lands last of the three**; re-derive line numbers against the tree rather than trusting the ones written here.
15. **Combined `.pane-title` density.** After all three subtasks land, the header flex row at 3x3 carries: brand icon (12px) + `P<n>` chip + name + optional badge + optional GAP badge + one of {dispatch chip, input chip}. Only `.pane-title-name` shrinks (`terminals.html:993-1001`). Verify the terminal name is still legible at 3x3 with a badge present — this is the one visual outcome no single subtask can verify alone.
16. **`CLI_AGENT_REGEX` is renamed-adjacent, not repurposed.** This plan renames the two bare numeric literals near `ptyPromptDelivery.ts:49-51` into named constants but does **not** touch the regex itself. The sibling subtask *Claude CLI Seats Have No Scrollbar…* explicitly requires that regex be left alone (it needs its own Claude detection rather than repurposing this one). Both constraints hold simultaneously; no conflict.
17. **The webview loads from `dist/`, not `src/`.** Verify against a rebuilt VSIX or the live standalone server.

## Dependencies

- **Sibling subtasks (ordering, same files):** *Kanban-Mode Pane In terminals.html Cannot Scroll Its Card List* and *Show The CLI Brand Icon In Each Terminal Pane Header* both land before this one.
- No external session dependencies.

## Adversarial Synthesis

**Risk summary.** The dominant risk is the clear-delay floor: too aggressive and prompts are silently truncated, and the agent acts on the fragment rather than erroring — so the 600 ms figure must be empirically validated per CLI, not reasoned to. The second risk was structural and is now designed out: `terminal.clearBeforePromptDelay` is one key serving two delivery channels with different physics, so retuning it would have regressed the VS Code clipboard path on ~4,000 shipped installs while — because a contributed default preempts an inline fallback — leaving the PTY code edits inert. Mitigations: a PTY-scoped key with a fallback to an explicitly-set legacy value, the existing 0–10000 clamp retained as the operator escape hatch, a refcounted chip driven from `finally`, and the two sync calls ordered dispatch-before-input so neither chip can strand the other.

## Proposed Changes

### 1. `src/standalone/ptyPromptDelivery.ts` — retune the PTY delivery pacing

```ts
const CLI_AGENT_REGEX = /copilot|gemini|agy|claude|windsurf|cursor|cortex/i;  // UNCHANGED
const CHUNK_SIZE = 256;
// 30ms was inherited from the VS Code sendText path, where each chunk crosses an
// IPC boundary. handle.write() goes straight to the pty master fd — the only
// thing being paced here is the CLI's stdin reader, which keeps up at 8ms.
const CHUNK_DELAY_MS = 8;
// Settle windows. These pace a DIRECTLY-owned pty, not vscode.Terminal.sendText:
// there is no clipboard round trip, no focus acquisition, no extension-host IPC.
// See terminalUtils.ts:50-57 for the indirect path's (already reduced) constants.
// The indirect path keeps 2000ms via terminal.clearBeforePromptDelay — do NOT
// unify the two, they are different physics on the same-named operation.
const DEFAULT_CLEAR_SETTLE_MS = 600;   // was 2000 — covers the CLI's /clear re-render
const SUBMIT_SETTLE_MS = 40;           // was 100
const CONFIRM_ENTER_DELAY_MS = 80;     // was 200
```

and in `sendPromptToPty`:

```ts
        if (opts?.clearBeforePrompt) {
            handle.write('/clear\r');
            const delay = opts.clearBeforePromptDelayMs ?? DEFAULT_CLEAR_SETTLE_MS;
            // Clamp retained: an operator who hits a slow-clearing agent can raise
            // terminal.ptyClearBeforePromptDelay back to 2000 without a code change.
            await new Promise(r => setTimeout(r, Math.min(10000, Math.max(0, delay))));
        }
```

Replace the bare `100` at line 45 with `SUBMIT_SETTLE_MS` and the bare `200` at line 50 with `CONFIRM_ENTER_DELAY_MS`. Leave `clearPty` (64-70) and `modelPty` (78-84) untouched.

### 2. A PTY-scoped delay setting — `switchboard.terminal.ptyClearBeforePromptDelay`

> **Superseded:** Move the default of `switchboard.terminal.clearBeforePromptDelay` from 2000 to 600 in `bootstrap.ts`, `TaskViewerProvider.ts` and `package.json`.
> **Reason:** That key is read by both the PTY path and the `vscode.Terminal` clipboard path (sites 5–7 in the table above), and only the PTY path is fast. Moving the shared contributed default silently drops the clipboard path — where 2000 ms was earned by real indirection — for every install that never set the value, on a published extension with ~4,000 installs. And moving only the code defaults without `package.json` is a no-op, because a contributed default preempts `get(key, fallback)`'s second argument.
> **Replaced with:** Introduce a PTY-scoped key. The shared key and its 2000 ms contributed default are left **exactly as they are**, so the VS Code path is byte-for-byte unchanged.

Register in `package.json`'s configuration contribution, beside the existing pair at 315-326:

```json
        "switchboard.terminal.ptyClearBeforePromptDelay": {
          "type": "number",
          "default": 600,
          "minimum": 0,
          "maximum": 10000,
          "description": "Milliseconds to wait after sending /clear before dispatching the prompt to a directly-owned PTY seat (the browser cockpit's terminal grid and the standalone host). Lower than terminal.clearBeforePromptDelay because a PTY write goes straight to the pty master fd with no clipboard round trip, focus acquisition or extension-host IPC. VS Code terminal seats continue to use terminal.clearBeforePromptDelay."
        }
```

Resolution helper — used by every PTY-path site so the fallback rule exists once:

```ts
/**
 * PTY clear-settle delay. Falls back to an EXPLICITLY SET legacy
 * terminal.clearBeforePromptDelay before the new default, so an operator who
 * tuned that key to steer PTY dispatch before this key existed keeps their
 * value. `inspect()` (not `get()`) is what distinguishes "operator set 2000"
 * from "contributed default is 2000" — get() cannot tell them apart, which is
 * the same trap that made the naive version of this change inert.
 *
 * `!== undefined`, NEVER a truthy check. Both keys declare `minimum: 0`, and an
 * operator who deliberately sets 0 (no settle at all — a fast local CLI) would be
 * read as "unset" by `if (value)` and silently given 600 instead. Same trap for a
 * legacy 0. This is the documented inspect() gotcha for falsy scope values.
 */
function explicitScopeValue<T>(i: { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined): T | undefined {
    // ?? chaining is correct here (it falls through only on null/undefined, so an
    // explicit 0 at folder scope still wins over a global value); the outer
    // undefined-check is what must not be a truthy test.
    return i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue;
}

function resolvePtyClearDelay(cfg: vscode.WorkspaceConfiguration): number {
    const scoped = explicitScopeValue(cfg.inspect<number>('terminal.ptyClearBeforePromptDelay'));
    if (scoped !== undefined) { return scoped; }
    const legacy = explicitScopeValue(cfg.inspect<number>('terminal.clearBeforePromptDelay'));
    if (legacy !== undefined) { return legacy; }
    return cfg.get<number>('terminal.ptyClearBeforePromptDelay', 600);
}
```

Apply at the four PTY sites, and **only** those four:

- `src/services/TaskViewerProvider.ts:2142` — the `ptySendPrompt` proxy inject.
- `src/services/TaskViewerProvider.ts:19427` — the `_ptyHostVerb('ptySendPrompt', …)` call.
- `src/standalone/bootstrap.ts:199` — `getPromptDeliveryOptions()`; the standalone host reads through `configProvider`, so mirror the same fallback shape with `getConfigNumber('terminal.ptyClearBeforePromptDelay', …)` guarded on an explicitly-set legacy value.
- `src/standalone/ptyPromptDelivery.ts:29` — the in-function backstop, now `DEFAULT_CLEAR_SETTLE_MS`.

**Do not touch** `TaskViewerProvider.ts:4883`, `TaskViewerProvider.ts:19510`, or `KanbanProvider.ts:464`. Those are the `vscode.Terminal` clipboard path and keep 2000 ms.

### 3. `src/webview/terminals.js` — a dispatch chip driven by the request lifecycle

Add an in-flight refcount map beside the other per-terminal state maps, plus a sync helper mirroring `syncInputStateChip`:

```js
    // terminalName -> count of ptySendPrompt requests currently in flight.
    // A COUNT, not a boolean: withTerminalLock (ptyPromptDelivery.ts:9) serialises
    // concurrent sends to one terminal, so the first response can land while a
    // second is still queued — a boolean would clear the chip early.
    const dispatchInFlight = new Map();

    function beginDispatchIndicator(name) {
        dispatchInFlight.set(name, (dispatchInFlight.get(name) || 0) + 1);
        refreshDispatchState(name);
    }

    function endDispatchIndicator(name) {
        const next = (dispatchInFlight.get(name) || 1) - 1;
        if (next <= 0) { dispatchInFlight.delete(name); } else { dispatchInFlight.set(name, next); }
        refreshDispatchState(name);
    }

    /** Repaint the dispatch chip for `name`, then hand the header back to the
     *  input-state chip. Never renderPaneGrid() — a grid rebuild reparents live
     *  xterm DOM, which updatePaneElement's invariant forbids for a purely visual
     *  change (terminals.js:3815-3820).
     *
     *  The refreshInputState() tail is NOT optional. syncInputStateChip early-returns
     *  while .is-dispatching is set, so when a dispatch ends, removing the dispatch
     *  chip leaves the header with NO chip at all — the connecting / read-only /
     *  paste-queued states stay invisible until the next 5s poll or socket
     *  transition. refreshInputState re-derives and repaints them immediately. */
    function refreshDispatchState(name) {
        const paneIndex = paneAssignments.indexOf(name);
        if (paneIndex < 0) { return; }
        const paneEl = paneGridEl && paneGridEl.querySelector(`.terminal-pane[data-pane-index="${paneIndex}"]`);
        if (!paneEl) { return; }
        syncDispatchChip(paneEl, paneEl.querySelector('.pane-title'), dispatchInFlight.has(name));
        refreshInputState(name);
    }

    /** Single writer for the chip, same contract as syncInputStateChip: creates,
     *  updates AND removes, because both call sites are routinely handed a pane
     *  with no chip to repaint. */
    function syncDispatchChip(paneEl, titleEl, active) {
        let chip = paneEl.querySelector('.pane-dispatch-state');
        if (!active) {
            if (chip) { chip.remove(); }
            paneEl.classList.remove('is-dispatching');
            return;
        }
        paneEl.classList.add('is-dispatching');
        if (!chip) {
            const host = titleEl || paneEl.querySelector('.pane-title');
            if (!host) { return; }
            chip = document.createElement('span');
            chip.className = 'pane-dispatch-state';
            host.appendChild(chip);
        }
        // Terse layouts get the animated dot alone — isTerseLayout(), not an inline
        // copy of the layout list, for the same reason syncInputStateChip uses it.
        chip.textContent = isTerseLayout() ? '' : 'dispatching…';
        chip.title = 'Clearing the agent and pasting the prompt';
    }
```

Wrap the dispatch in `wireTerminalDropTarget` (`terminals.js:3596-3609`) so the chip covers the whole server round trip:

```js
                    beginDispatchIndicator(targetName);
                    let promptResult;
                    try {
                        const promptRes = await fetch('/terminals/verb/ptySendPrompt', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name: targetName, data: promptText })
                        });
                        promptResult = await promptRes.json();
                    } finally {
                        // finally, not the success path: a rejected fetch must not
                        // strand the chip, and the failure toast below must never
                        // appear beside a live "dispatching…".
                        endDispatchIndicator(targetName);
                    }
                    if (!promptResult || !promptResult.success) {
                        showPaneToast('Failed to send prompt: ' + ((promptResult && promptResult.error) || 'unknown'));
                        return;
                    }
                    attributeDropDispatch(targetName, ids, workspaceRoot);
```

Reconcile the chip in `updatePaneElement`'s assigned branch — **before** the existing `syncInputStateChip` call (currently `terminals.js:3928-3930`, and shifted downward by the brand-icon subtask; locate it by the `resolveInputState(assignedName)` line, not by number):

```js
            const state = resolveInputState(assignedName);
            paneEl.classList.add(`is-input-${state.key}`);
            // Dispatch chip FIRST: syncInputStateChip early-returns while
            // .is-dispatching is set, and panes are reused, so a stale class from a
            // finished dispatch (or from the pane's previous occupant) would
            // suppress the input chip for a whole poll cycle if the order were
            // reversed. DOM order does not matter — the two are mutually exclusive.
            syncDispatchChip(paneEl, titleEl, dispatchInFlight.has(assignedName));
            syncInputStateChip(paneEl, titleEl, state);
```

Drop stale entries in `sanitizePaneAssignments` (`terminals.js:1689`), beside the existing stale-slot loop:

```js
        for (const name of Array.from(dispatchInFlight.keys())) {
            if (!liveNames.has(name)) { dispatchInFlight.delete(name); }
        }
```

Suppress the input-state chip while dispatching so the two never both render — in `syncInputStateChip` (`terminals.js:3203`):

```js
    function syncInputStateChip(paneEl, titleEl, state) {
        let chip = paneEl.querySelector('.pane-input-state');
        // The dispatch chip owns this corner while it is up. Two chips in a
        // 3x3 header ellipsise the terminal name away entirely.
        if (state.key === 'live' || paneEl.classList.contains('is-dispatching')) {
            if (chip) { chip.remove(); }
            return;
        }
        ...
```

### 4. `src/webview/terminals.html` — chip styling and the pulse

Add beside `.pane-input-state` (currently 822-865):

```css
        /* Dispatch-in-progress chip. Mirrors .pane-input-state's box so the two
           cannot disagree on metrics; they are mutually exclusive by construction
           (syncInputStateChip early-returns while .is-dispatching is set). */
        .pane-dispatch-state {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            font-size: 9px;
            font-weight: 600;
            letter-spacing: 0.4px;
            text-transform: lowercase;
            padding: 0 4px;
            border-radius: 2px;
            flex-shrink: 0;
            color: var(--accent-teal);
        }
        .pane-dispatch-state::before {
            content: '';
            width: 5px; height: 5px;
            border-radius: 50%;
            background: currentColor;
            flex-shrink: 0;
            animation: sb-dispatch-pulse 900ms ease-in-out infinite;
        }
        /* Dot-only in the two dense layouts, matching .pane-input-state (861-865).
           Without this the 4px gap survives an empty label and the chip reserves
           width for text that isTerseLayout() has already removed. */
        .pane-grid.layout-2x3 .pane-dispatch-state,
        .pane-grid.layout-3x3 .pane-dispatch-state {
            padding: 0 2px;
            gap: 0;
        }
        /* The panel already honours a reduced-motion / animation-disabled body
           class elsewhere; a static dot still reads as "in progress". */
        body.cyber-animation-disabled .pane-dispatch-state::before { animation: none; }
        @media (prefers-reduced-motion: reduce) {
            .pane-dispatch-state::before { animation: none; }
        }
        @keyframes sb-dispatch-pulse {
            0%, 100% { opacity: 0.35; }
            50%      { opacity: 1; }
        }
```

## Uncertain Assumptions

The user was advised to run web research on the assumptions in this plan. One remains open.

1. **Slash-command re-render timing for the target CLIs** — whether 600 ms reliably covers the `/clear` round trip for Claude Code, Gemini CLI and Codex CLI on a directly-owned PTY. No published figure was found; this is validated empirically in Verification step 1, which is the real gate. If any CLI's prompt head is swallowed, raise `DEFAULT_CLEAR_SETTLE_MS` in 200 ms steps rather than lowering it toward a theoretical floor.

*(Resolved by research on 2026-08-12 and folded into the design above: VS Code's contributed-default-vs-`get()`-fallback resolution, and `inspect()` as the supported operator-set test. See Cause 1a.)*

## Verification Plan

1. **Timing floor is safe (the destructive case).** With the extension/standalone host running, dispatch a long plan prompt (>2 KB) to a live `claude` PTY seat and to one other CLI seat. Read the terminal's own echoed prompt and confirm the FIRST characters of the prompt are present — a swallowed head is the failure mode. Repeat 5× per agent. If any head is lost, raise `DEFAULT_CLEAR_SETTLE_MS` in 200 ms steps and re-run.
2. **Measured improvement.** Time the `fetch` in the browser console (`performance.now()` either side of the `ptySendPrompt` call). Expect the round trip to fall from ~2.4 s to ~0.75 s for a typical prompt. Record both numbers.
3. **The new key actually steers the PTY path.** Set `switchboard.terminal.ptyClearBeforePromptDelay` to `3000`, dispatch, and confirm the round trip lengthens correspondingly. This is the direct test of the contributed-default trap: if the timing does not move, the config read is being preempted and §2 is wrong.
4. **The VS Code path is untouched.** With no settings changed, trigger a board-driven dispatch to a `vscode.Terminal` seat (`handleKanbanBatchTrigger`) and confirm its `/clear` settle is still ~2000 ms. This is the ~4,000-install regression guard.
5. **Legacy-value fallback.** With `ptyClearBeforePromptDelay` unset, explicitly set `terminal.clearBeforePromptDelay` to `1500`. Confirm the PTY dispatch uses 1500 (an operator who tuned the old key keeps their intent), and that clearing that setting returns the PTY path to 600 while the VS Code path returns to 2000.
6. **Chip appears and clears.** Drag a card onto a pane; confirm `dispatching…` with a pulsing dot appears in the pane header within one frame and disappears when the prompt lands. Confirm the pane's terminal name is still readable.
7. **Input chip returns immediately after a dispatch.** Dispatch to a seat whose socket is `connecting` or whose PTY has exited. The moment the dispatch chip clears, the `connecting` / `read-only` chip must be present — **not** after the next 5s poll. This is the direct test of the `refreshInputState` tail in `refreshDispatchState`.
8. **Chip in terse layouts.** Switch to 3x3; confirm the chip renders as a bare pulsing dot with the tooltip intact, no residual gap, and the terminal name is not ellipsised away.
9. **Failure path.** Stop the target PTY, then dispatch. Confirm the chip clears BEFORE the failure toast renders, and no chip is left behind.
10. **Concurrent dispatch.** Drop two different cards on the same pane in quick succession. Confirm the chip stays up until the SECOND completes (refcount), then clears once.
11. **Pane reuse.** Start a dispatch, then immediately unassign the pane and assign a different terminal into the same slot. Confirm the new terminal's header shows no dispatch chip **and does show its own input-state chip on the very first render** (the ordering fix), and that the original terminal's chip re-appears if it is re-seated before the dispatch completes.
12. **`clearBeforePrompt: false` path untouched.** Trigger a delegate dispatch (`src/standalone/delegation.ts:225`) and a link message (`terminals.js:7813`); confirm no `/clear` is written and no chip is stranded.
13. **Shift-drop unchanged.** Shift-drag a card onto a pane; confirm the prompt is pasted unsubmitted with no chip and no delay.
14. **Combined header density.** With all three `terminals.html` subtasks landed, view a 3x3 grid with a badge-carrying seat mid-dispatch. Confirm brand icon + `P<n>` + name + badge + dispatch dot all fit and the name is still legible.

### Automated Tests

- **`src/test/pty-route-surface-contract.test.js`** already asserts the exact shape of the three `ptySendPrompt` delivery arms and the `clearBeforePrompt` resolution logic (see its `all three ptySendPrompt delivery paths honour an EXPLICIT clearBeforePrompt` case). Extend it with a **site-partition assertion**: `TaskViewerProvider.ts:4883`, `TaskViewerProvider.ts:19510` and `KanbanProvider.ts:464` must continue to read `terminal.clearBeforePromptDelay`, while the `ptySendPrompt` arms must read `terminal.ptyClearBeforePromptDelay`. That partition is the whole safety argument of §2 and is a genuine property of the source text.
- **`package.json` contribution assertion:** `switchboard.terminal.clearBeforePromptDelay` still declares `default: 2000`. A future "cleanup" that harmonises the two keys would silently reintroduce the shipped-install regression; this pins it.
- **Regression suites to run before merge** (not run during planning, per session directive): `pty-route-surface-contract.test.js`, plus the `terminals.html`/`terminals.js`-reading contract tests — `terminal-chrome-not-in-buffer.test.js` (asserts no notice is written into the terminal buffer — directly relevant, since the chip is the sanctioned alternative), `terminal-focus-affordance-contract.test.js`, `terminal-pane-pinning-contract.test.js`.

## Recommendation

**Complexity 5 → Send to Coder.** Seven files across both hosts plus a new shipped setting, with a genuine migration-safety constraint (one config key serving two delivery channels on ~4,000 installs) and two chip-lifecycle orderings that are wrong in the obvious implementation. The individual edits are small; the coordination and the config partition are what carry the risk.

---

## Completion report (2026-08-13)

Implemented across six files: `ptyPromptDelivery.ts` (`CHUNK_DELAY_MS` 30→8, `SUBMIT_SETTLE_MS` 100→40, new `DEFAULT_CLEAR_SETTLE_MS` 600 replacing the `?? 2000` backstop, clamp retained), `package.json` (new `switchboard.terminal.ptyClearBeforePromptDelay` at 600; legacy key untouched at 2000), `TaskViewerProvider.ts` and `bootstrap.ts` (the `resolvePtyClearDelay` / `explicitScopeValue` pair, plus a NaN-sentinel standalone equivalent), and `terminals.js` / `terminals.html` (refcounted `dispatchInFlight` map, `syncDispatchChip` called before `syncInputStateChip`, `refreshDispatchState` tailing `refreshInputState`, `try`/`finally` around the drop fetch, and the `.pane-dispatch-state` chip with its pulse and reduced-motion guards).

**This plan's eight-site inventory was stale and materially wrong, and was re-derived against the tree before coding.** Two sites it never saw: a *second* config read inside `handlePtyVerb`'s `ptySendPrompt` block (the `else if (payload.clearBeforePrompt === undefined)` branch — both branches are PTY-channel and both were moved; moving only the one this plan lists would have left part of the path on 2000 ms with every check green), and `KanbanProvider.updateClearTerminalBeforePromptDelay`, which is not a read at all but a **writer** that persists the legacy key at global scope. That writer has a consequence this plan did not anticipate and which is now documented above `resolvePtyClearDelay`: on any install where the operator has ever moved the delay slider, `inspect().globalValue` is set, the legacy branch fires, and the PTY path inherits their old value instead of 600 — so those installs see no latency improvement. The final partition is five PTY reads on the new key, three `vscode.Terminal` reads left at 2000, and the writer untouched.

One instruction in §1 could not be followed as written: the bare `200` confirm-Enter literal does not exist in the current file. Prior work had already replaced the framed-chunk delivery with the `_sendRobustTextBackground` port, which deletes both `CLI_AGENT_REGEX` and the second confirm CR on the theory that a bracketed paste is submitted with one `\r`. It was not reintroduced. **Open risk, unrelated to this change but adjacent to it:** that deletion removes the second Enter for *every* CLI, and the confirm-Enter allowlist it replaced was the reason Claude seats never exhibited the "text lands but never submits" symptom that unlisted CLIs (devin, jules, codex, qwen and nine others) do. Verification step 1 — the empirical 600 ms floor against a live CLI — remains unrun, as does the rest of the manual plan, per this dispatch's SKIP TESTS / SKIP COMPILATION directives.

**Update, same day — the open risk above is closed.** The confirm CR was restored in `sendPromptToPty` as a separate follow-up, **unconditional**: no regex, no allowlist, no role check. `CLI_AGENT_REGEX` was not reintroduced, and `CONFIRM_ENTER_DELAY_MS` is 200 rather than the 80 §1 proposed, because that delay waits on the CLI's own re-render, which owning the pty master fd does not accelerate. `terminalUtils.ts` — its newline flattening, its gate, and the whole `vscode.Terminal` path — was deliberately left untouched: flattening genuinely needs the shell-vs-TUI distinction, since collapsing newlines mangles a multi-line payload with no visible signal, unlike a stray Enter into a shell. The mechanism remains open and is recorded as such in the code: why one `\r` suffices on `terminalUtils.ts`'s clipboard branch (which pastes, sends one Enter, returns, and ships) but not on the PTY path is **not** established; `scripts/capture-cli-modes.js` against a devin seat is how to settle it.

## Review Findings (2026-08-14)

The config partition is correct and was re-verified against the tree: five PTY-channel reads resolve `terminal.ptyClearBeforePromptDelay` (`ptyPromptDelivery.ts` `DEFAULT_CLEAR_SETTLE_MS`, `TaskViewerProvider.ts:2315/2321/19781`, `bootstrap.ts:209`) while the three `vscode.Terminal` sites (`TaskViewerProvider.ts:5114/19864`, `KanbanProvider.ts:481`) keep the legacy key at 2000 and the KanbanProvider writer is untouched; `inspect()` with `!== undefined` handles an explicit 0 correctly, and the standalone NaN-sentinel equivalent behaves the same (a garbage value falls through to the legacy key, then 600). The chip wiring matches the two corrected orderings — `syncDispatchChip` before `syncInputStateChip`, `refreshDispatchState` tailing `refreshInputState`, `endDispatchIndicator` in a `finally`, refcounted `Map`, pruned in `sanitizePaneAssignments` — and the `clearBeforePrompt: false` and shift-drop paths are correctly chipless. Two fixes applied: one latent class leak (`updatePaneElement`'s empty branch wiped the chip element but left `.is-dispatching` on the reused pane — inert today, wrong the moment a rule keys off it), and the plan's unimplemented `### Automated` items, now added to the CI-invoked `pty-route-surface-contract.test.js` as a site-partition assertion plus `package.json` pins on both defaults (2000 legacy / 600 PTY). Verification: `tsc -p tsconfig.test.json` clean, 16 of 17 terminal/pty contract suites pass, and all PRD gates pass except `mirror:check`, which is red at HEAD on `delegates/SKILL.md` and unrelated to this subtask. Remaining risk is the plan's one open assumption, unchanged: the 600 ms floor is still empirically unvalidated against a live CLI, and a swallowed prompt head is silent and destructive — Verification step 1 remains the real gate.
