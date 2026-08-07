# Add a Memo Pane Mode to the Terminals Grid, Alongside Kanban Mode

## Goal

An empty pane in the Terminals grid can already be repurposed as a live kanban column viewer. Add the same affordance for the **memo**: an empty slot can become a memo pad — type entries, they auto-save to `.switchboard/memo.md`, and one button sends the batch to the Planner. So the operator can capture an observation without leaving the terminal cockpit or switching panels.

### Problem analysis and root cause

The memo lives in its own top-level panel (`src/webview/memo.html` + `memo.js`, served at `/memo` — `LocalApiServer.ts:3681` — and reached via the rail icon). The Terminals panel occupies the whole viewport when you are driving agents, so capturing a thought means leaving the grid, losing the pane layout from view, typing, and coming back. During a coding session that friction is exactly when observations are worth capturing and exactly when nobody wants to navigate away.

The pane grid was built with a mode dimension precisely so a dead slot can be repurposed:

- `paneModes` (`src/webview/terminals.js:26`) is a per-slot `'terminal' | 'kanban'` array, persisted to the `terminals.paneModes` setting (`terminals.js:772`).
- `renderKanbanPane` (`terminals.js:2565`) replaces the terminal viewport with a board-column viewer, driven from `updatePaneElement`'s early return (`terminals.js:2268`).
- Two entry points exist: the toolbar button `#btn-kanban-toolbar` → `toggleFocusedPaneKanban` (`terminals.js:2884`) and the empty-slot `.pane-mode-toggle` button, whose click is delegated from `createPaneElement` (`terminals.js:2213-2223`).

So the mechanism is there and the memo has no seat in it. The root cause is simply that `paneModes` was written with exactly two values and every consumer hardcodes `=== 'kanban'` rather than "is a non-terminal mode". Adding a third mode is mostly the work of turning those literal comparisons into intent-named predicates.

### Backend: nothing to build

The memo verbs are already reachable over HTTP from a browser panel. `POST /memo/verb/<verb>` routes to `_handlePlanningVerb` (`src/services/LocalApiServer.ts:3558-3560`), and `PlanningPanelProvider.handleServiceVerb` explicitly delegates `memoLoad` / `memoSave` / `memoClear` / `memoGeneratePrompt` / `memoListWorkspaces` to `TaskViewerProvider` (`src/services/PlanningPanelProvider.ts:116-122`) because those verbs are catalogued in `TASKVIEWER_VERBS`, not `PLANNING_VERBS`. The handlers are file I/O plus planner dispatch (`src/services/TaskViewerProvider.ts:12640-12786`). Their schemas (`src/services/verbSchemas.ts:1553-1576`) make every field **optional**, so a payload that omits `workspaceRoot` validates fine. `terminals.js` already calls verbs by raw `fetch()` (e.g. `/kanban/verb/getBoardCards`), so it can call these the same way. **No new verb, no catalog regeneration, no schema change.**

### One deliberate omission: no Copy button

`memoGeneratePrompt` returns the built prompt in its body **only on failure** — on success it writes the host clipboard and deliberately omits `prompt` so `transport.js` cannot clobber the browser clipboard (`TaskViewerProvider.ts:12781-12784`). A browser-side Copy button would therefore have nothing to copy. The memo pane offers **Send to Planner** (which dispatches and clears) and **Clear**; Copy stays a memo-panel-only action. This is a decision, not a gap — the pane's purpose is capture-and-dispatch without leaving the grid.

### Line references

All `terminals.js`, `terminals.html`, `memo.js` and `src/services/*.ts` line numbers in this plan were **re-verified against HEAD on 2026-08-07**. A previous revision carried `terminals.js` references that had drifted by roughly 39 lines (the file has grown since the plan was first written). The corrected numbers are used throughout. Treat symbol names as the durable anchor and line numbers as a convenience — re-grep before editing.

## Metadata

**Complexity:** 6
**Tags:** frontend, ui, ux, feature
**Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine
- `renderMemoPane(paneEl, index)` — a textarea, a workspace `<select>`, two buttons, a status line, and the existing `Terminal` toggle button. Structurally the same shape as `renderKanbanPane`.
- Five `fetch()` calls to already-live endpoints (`memoListWorkspaces`, `memoLoad`, `memoSave`, `memoClear`, `memoGeneratePrompt`).
- A second `.pane-mode-toggle` button in the empty-slot placeholder, plus a wrapper so the two toggles sit side by side.
- CSS in `terminals.html`.

