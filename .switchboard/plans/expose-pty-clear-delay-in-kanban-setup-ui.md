# Expose PTY clear-before-prompt delay in the kanban setup UI

## Goal

The kanban board's "Terminal Context" setup section has a "Clear before prompt" toggle and a single delay slider (0–10000ms, default 2000). That slider controls `terminal.clearBeforePromptDelay`, which **only applies to VS Code terminal seats** — the indirect clipboard/focus/IPC path in `terminalUtils.ts`.

A **second, separate delay** — `terminal.ptyClearBeforePromptDelay` (default 600ms) — governs the **PTY fleet seats** (the browser cockpit's terminal grid and the standalone host). That path writes straight to the pty master fd with no clipboard round trip, so it needs far less settle time. It is contributed in `package.json` but **not exposed anywhere in the kanban UI** — an operator must edit `settings.json` by hand to tune it.

### Problem & root cause

When dispatching primarily to PTY fleet terminals (the user's case), moving the kanban slider does nothing visible — the PTY path is on its own 600ms default that the UI never touches. The `resolvePtyClearDelay` resolver in `TaskViewerProvider.ts` honors an *explicitly-set* legacy `clearBeforePromptDelay` for the PTY path (respect-operator-intent), but the contributed default of 2000ms does **not** flow through — `inspect()` distinguishes "you set 2000" from "the default is 2000." So an operator who never touched the legacy key before the split sees the PTY path sit at 600ms regardless of the slider.

### Why two delays (not one)

The code explicitly warns against unifying: *"The indirect path keeps 2000ms via terminal.clearBeforePromptDelay — do NOT unify the two, they are different physics on the same-named operation."* (`ptyPromptDelivery.ts:10-13`). VS Code terminals need ~2000ms (clipboard round trip + focus acquisition + extension-host IPC); PTY writes go straight to the master fd and only need ~600ms. Unifying would either over-wait PTY terminals or under-wait VS Code terminals.

### Solution

Expose **both** delays in the kanban setup UI, each independently tunable and clearly labeled. The existing slider is relabeled "VS Code terminals"; a new slider is added for "PTY fleet / browser" seats. Both are gated by the same shared "Clear before prompt" toggle (the toggle controls *whether* `/clear` is sent at all, on both paths).

## Metadata

**Complexity:** 3
**Tags:** frontend, ui, ux, backend
**Project:** Browser Switchboard

## Affected files

| File | Change |
|------|--------|
| `src/webview/kanban.html` | Add second delay input (PTY), JS state var, event wiring, message handling; relabel existing delay input |
| `src/services/KanbanProvider.ts` | Add `_clearTerminalBeforePromptPtyDelay` field, load from config, new message handler, push PTY delay to webview, persist |
| `package.json` | Update `terminal.clearBeforePromptDelay` description to clarify "VS Code terminal seats only" |
| `protocol-catalog.json` | Register new `updateClearTerminalBeforePromptPtyDelay` verb and `clearTerminalBeforePromptPtyDelayState` push |

## Implementation

### 1. Backend — `KanbanProvider.ts`

**1a. New state field** (near line 309, next to `_clearTerminalBeforePromptDelay`):
- Add `private _clearTerminalBeforePromptPtyDelay: number;`

**1b. Load from config** (near line 538, next to the existing delay load):
- Load from `terminal.ptyClearBeforePromptDelay`, clamped 0–10000, default 600.
- Use the same `Math.min(Math.max(...), 10000)` clamp pattern as the existing delay.

**1c. Push to webview** — extend the existing `clearTerminalBeforePromptState` push (lines 2380, 4091, 10251) to include `ptyDelay: this._clearTerminalBeforePromptPtyDelay` alongside the existing `delay` field. This avoids adding a separate push message for the initial load — both delays arrive in one state blob.

**1d. New message handler** — add `case 'updateClearTerminalBeforePromptPtyDelay':` (mirroring `updateClearTerminalBeforePromptDelay` at line 10258):
- Clamp to 0–10000.
- Set `this._clearTerminalBeforePromptPtyDelay`.
- `_markConfigDirty()`.
- Persist via `_seams().pathConfig.updateConfigGlobal('terminal.ptyClearBeforePromptDelay', clamped)`.
- Push `clearTerminalBeforePromptPtyDelayState` back to the webview (mirrors the existing `clearTerminalBeforePromptDelayState` push at line 10270).

### 2. Webview — `kanban.html`

**2a. JS state** (near line 6221):
- Add `let clearTerminalBeforePromptPtyDelay = 600;`

**2b. UI — second delay input** (in the `clear-delay-container` div, ~line 3135):
- Restructure the container to hold two labeled rows:
  - Row 1: label "VS Code terminals:" + the existing `clear-terminal-delay-input` (unchanged id, unchanged 0–10000/step 100/default 2000).
  - Row 2: label "PTY fleet / browser:" + new `clear-terminal-pty-delay-input` (0–10000, step 100, default 600).
- Keep the container's show/hide bound to the existing toggle (`clearTerminalBeforePrompt`).

**2c. Update `updateClearTerminalBeforePromptUi()`** (line 7467):
- After setting the existing `delayInput.value`, also set `clear-terminal-pty-delay-input.value` to `String(clearTerminalBeforePromptPtyDelay)`.

**2d. Message handling** (line 10764):
- In the `clearTerminalBeforePromptState` case: read `msg.ptyDelay` into `clearTerminalBeforePromptPtyDelay` (alongside the existing `msg.delay`).
- Add a new `clearTerminalBeforePromptPtyDelayState` case that updates `clearTerminalBeforePromptPtyDelay` and the PTY delay input element (mirrors the existing `clearTerminalBeforePromptDelayState` case at line 10772).

**2e. Event wiring** (after line 11573):
- Add a `change` listener on `clear-terminal-pty-delay-input` that clamps 0–10000, updates `clearTerminalBeforePromptPtyDelay`, and posts `{ type: 'updateClearTerminalBeforePromptPtyDelay', delay: clamped }`. Exact mirror of the existing `clear-terminal-delay-input` listener at line 11565.

### 3. Settings descriptions — `package.json`

- Update `terminal.clearBeforePromptDelay` description (line 338) to append: "Applies to VS Code terminal seats only. PTY fleet seats use terminal.ptyClearBeforePromptDelay."
- The `terminal.ptyClearBeforePromptDelay` description (line 345) already documents the split — no change needed.
- Update the toggle description (line 331) to mention both delays are configurable.

### 4. Protocol catalog — `protocol-catalog.json`

- Add `updateClearTerminalBeforePromptPtyDelay` to the kanban verb list (near line 184) and the verb-detail section (near line 418, with `line` pointing to the new handler).
- Add `clearTerminalBeforePromptPtyDelayState` to the push-message registry (near line 7492), with `payloadKeys: ["type", "delay"]`.
- Add `ptyDelay` to the `clearTerminalBeforePromptState` payloadKeys (line 7499 area).

## Edge cases & constraints

- **Shared toggle:** The "Clear before prompt" boolean (`terminal.clearBeforePrompt`) gates *whether* `/clear` is sent on both paths. Both delay inputs are shown/hidden by this single toggle. No second toggle needed.
- **Respect-operator-intent fallback preserved:** `resolvePtyClearDelay` in `TaskViewerProvider.ts` still falls back to an explicitly-set legacy `clearBeforePromptDelay` when `ptyClearBeforePromptDelay` is unset. Once the operator sets the PTY delay via the new UI, `ptyClearBeforePromptDelay` is explicitly set and the legacy fallback is preempted. No change to the resolver.
- **Standalone host:** The standalone host (`bootstrap.ts`) reads `terminal.ptyClearBeforePromptDelay` from `.switchboard/config.json` via its own `configProvider`, NOT from VS Code's settings.json. The kanban UI persist writes to VS Code config, so the standalone host will not pick up a change made in the VS Code kanban board. This is acceptable for the user's primary use case (browser cockpit PTY fleet, which runs in the VS Code extension context and reads via `resolvePtyClearDelay` → VS Code config). The standalone host operator edits `.switchboard/config.json` directly, as today.
- **sc-/mc- mirror toggles:** The `sc-clear-terminal-before-prompt-toggle` and `mc-clear-terminal-before-prompt-toggle` only mirror the boolean toggle — they have no delay inputs. No change needed there; `updateClearTerminalBeforePromptUi` already handles them and will continue to.
- **No confirmation dialogs** (per project rules). The delay inputs apply on `change`, same as the existing slider.

## Verification plan

1. **Build:** `npm run compile` — no type errors.
2. **UI check:** Open the kanban board → setup → Terminal Context. Enable "Clear before prompt." Confirm two delay rows appear: "VS Code terminals" (default 2000) and "PTY fleet / browser" (default 600). Both gated by the toggle.
3. **Persist round-trip:** Change the PTY delay to 900. Reload the board. Confirm the PTY delay field shows 900. Check VS Code settings.json has `terminal.ptyClearBeforePromptDelay: 900`.
4. **Live dispatch:** Dispatch a plan to a PTY fleet terminal with "Clear before prompt" on. Confirm the `/clear`-to-prompt settle delay matches the PTY delay value set in the UI (use console timing or observable cadence).
5. **Independence:** Change the VS Code delay to 5000. Confirm the PTY delay field is unaffected (still 900). Change the PTY delay to 300. Confirm the VS Code delay field is unaffected.
6. **Existing tests:** Run `npm test` — the `pty-route-surface-contract.test.js` partition assertion (which checks `resolvePtyClearDelay` exists and uses `inspect()` for both keys) must still pass. No resolver changes, so this is a regression guard only.