### Complex / Risky
- **Widening `paneModes` from two values to three.** Every `=== 'kanban'` / `!== 'kanban'` site must be classified as either "is this slot showing a board?" (stays kanban-specific: the poll loop, `fetchBoardCardsForPane` and its post-response re-check, the column picker) or "is this slot unavailable for a terminal?" (becomes mode-agnostic: seating, `isFree`, `fillEmptyPanes`, the drag-drop target guard, the displacement scan). Misclassifying one is a real bug: a memo pane silently bulldozed by Open All, or a memo pane fed board cards. **The full site list is enumerated in Proposed Changes §1 — an earlier revision's table omitted five of them, including the one that causes silent data loss (`toggleFocusedPaneKanban`).**
- **The persistence normaliser is a whitelist.** `paneModes = savedModes.map(m => m === 'kanban' ? 'kanban' : 'terminal')` (`terminals.js:751`) rewrites anything unknown to `'terminal'`. Forget it and memo mode never survives a reload — and the failure is silent.
- **Unsaved text vs. pane teardown.** `renderPaneGrid` (`terminals.js:1913`) reconciles panes on layout change; `updatePaneElement`'s terminal path clears `contentEl`. A debounced save that has not fired yet loses the operator's typing. The memo panel solves this by flushing before a workspace switch (`memo.js:75-92`); the pane must flush on layout change, mode change, displacement and page unload too.
- **Two writers on one file — and the pane's own load pushes into the panel.** The memo panel and the memo pane can be open simultaneously against the same `.switchboard/memo.md`. `memoSave` is a whole-file overwrite (`TaskViewerProvider.ts:12685-12687`) — last writer wins, silently. Worse, `memoLoad` broadcasts (`TaskViewerProvider.ts:12673`) with **no surface tag**, and `wsHub.broadcast` only filters when a surface is present (`src/services/wsHub.ts:316`), so the push reaches every connected panel including the memo panel. See the Race Conditions audit for the concrete clobber and its mitigation.

## Edge-Case & Dependency Audit

- **Race Conditions:**
  - **Concurrent memo editors (pane → panel clobber).** This is the sharpest edge and it is *not* symmetric with the panel-vs-agent case. When the memo pane calls `memoLoad`, the handler runs `this.postMessage({ type: 'memoContent', content })` with no surface argument (`TaskViewerProvider.ts:12673`). `BroadcastHub.push` mirrors it to `wsHub` (`BroadcastHub.ts:90`), and `wsHub.broadcast` skips a client only when the message *has* a surface the client did not subscribe to (`wsHub.ts:316`) — an untagged message goes to **everyone**. So an open memo panel receives the pane's loaded content. The panel's only guard is focus/dirty (`memo.js:130-134`): an idle panel showing workspace A silently swaps its textarea to workspace B's content, and its next debounced save writes B's text into A's file (`memo.js:224` posts `workspaceRoot: _wsRoot`, still A). **Mitigations, both required:** (a) the pane defaults to the same root the board and the memo panel use — `defaultKanbanWorkspace()` prefers the host-injected `initialWorkspaceRoot` (`terminals.js:2550-2551`) — so in the overwhelmingly common single-workspace case the pushed content is identical to what the panel already shows and the push is a no-op; (b) document it in the pane's workspace-picker `title` ("changing this while the Memo panel is open will retarget that panel's view"). A code fix belongs on the panel side (a `_wsRoot`-stamped `memoContent` push so the panel can ignore foreign roots) and requires a `.ts` change — **explicitly out of scope here**, recorded so the next memo-panel plan owns it.
  - **Pane vs pane.** Two memo panes in memo mode both call `memoLoad`; neither listens for pushes (`terminals.js` does not use `transport.js` and its own `message` listener at `terminals.js:556-575` handles only `terminalsChanged` / `switchboardThemeChanged` / `agentCompleted` / `focusTerminal`), so they cannot clobber each other's textareas. Their *files* still race on save if pointed at the same workspace — same last-writer-wins as any two editors, out of scope.
  - **Debounced save vs. workspace switch.** Switching the pane's workspace picker while a save is pending would write this workspace's text into the next one. Flush against the OLD root first, exactly as `switchMemoWorkspace` does (`memo.js:77-84`).
  - **Send-then-type.** `memoGeneratePrompt` clears the file on success (`TaskViewerProvider.ts:12756-12759`). If the operator types after clicking, the pane must not blank their new text. Guard on the submitted snapshot (`_submittedContent` pattern, `memo.js:153-187`): clear the textarea only if its value still equals what was submitted. The pane needs only the single-delivery version of that guard — the panel's double-delivery complexity (`memo.js:147-152`) comes from `transport.js` re-dispatching the HTTP body on top of the WS push, and the pane consumes the HTTP body alone.
  - **Send with no planner terminal.** `dispatchCustomPromptToRole('planner', …)` returns false, the prompt is copied to the *host* clipboard as a fallback, and the reply carries `success: false`, `memoCleared: false`, `isError: true` and the message `Failed to send to planner. Prompt copied to clipboard. Memo preserved for retry.` (`TaskViewerProvider.ts:12743-12785`). The pane must surface that message verbatim rather than reporting success. Note the HTTP status: `_handlePlanningVerb` writes **502** when `result.success === false` (`LocalApiServer.ts:1830-1832`), so the pane must read the body regardless of `res.ok` — a `res.ok` gate would swallow the message.
  - **Empty memo.** `memoGeneratePrompt` with no parseable entries returns `{ success: true, message: 'No entries to process.', memoCleared: false }` (`TaskViewerProvider.ts:12721`). The pane must show that message and NOT clear — gate the clear on `memoCleared`, never on `success`.
- **Security:** No new endpoint or auth surface. All five verbs already accept HTTP posts from this origin and are schema-validated at the boundary (`verbSchemas.ts:1553-1576`). Memo content is rendered into a `<textarea>` via `.value` and posted as JSON — never interpolated into HTML.
- **Side Effects:**
  - **The workspace picker must be built from the server's own root list, not the terminal parents list.** See the superseded callout in Proposed Changes §3. `_resolveStateWorkspaceRoot` → `_resolveWorkspaceRoot` (`TaskViewerProvider.ts:2818-2838`) accepts an explicit root only if it is in `_getAllowedRoots()`, and **silently falls back to the default root otherwise** — no error, no echo of the resolved root in the reply. A picker offering a root the server will not accept therefore writes the operator's text into a *different workspace's* memo file with no visible signal.
  - Send-to-Planner dispatches a real prompt to a real agent terminal and clears the memo. That is the intended action and needs no confirm gate (project rule: no confirmation dialogs).
  - Memo mode is suppressed in solo pop-outs and single-slot grids for the same reason kanban mode is (`terminals.js:2259-2263`, `2416`): `paneModes` is a shared persisted setting and a solo window forcing a slot back to `'terminal'` would clobber the cockpit's choice.
  - The empty-slot placeholder is `flex-direction: column; gap: 8px` (`terminals.html:877-887`). A second toggle button stacked under the first plus the hint line is three stacked rows in a 3x3 pane. Wrap the two toggles in a horizontal row (see §6) rather than letting them stack.
- **Dependencies & Conflicts:**
  - Files: `src/webview/terminals.js`, `src/webview/terminals.html`. No `.ts` changes, no catalog regeneration, no migration — `terminals.paneModes` has only ever held `'terminal'`/`'kanban'`, and unknown values already normalise to `'terminal'` (`terminals.js:751`), so an older build reading a `'memo'` entry degrades to an empty terminal slot rather than breaking. This is a **forward**-compat guarantee that already exists in shipped code; nothing needs migrating.
  - **Same-file sibling: the ALL CODED subtask** (`feature_plan_20260807090200_terminals-kanban-pane-all-coded-aggregate-column.md`) edits `renderKanbanPane`'s picker/body/rows and `fetchBoardCardsForPane` in this same file. **That plan lands FIRST**; this one rebases onto it. Regions are disjoint, but the PRD's one-stream-per-file rule applies — do not run them concurrently.
  - Overlaps `renderKanbanPane`'s pane-header conventions (`titleEl` / `actionsEl` / `modeBtn = actionsEl.children[4]`, `terminals.js:2677-2684`). Rather than copy that loop, **extract it** — see §3. The memo pane must hide the same terminal-only buttons the same way — by `style.display` ONLY, never `className` or `onclick`, for the reason documented at `terminals.js:2181-2186`.

## Dependencies

- `feature_plan_20260807090200_terminals-kanban-pane-all-coded-aggregate-column.md` — same-file sibling in this feature; lands first. Not a functional dependency (nothing here consumes it), purely a merge-order constraint.

## Adversarial Synthesis

**Risk Summary:** Three risks dominate. (1) **Incomplete predicate reclassification** — five `paneModes === 'kanban'` sites were missing from the first revision, and one of them (`toggleFocusedPaneKanban`, `terminals.js:2884-2912`) silently overwrites a memo pane with a kanban pane and discards unflushed text when the operator presses the toolbar button; the fix is a complete, enumerated site list plus a flush-before-mode-change rule. (2) **Unflushed text on every teardown path** — layout change, mode change, displacement, workspace switch and page unload each destroy the textarea, and an 800 ms debounce loses whatever has not fired; every path must call `flushMemoPane` first. (3) **Cross-surface clobber** — `memoLoad`'s untagged broadcast reaches an open memo panel and can retarget its view, after which the panel saves the wrong content into the wrong workspace; mitigated by defaulting the pane to the board's workspace, documented in the picker, with the real fix (a root-stamped push) deferred to a memo-panel plan. Secondary: read the reply body on 502, gate the clear on `memoCleared` not `success`, and build the workspace picker from `memoListWorkspaces` so the server can never silently redirect a write.

## Proposed Changes

### 1. `src/webview/terminals.js` — mode predicates

Add two named helpers beside `getSlotCount`:

```js
/** A slot showing a live board column. Kanban-SPECIFIC: gates the 5s poll,
 *  getBoardCards fetches, the post-response re-render and the column picker. */
function isBoardMode(i) { return paneModes[i] === 'kanban'; }

/** A slot that is unassigned but NOT available for a terminal — it is showing
 *  the operator something they chose to put there. Every seating path
 *  (isFree, fillEmptyPanes, the displacement scan, the drop-target guard)
 *  must use THIS, not a kanban-specific test, or memo panes get bulldozed. */
function isNonTerminalMode(i) { return paneModes[i] === 'kanban' || paneModes[i] === 'memo'; }
```

**Complete site list.** Every `paneModes` reference at HEAD, classified. This supersedes the earlier revision's 10-row table, which omitted lines 772, 1920, 2193, 2884-2912 and 3005.

> **Superseded:** A ten-row table covering lines 712, 1616, 1627, 1629, 1953, 1963, 1986, 2229, 2240, 2929, 2967, 3587 (pre-drift numbering), described as "18 call sites".
> **Reason:** The numbering had drifted ~39 lines, and five real sites were missing — most importantly `toggleFocusedPaneKanban` (`terminals.js:2884-2912`), where the toolbar button's "not already kanban → make it kanban" branch overwrites a memo pane and discards unflushed text with no flush and no guard. An incomplete site list is exactly the failure mode this reclassification exists to prevent.
> **Replaced with:** the table below.

| Line(s) | Current | Classification / action |
| --- | --- | --- |
| 26 | declaration + comment | Update the comment: three modes, not two. |
| 751 | `savedModes.map(m => m === 'kanban' ? 'kanban' : 'terminal')` | **Whitelist** → `savedModes.map(m => (m === 'kanban' || m === 'memo') ? m : 'terminal')` |
| 772 | `saveSetting('terminals.paneModes', paneModes)` | Unchanged. Add `terminals.memoPaneWorkspace` beside it (§2). |
| 1655 | `isFree = i => !paneAssignments[i] && paneModes[i] !== 'kanban'` | **Mode-agnostic** → `… && !isNonTerminalMode(i)` |
| 1666, 1668 | displacement scan | **Mode-agnostic** → `isNonTerminalMode(target)` / `!isNonTerminalMode(i)` |
| 1920 | `while (paneModes.length < getMaxSlotCount()) push('terminal')` | Unchanged. Add the `memoPaneWorkspace` pad beside it (§2). |
| 1992 | poll start `some(m => m === 'kanban')` | **Board-specific** — unchanged. A memo pane must not start the 5 s board poll. |
| 2002 | dragover guard | **Mode-agnostic** → `isNonTerminalMode(paneIndex)` |
| 2025 | drop guard (`Target pane has no terminal`) | **Mode-agnostic** → `isNonTerminalMode(paneIndex)` |
| 2193 | `Terminal` header button → `paneModes[index] = 'terminal'` | **Flush first.** `await flushMemoPane(index)` before the mode write, or the operator's last ≤800 ms of typing is lost on the way back to terminal mode. |
| 2213-2223 | delegated `.pane-mode-toggle` click | **Branch on `dataset.mode`** (§5). |
| 2259-2263 | `isSolo` comment | Update: memo mode is suppressed in solo for the same reason. |
| 2268 | `paneModes[index] === 'kanban' && !assignedName && !isSolo` | Add a parallel `'memo'` branch → `renderMemoPane` (§5). |
| 2279-2280 | terminal reached a kanban slot → drop mode | **Mode-agnostic** → `isNonTerminalMode(index) && assignedName`, and flush before dropping the mode. |
| 2288-2292 | `staleKanban` sweep + `delete dataset.kanbanSig` | Add the parallel memo sweep (§5). |
| 2884-2912 | `toggleFocusedPaneKanban` | **Bug without a fix here.** Line 2892's `if (paneModes[targetIndex] === 'kanban')` is false for a memo pane, so line 2905 overwrites `'memo'` with `'kanban'` — memo DOM discarded, unflushed text lost, `memoPaneState` orphaned. Fix: at the top of the function, `if (paneModes[targetIndex] === 'memo') { await flushMemoPane(targetIndex); memoPaneState.delete(targetIndex); }` before proceeding. Do NOT make the toolbar button a three-way cycle — it is the *kanban* button; toggling to kanban from memo is the correct, expected outcome once the text is safe. |
| 2967 | poll slot collection `paneModes[i] === 'kanban'` | **Board-specific** — unchanged. |
| 3005 | post-response re-render `paneModes[index] === 'kanban'` | **Board-specific** — unchanged. Widening it would call `renderKanbanPane` on a memo pane. |
| 3625 | `fillEmptyPanes` | **Mode-agnostic** → `!isNonTerminalMode(i)` |

### 2. `src/webview/terminals.js` — memo pane state

```js
// Per-slot chosen workspace root for a memo pane (only meaningful when
// paneModes[i] === 'memo'). Padded to getMaxSlotCount() like the kanban arrays.
let memoPaneWorkspace = [];
// index -> { saveTimer, dirty, submitted } — mirrors memo.js's module state,
// but per pane because two slots can be in memo mode at once.
const memoPaneState = new Map();
// Server-supplied workspace list for memo panes, fetched once via
// memoListWorkspaces. See §3 for why this is NOT buildWorkspaceList().
let memoWorkspaceItems = null;
const MEMO_SAVE_DEBOUNCE_MS = 800;
```

Load/persist `memoPaneWorkspace` alongside the kanban arrays in `loadLayoutSettings` (line 726 / 759) and `saveLayoutSettings` (line 775), and pad it in `renderPaneGrid` (line 1923).

### 3. `src/webview/terminals.js` — the workspace picker source

> **Superseded:** Build the memo pane's workspace `<select>` from the existing `buildWorkspaceList()` (`terminals.js:2488`).
> **Reason:** `buildWorkspaceList()` is derived from `parentsList` — the *terminal parents* reported by `ptyListTerminals` — which is a different set from the roots the memo handler will accept. `memoLoad`/`memoSave` resolve through `_resolveStateWorkspaceRoot` → `_resolveWorkspaceRoot` (`TaskViewerProvider.ts:2818-2838`), which honours an explicit root **only** if it is in `_getAllowedRoots()` and otherwise **silently falls back** to the kanban root or the first workspace folder. There is no error and the reply does not echo the resolved root, so a mismatch writes the operator's memo into a different workspace's file with zero visible signal. The kanban pane tolerates the same exposure because a wrong root there just shows the wrong cards; for memo it silently misfiles text.
> **Replaced with:** Fetch the server's own list once via `memoListWorkspaces` — the same list the memo panel uses (`memo.js:209`, `TaskViewerProvider.ts:12640-12648`), built by `buildWorkspaceItems(this._getWorkspaceRoots())` (`src/services/workspaceUtils.ts:6`) and mapping-aware. Every option is then guaranteed resolvable, and the pane and the panel offer identical choices.

```js
/** One-shot fetch of the memo's own workspace list. The HTTP body carries
 *  { success, items:[{label, workspaceRoot}] }; the handler's activeWorkspaceRoot
 *  is pushed only to the 'memo' surface, which this panel does not subscribe to,
 *  so the default is resolved locally instead. */
async function ensureMemoWorkspaceItems() {
    if (memoWorkspaceItems) { return memoWorkspaceItems; }
    try {
        const res = await fetch('/memo/verb/memoListWorkspaces', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        const data = await res.json();
        memoWorkspaceItems = Array.isArray(data && data.items) ? data.items : [];
    } catch { memoWorkspaceItems = []; }
    return memoWorkspaceItems;
}

/** Default root for a new memo pane: the board's workspace when the server also
 *  offers it (so the pane, the board and the memo panel agree and the untagged
 *  memoContent push is a no-op), else the server's first root. */
function defaultMemoWorkspace(items) {
    const preferred = defaultKanbanWorkspace();
    if (preferred && items.some(i => i.workspaceRoot === preferred)) { return preferred; }
    return items.length > 0 ? items[0].workspaceRoot : undefined;
}
```

**Also extract the shared header-button treatment**, rather than copying `renderKanbanPane`'s loop (`terminals.js:2677-2684`) into a second function where the two can drift when the button order changes:

```js
/** Hide every terminal-only header action and show only the mode toggle.
 *  style.display ONLY — never className or onclick — so updatePaneElement can
 *  restore them (see the createPaneElement comment at terminals.js:2181). */
function showOnlyPaneModeButton(actionsEl) {
    actionsEl.style.display = '';
    const modeBtn = actionsEl.children[4];
    for (let i = 0; i < actionsEl.children.length; i++) {
        actionsEl.children[i].style.display = (actionsEl.children[i] === modeBtn) ? '' : 'none';
    }
}
```

Call it from both `renderKanbanPane` (replacing lines 2680-2684) and `renderMemoPane`.

### 4. `src/webview/terminals.js` — `renderMemoPane`

```js
/** Render a memo pad into a pane slot. Header: P<n> chip + workspace picker +
 *  the shared `Terminal` toggle. Body: textarea (debounced auto-save), a status
 *  line, and Send-to-Planner / Clear buttons.
 *
 *  Unlike renderKanbanPane this is NOT signature-gated on a poll: there is no
 *  poll. It builds once per mode-entry and is then left alone, so the operator's
 *  caret, selection and scroll position in the textarea are never disturbed. */
async function renderMemoPane(paneEl, index) {
    paneEl.classList.remove('is-input-live', 'is-input-connecting', 'is-input-readonly');
    const titleEl = paneEl.querySelector('.pane-title');
    const actionsEl = paneEl.querySelector('.pane-actions');
    const contentEl = paneEl.querySelector('.pane-content');

    showOnlyPaneModeButton(actionsEl);

    if (contentEl.dataset.memoBuilt === '1') { return; }   // built once; see above
    contentEl.dataset.memoBuilt = '1';
    contentEl.textContent = '';
    titleEl.textContent = '';

    const idxEl = document.createElement('span');
    idxEl.className = 'pane-index-chip';
    idxEl.textContent = `P${index + 1}`;
    titleEl.appendChild(idxEl);

    const items = await ensureMemoWorkspaceItems();
    // The await above yields; the operator may have left memo mode meanwhile.
    if (paneModes[index] !== 'memo' || contentEl.dataset.memoBuilt !== '1') { return; }

    const wsPicker = document.createElement('select');
    wsPicker.className = 'memo-pane-ws-picker';
    wsPicker.title = 'Which workspace\'s .switchboard/memo.md this pad edits. '
        + 'Changing it while the Memo panel is open also retargets that panel\'s view.';
    for (const ws of items) {
        const opt = document.createElement('option');
        opt.value = ws.workspaceRoot;
        opt.textContent = ws.label;
        wsPicker.appendChild(opt);
    }
    if (!memoPaneWorkspace[index]) { memoPaneWorkspace[index] = defaultMemoWorkspace(items); }
    wsPicker.value = memoPaneWorkspace[index] || '';
    wsPicker.addEventListener('change', async () => {
        await flushMemoPane(index);          // against the OLD root, before switching
        memoPaneWorkspace[index] = wsPicker.value;
        saveLayoutSettings();
        loadMemoPane(index);
    });
    titleEl.appendChild(wsPicker);

    const wrap = document.createElement('div');
    wrap.className = 'memo-pane';

    const ta = document.createElement('textarea');
    ta.className = 'memo-pane-textarea';
    ta.placeholder = 'One observation per line or paragraph. Auto-saves to .switchboard/memo.md';
    ta.addEventListener('input', () => scheduleMemoSave(index));
    // xterm's global key handling must not swallow typing here.
    ta.addEventListener('keydown', (e) => e.stopPropagation());
    wrap.appendChild(ta);

    const footer = document.createElement('div');
    footer.className = 'memo-pane-footer';

    const status = document.createElement('div');
    status.className = 'memo-pane-status';
    footer.appendChild(status);

    const sendBtn = document.createElement('button');
    sendBtn.className = 'btn-unassign-pane';
    sendBtn.textContent = 'Send to Planner';
    sendBtn.title = 'Build a planner prompt from these entries, dispatch it, and clear the memo';
    sendBtn.addEventListener('click', () => sendMemoPane(index));
    footer.appendChild(sendBtn);

    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn-unassign-pane';
    clearBtn.textContent = 'Clear';
    clearBtn.title = 'Empty the memo file';
    clearBtn.addEventListener('click', () => clearMemoPane(index));
    footer.appendChild(clearBtn);

    wrap.appendChild(footer);
    contentEl.appendChild(wrap);

    memoPaneState.set(index, { saveTimer: null, dirty: false, submitted: null });
    loadMemoPane(index);
}
```

Note: listeners here are attached in a **build-once** block guarded by `dataset.memoBuilt`, not on the per-reconcile path — the same discipline `renderKanbanPane`'s signature gate enforces. `updatePaneElement` calls this without awaiting (it is a fire-and-forget render, like the kanban branch); the internal re-check after the await is what makes that safe.

### 5. `src/webview/terminals.js` — memo I/O

```js
function memoPaneEls(index) {
    const paneEl = paneGridEl && paneGridEl.querySelector(`.terminal-pane[data-pane-index="${index}"]`);
    if (!paneEl) { return null; }
    return {
        ta: paneEl.querySelector('.memo-pane-textarea'),
        status: paneEl.querySelector('.memo-pane-status')
    };
}

async function loadMemoPane(index) {
    const els = memoPaneEls(index);
    if (!els || !els.ta) { return; }
    const st = memoPaneState.get(index);
    if (st) { st.dirty = false; st.submitted = null; }
    els.ta.value = '';
    try {
        const res = await fetch('/memo/verb/memoLoad', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceRoot: memoPaneWorkspace[index] })
        });
        const data = await res.json();
        // Dirty/focus guard, same rule memo.js uses (memo.js:130-134): a load
        // landing after the operator started typing must not discard their text.
        const focused = document.activeElement === els.ta;
        if (data && typeof data.content === 'string' && !focused && !(st && st.dirty)) {
            els.ta.value = data.content;
        }
    } catch { setMemoStatus(index, 'Load failed', true); }
}

function scheduleMemoSave(index) {
    const st = memoPaneState.get(index);
    if (!st) { return; }
    st.dirty = true;
    if (st.saveTimer) { clearTimeout(st.saveTimer); }
    st.saveTimer = setTimeout(() => flushMemoPane(index), MEMO_SAVE_DEBOUNCE_MS);
}

/** Write immediately and cancel any pending debounce. Called by the debounce
 *  itself, and by every teardown path: workspace switch, mode change (both the
 *  header Terminal button and the kanban toolbar button), displacement, layout
 *  change, pagehide. Awaitable so a caller can flush before destroying the DOM. */
async function flushMemoPane(index) {
    const st = memoPaneState.get(index);
    const els = memoPaneEls(index);
    if (!st || !els || !els.ta) { return; }
    if (st.saveTimer) { clearTimeout(st.saveTimer); st.saveTimer = null; }
    if (!st.dirty) { return; }
    const content = els.ta.value;
    st.dirty = false;
    try {
        await fetch('/memo/verb/memoSave', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content, workspaceRoot: memoPaneWorkspace[index] })
        });
        setMemoStatus(index, 'Saved');
    } catch { setMemoStatus(index, 'Save failed', true); }
}

/** Best-effort synchronous flush for pagehide, where an async fetch is not
 *  guaranteed to be delivered. sendBeacon survives the unload; the JSON blob
 *  keeps the content type the route expects. */
function flushMemoPaneOnUnload(index) {
    const st = memoPaneState.get(index);
    const els = memoPaneEls(index);
    if (!st || !st.dirty || !els || !els.ta) { return; }
    try {
        navigator.sendBeacon('/memo/verb/memoSave', new Blob(
            [JSON.stringify({ content: els.ta.value, workspaceRoot: memoPaneWorkspace[index] })],
            { type: 'application/json' }
        ));
        st.dirty = false;
    } catch { /* nothing more we can do at unload */ }
}

async function clearMemoPane(index) {
    const els = memoPaneEls(index);
    const st = memoPaneState.get(index);
    if (els && els.ta) { els.ta.value = ''; }
    if (st) { if (st.saveTimer) { clearTimeout(st.saveTimer); st.saveTimer = null; } st.dirty = false; }
    try {
        await fetch('/memo/verb/memoClear', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceRoot: memoPaneWorkspace[index] })
        });
        setMemoStatus(index, 'Cleared');
    } catch { setMemoStatus(index, 'Clear failed', true); }
}

async function sendMemoPane(index) {
    const els = memoPaneEls(index);
    const st = memoPaneState.get(index);
    if (!els || !els.ta || !st) { return; }
    if (st.saveTimer) { clearTimeout(st.saveTimer); st.saveTimer = null; }
    st.dirty = false;
    const content = els.ta.value;
    st.submitted = content;
    setMemoStatus(index, 'Building prompt…');
    try {
        const res = await fetch('/memo/verb/memoGeneratePrompt', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content, action: 'send', workspaceRoot: memoPaneWorkspace[index] })
        });
        // NO res.ok gate: _handlePlanningVerb returns 502 for {success:false}
        // (LocalApiServer.ts:1830-1832), and the failure body is exactly the
        // message the operator needs ("Memo preserved for retry").
        const data = await res.json();
        setMemoStatus(index, data.message || (data.success ? 'Sent' : 'Send failed'), !!data.isError);
        // Clear ONLY if the batch we submitted is still on screen — the operator
        // may have typed after clicking (memo.js:153-187 documents this exact trap).
        // Gate on memoCleared, NOT success: the empty-memo reply is
        // {success:true, memoCleared:false} and must not blank the pad.
        if (data.memoCleared && els.ta.value === st.submitted) {
            els.ta.value = '';
            st.dirty = false;
        }
        if (data.memoCleared || !data.success) { st.submitted = null; }
    } catch (err) {
        setMemoStatus(index, 'Send failed: ' + (err.message || String(err)), true);
        st.submitted = null;
    }
}

function setMemoStatus(index, text, isError) {
    const els = memoPaneEls(index);
    if (!els || !els.status) { return; }
    els.status.textContent = text || '';
    els.status.style.color = isError ? 'var(--accent-red, #f85149)' : 'var(--text-secondary)';
}
```

### 6. `src/webview/terminals.js` — entry, exit and teardown

`updatePaneElement` (line 2268) gains a memo branch beside the kanban one:

```js
if (paneModes[index] === 'kanban' && !assignedName && !isSolo) { renderKanbanPane(paneEl, index); return; }
if (paneModes[index] === 'memo'   && !assignedName && !isSolo) { renderMemoPane(paneEl, index);   return; }
```

The terminal path (after line 2280) must clear the memo body and its build flag, mirroring the `staleKanban` sweep at line 2288:

```js
const staleMemo = contentEl.querySelectorAll('.memo-pane');
if (staleMemo.length) { flushMemoPane(index); }
staleMemo.forEach(el => el.remove());
delete contentEl.dataset.memoBuilt;
memoPaneState.delete(index);
```

Empty-slot placeholder (line 2416) gains a second toggle inside a horizontal wrapper — the placeholder is `flex-direction: column`, so two bare buttons would stack:

```js
const toggleRow = document.createElement('div');
toggleRow.className = 'pane-mode-toggle-row';

const kanbanToggle = document.createElement('button');
kanbanToggle.className = 'pane-mode-toggle';
kanbanToggle.dataset.mode = 'kanban';
kanbanToggle.textContent = 'kanban mode';
kanbanToggle.title = 'Show a kanban column here instead';
toggleRow.appendChild(kanbanToggle);

const memoToggle = document.createElement('button');
memoToggle.className = 'pane-mode-toggle';
memoToggle.dataset.mode = 'memo';
memoToggle.textContent = 'memo mode';
memoToggle.title = 'Capture memo entries here instead';
toggleRow.appendChild(memoToggle);

emptySlot.appendChild(toggleRow);
```

and the delegated handler (line 2213) branches on the dataset instead of assuming kanban:

```js
contentEl.addEventListener('click', (e) => {
    const target = e.target;
    if (!target || !target.classList || !target.classList.contains('pane-mode-toggle')) { return; }
    e.stopPropagation();
    const mode = target.dataset.mode === 'memo' ? 'memo' : 'kanban';
    paneModes[index] = mode;
    if (mode === 'kanban') {
        if (!kanbanPaneColumn[index]) { kanbanPaneColumn[index] = 'CREATED'; }
        if (!kanbanPaneWorkspace[index]) { kanbanPaneWorkspace[index] = defaultKanbanWorkspace(); }
    }
    // memo mode resolves its default root inside renderMemoPane, after
    // memoListWorkspaces lands — it cannot be resolved synchronously here.
    saveLayoutSettings();
    renderPaneGrid();
    if (mode === 'kanban') { fetchBoardCardsForPane(index); }
});
```

Flush-on-teardown, all four paths:
- top of `renderPaneGrid` (line 1913) — `for each i where paneModes[i] === 'memo', flushMemoPane(i)`;
- the `Terminal` header button handler (line 2191) — `await flushMemoPane(index)` before writing the mode;
- `toggleFocusedPaneKanban` (line 2884) — flush + `memoPaneState.delete` when the focused pane is a memo pane;
- `window.addEventListener('pagehide', …)` — `flushMemoPaneOnUnload(i)` for every memo slot.

### 7. `src/webview/terminals.html` — memo pane CSS

Add beside `.pane-mode-toggle` (line 1054):

```css
.pane-mode-toggle-row { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; }
.memo-pane {
    position: absolute; inset: 0;
    display: flex; flex-direction: column; gap: 6px;
    padding: 8px;
}
.memo-pane-textarea {
    flex: 1;
    resize: none;
    background: var(--panel-bg);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    border-radius: 3px;
    padding: 8px;
    font-family: var(--font-code, Menlo, Consolas, monospace);
    font-size: 12px;
    line-height: 1.5;
}
.memo-pane-textarea:focus { outline: none; border-color: var(--accent-teal); }
.memo-pane-footer { display: flex; align-items: center; gap: 6px; }
.memo-pane-status { flex: 1; font-size: 10px; color: var(--text-secondary); min-width: 0;
                    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.memo-pane-ws-picker {
    background: var(--panel-bg); color: var(--text-primary);
    border: 1px solid var(--border-color); border-radius: 2px;
    font-family: inherit; font-size: 10px; padding: 1px 3px; margin-left: 4px;
    max-width: 140px;
}
/* Dense grids: the footer buttons wrap before the textarea collapses. */
.pane-grid.layout-2x3 .memo-pane-footer,
.pane-grid.layout-3x3 .memo-pane-footer { flex-wrap: wrap; }
```

## Verification Plan

### Automated Tests

No new automated tests, and **no test run and no compile step in this session** (session directives: skip compilation, skip tests). This plan touches only `src/webview/terminals.js` and `src/webview/terminals.html` — confirm by diff that no `.ts` file is modified, which is what keeps the verb catalog, `verbSchemas.ts` and the return-contract ratchet (`npm run verb-returns:check`) untouched by construction.

### Manual

1. **Enter memo mode.** Open `/terminals` with a 2x2 layout and at least one empty pane. The empty slot shows `kanban mode` and `memo mode` side by side on one row. Click `memo mode`: the pane becomes a memo pad with a workspace picker in its header and a `Terminal` button in the header actions.
2. **Picker source.** Confirm the pane's workspace options match the Memo panel's own workspace dropdown exactly (both come from `memoListWorkspaces`), not the terminal-parents list.
3. **Auto-save.** Type three lines. Within ~1 s the status reads `Saved`. Open the memo panel (`/memo`, same workspace) and confirm the same three lines are there — i.e. it wrote the real `.switchboard/memo.md`.
4. **Round-trip.** Reload the panel. The pane comes back in memo mode (persisted `terminals.paneModes`) with the saved text loaded.
5. **Send to Planner.** With a planner terminal open, click **Send to Planner**. Expect: status reports `Sent N issue(s) to planner. Memo cleared.`, the textarea empties, the planner terminal receives the prompt, and `.switchboard/memo.md` is empty on disk.
6. **Send with no planner.** Close every planner terminal and click Send. The HTTP status will be 502; expect the failure message (`Failed to send to planner. Prompt copied to clipboard. Memo preserved for retry.`) to be shown and — critically — the textarea keeps its text and the file is NOT cleared. A blank status here means a `res.ok` gate crept in.
7. **Send an empty memo.** With an empty pad, click Send. Expect `No entries to process.` and no clear, no error styling.
8. **Send-then-type guard.** Click Send and immediately type a new line before the reply lands. The new text must survive: the pane clears only when the on-screen value still equals what was submitted.
9. **Clear.** Type text, click **Clear**. Textarea empties, status reads `Cleared`, and the file is empty on disk.
10. **Workspace switch flushes.** Type text, then immediately change the workspace picker (before the 800 ms debounce fires). Confirm the text landed in the ORIGINAL workspace's memo file, and the pane now shows the NEW workspace's memo.
11. **Layout change flushes.** Type text, then switch layout 2x2 → 1x2 within the debounce window. Confirm no text is lost.
12. **Terminal-button flush.** Type text, then click `Terminal` in the pane header within the debounce window. Confirm the text was saved before the pane tore down.
13. **Kanban toolbar button does not eat the memo.** With the memo pane focused and text typed inside the debounce window, click the toolbar kanban button. Confirm the text is flushed to disk first and the pane then switches to kanban mode — this is the `toggleFocusedPaneKanban` fix; without it the typing is lost silently.
14. **Page unload flushes.** Type text and close the tab within the debounce window. Reopen `/terminals` and confirm the text is in the memo file (the `sendBeacon` path).
15. **Open All does not bulldoze it.** With a memo pane up, click **OPEN AGENT TERMINALS**. The memo pane must survive untouched (the `isNonTerminalMode` reclassification of `fillEmptyPanes`, `terminals.js:3625`).
16. **Drag-drop guard.** Drag a plan card from a kanban pane onto the memo pane. Expect the drop to be refused with the `Target pane has no terminal` toast, not an attempted dispatch.
17. **Displacement.** Fill every pane with terminals except the memo pane, then click a sidebar terminal with nowhere else to go. The memo pane may be displaced (documented behaviour for kanban panes) — confirm any unsaved text is flushed first and the mode is dropped to `'terminal'` rather than left stale.
18. **Two memo panes.** Put two slots in memo mode against different workspaces. Confirm each loads and saves its own file and the per-index state does not cross-contaminate.
19. **Cross-surface behaviour is understood, not surprising.** With the Memo panel open on workspace A and idle, put a pane in memo mode on workspace B. Confirm the documented behaviour: the panel's textarea takes on B's content (the untagged `memoContent` broadcast). Confirm the pane's picker tooltip warns about exactly this. Do NOT type into the panel afterwards without re-selecting its workspace.
20. **Back to terminal.** Click `Terminal` in the memo pane header. Confirm unsaved text is flushed, the memo DOM is removed, `dataset.memoBuilt` is gone, `memoPaneState` is cleared, and the pane shows the empty-slot placeholder with both mode toggles again.
21. **Solo pop-out.** Pop a terminal out to a solo window while a memo pane exists in the cockpit. Confirm the solo window shows only its terminal and that returning to the cockpit still shows the memo pane (the shared `paneModes` setting was not clobbered).
22. **Typing does not leak to xterm.** With a terminal in an adjacent pane, type in the memo textarea and confirm no characters appear in that terminal.
23. **No board poll from a memo pane.** With only a memo pane (no kanban pane) in the grid, confirm no `getBoardCards` request fires on a 5 s cadence — line 1992 must have stayed kanban-specific.
24. **Dense grid.** In a 3x3 layout, confirm the memo pane's footer buttons wrap rather than crushing the textarea, and the two mode toggles sit on one row in the empty slots.

## Recommendation

**Complexity 6 → Send to Coder.**
