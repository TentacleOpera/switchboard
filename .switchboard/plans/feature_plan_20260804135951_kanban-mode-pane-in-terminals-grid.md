# Kanban-Mode Pane in the Terminals Grid

## Goal

Add a per-pane "kanban mode" to the terminals grid (`src/webview/terminals.html` / `terminals.js`) so an unused grid slot can be repurposed into a live list of plans in a chosen kanban column, each with a copy-prompt link — instead of wasting the slot on the "Click terminal in sidebar to assign" empty state.

### Problem analysis & root cause

The terminals panel renders a CSS-grid of panes (`renderPaneGrid()` in `terminals.js:1323`) whose slot count is fixed by the active layout (`LAYOUTS` at `terminals.js:475` — 1/2h/2v/2x2/2x3/3x3). When the operator runs fewer terminals than slots (e.g. 3 terminals in a 2x2 = 4 slots), `updatePaneElement()` (`terminals.js:1471`) paints the surplus pane with a `.pane-empty-slot` reading "Click terminal in sidebar to assign" (`terminals.js:1579`). That space is dead until a terminal is assigned.

To grab the next plan prompt today, the operator must switch to the Kanban board tab, find the column, click "Copy Prompt", then switch back to the terminals tab to paste it into an agent terminal. The round-trip is pure screen-switching overhead — the prompt's destination is a terminal that is already visible in the grid.

### Root cause

There is no pane content type other than "a terminal viewport". `paneAssignments[index]` is either a terminal friendly-name or `null`; `null` always renders the inert empty-slot placeholder. There is no concept of a pane that renders non-terminal content (a plan list), and no transport path for the browser-served terminals page to pull board cards: the page subscribes to the `terminals` + `common` WS surfaces (`transport.js:95-103`, mirroring `wsHub.ts:69-77`), so it never receives the `{type:'updateBoard', cards}` pushes that the Kanban board consumes (those are tagged `SURFACES.kanban`, `KanbanProvider.ts:1154`). The only board data reachable over HTTP from the terminals page is column structure (`getKanbanStructure`) and per-verb actions (`promptSelected`, `copyPlanLink`) — there is no read-only verb that returns the card array.

## Metadata

**Complexity:** 7
**Tags:** frontend, backend, ui, ux, feature
**Project:** Browser Switchboard

## User Review Required

- **"Copy & Advance" has a backend side-effect:** clicking it moves the card to the next column (and may dispatch an agent, per `promptSelected`). This is deliberate and matches the board's own button, and the label makes it visible — confirm the pane should offer advance-by-default rather than copy-only (`copyPlanLink`) as the primary action.
- **5s polling cadence:** the pane polls `getBoardCards` every 5 seconds while any pane is in kanban mode. Board pushes are push-based; the pane is poll-based, so a card can appear/disappear up to 5s late. Judged acceptable for a glanceable list; flag if live push is wanted (that would mean subscribing the terminals page to the `kanban` WS surface — rejected, see Complexity Audit).

## Complexity Audit

**Routine:**
- Adding a pane-mode toggle button to the pane header (mirrors the existing `btn-unassign-pane` pattern at `terminals.js:1432`).
- Rendering a scrollable list of plan rows inside `.pane-content` (plain DOM, same as the sidebar `renderSidebarList`).
- Wiring a copy-prompt click to `POST /kanban/verb/promptSelected` — the verb already exists, is on the allowlist, returns `{success, prompt, targetColumn}` over HTTP (`KanbanProvider.ts:9228-9296`), and copies to the system clipboard via `clipboard.writeText`.

**Complex / risky:**
- **New read-only board-cards verb.** The terminals page cannot receive `updateBoard` pushes (wrong WS surface — verified: `wsHub.ts:71` subscribes the terminals panel to `[terminals, common]` only). A new `getBoardCards` verb must be added to `KanbanProvider.ts` (`_handleMessage`), schema-added to `verbSchemas.ts` (`KANBAN_VERB_SCHEMAS`, line 167 — PRD contract #5: schema validation at the HTTP boundary), and then `npm run catalog:generate` run to regenerate BOTH `protocol-catalog.json` and `src/generated/verbAllowlist.ts` (the catalog is GENERATED from source by `scripts/generate-protocol-catalog.js` — never hand-edit it). The verb must reuse the canonical `_buildBoardCards` pipeline (`KanbanProvider.ts:1784`) — NOT the deprecated `_buildCardsFromDbSessionIds` (`KanbanProvider.ts:7236`, which drops features and rows with empty session_id) — so the card set matches what the Kanban board renders. Optional `column` filter param narrows the result.
- **Pane-mode state model.** `paneAssignments[index]` is a `string | null`. A second parallel array (`paneModes[index]`) is needed to track `'terminal' | 'kanban'` per slot, persisted via the existing settings path (`saveLayoutSettings()`, `terminals.js:549`). A kanban-mode pane must NOT consume a terminal slot in `paneAssignments` (so it never displaces a terminal), and switching a pane back to terminal mode restores the empty-slot placeholder until a terminal is assigned. `paneModes` must mirror `paneAssignments`' sizing model exactly: padded to `getMaxSlotCount()`, NEVER trimmed on layout shrink (see the superseded callout in Proposed Changes §2 — the file documents this as deliberate at `terminals.js:1351-1355`).
- **Live refresh without flooding the page.** The kanban-mode pane should poll `getBoardCards` on a modest interval (e.g. 5s) only while at least one pane is in kanban mode, and stop polling when none are. Subscribing the whole terminals page to the `kanban` WS surface is rejected — it would deliver every `moveCards`/`updateBoard`/`updateColumns` push to a page that has no handler for them and would need filtering anyway.
- **Copy-prompt label derivation.** The Kanban board computes the button label from the next column's role (`kanban.html:6700-6735`). The kanban-mode pane must replicate a lightweight version of this (`getNextColumn` + role → label) OR simply use a generic "Copy Prompt" label and rely on the backend `promptSelected` to generate the correct prompt. The latter is simpler and avoids duplicating the board's column-routing logic; the label can be "Copy & Advance" with the target column name shown beside it.

## Edge-Case & Dependency Audit

- **Empty column.** A kanban-mode pane pointed at a column with zero plans must show an empty-state message ("No plans in <column>") rather than a blank pane. Polling continues so plans appearing later show up.
- **Column hidden by dynamic filtering.** `_filterDynamicColumns` (defined at `KanbanProvider.ts:3730`; called e.g. at `:1104`) hides columns for unconfigured agents. If the user picks a column that is later hidden (agent disabled), `getBoardCards` for that column returns an empty list — the pane shows the empty state. The column picker should only offer columns from the current `getKanbanStructure` result, refreshed on each poll.
- **Layout shrink.** Switching from 2x2 → 1 drops slots 1-3. `renderPaneGrid()` removes surplus pane ELEMENTS (`terminals.js:1340-1342`) but — by documented design (`terminals.js:1351-1355`) — does NOT trim `paneAssignments`, which stays padded to `getMaxSlotCount()` so parked assignments survive a shrink-grow round trip. `paneModes` must behave identically: the dropped slot's pane element is destroyed, but its mode (and chosen column) is RETAINED in the padded array and resurrects if the layout grows back. A kanban-mode pane in a surviving slot is unaffected.
- **Layout grow.** Switching 1 → 2x2 adds slots. New slots default to `'terminal'` mode with an empty terminal placeholder (current behavior preserved).
- **Solo mode.** `body.is-solo` (`terminals.html:971-973`) hides the sidebar and layout toolbar and pins a single terminal. Kanban mode is meaningless in solo mode (one pinned terminal, no grid). The mode toggle button must be suppressed in solo mode.
- **`promptSelected` advances the card.** Clicking copy-prompt moves the card to the next column (backend side-effect). The kanban-mode pane's next poll will show the card gone from the chosen column. This is the desired behavior (matches the board's "Copy Prompt and advance" button) but the operator must understand it. The button label should say "Copy & Advance" to make the side-effect visible. A copy-without-advance alternative exists (`copyPlanLink` verb, `KanbanProvider.ts:9725`) — offer both: primary "Copy & Advance", secondary "Copy only".
- **`promptSelected` over HTTP uses `_lastCards` cache.** The verb filters `this._lastCards` (`KanbanProvider.ts:9238`) which is populated by the last board refresh. If the Kanban board tab has never been opened, `_lastCards` may be stale/empty and the verb falls back to `_buildCardsFromDbSessionIds` (`KanbanProvider.ts:9240`). The new `getBoardCards` verb should call `_buildBoardCards` directly (fresh from DB) so the pane's list is authoritative; `promptSelected` will still resolve the card by sessionId from its fallback path. No correctness issue, but the pane should pass the card's `workspaceRoot` in the `promptSelected` payload to ensure correct workspace scoping.
- **`clipboard.writeText` on the extension host.** `promptSelected` calls `this._seams().clipboard.writeText(prompt)` (`KanbanProvider.ts:9253`). Over HTTP this writes to the VS Code host's system clipboard — which IS the operator's clipboard. This works for the browser-served terminals page (same machine). Confirmed: `copyPlanLink` and `improvePlan` already rely on this path over HTTP.
- **`getKanbanStructure` returns `{success, structure, customColumns}`.** The pane's column picker needs the flat ordered list of visible column ids + labels. `structure` is the ordered sequence; `customColumns` carries user-defined ones. The picker must merge both into a single ordered list (the board does this in `renderColumns()`, `kanban.html:5428`).
- **No confirm dialogs.** Per `CLAUDE.md`: switching a pane to/from kanban mode is a one-click toggle, no `confirm()`. Mode switches are reversible (toggle back), so no confirmation is warranted.

## Proposed Changes

### 1. Backend — new `getBoardCards` verb

**`src/services/KanbanProvider.ts`** — add a new `case` in `_handleMessage` (near `getKanbanStructure` at line 10297):

```ts
case 'getBoardCards': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot) {
        return { success: false, error: 'No workspace root resolved' };
    }
    const db = this._getKanbanDb(workspaceRoot);
    if (!db || !(await db.ensureReady())) {
        return { success: false, error: 'Kanban DB unavailable' };
    }
    // Canonical wsId resolution — mirrors getFullStateMessages (line 1076):
    // getWorkspaceId takes NO argument and has a getDominantWorkspaceId fallback.
    const wsId = (await db.getWorkspaceId?.()) || (await db.getDominantWorkspaceId?.()) || '';
    if (!wsId) {
        return { success: false, error: 'Workspace not registered' };
    }
    const repoScope = this.getRepoScopeFilter() ?? null;
    const activeRows = repoScope
        ? await db.getBoardFilteredByProject(wsId, null, repoScope)
        : await db.getBoard(wsId);
    const completedRows = repoScope
        ? await db.getCompletedPlansFilteredByProject(wsId, null, repoScope)
        : await db.getCompletedPlans(wsId);
    const timeoutMs = vscode.workspace.getConfiguration('switchboard.activityLight').get<number>('timeoutMs', DEFAULT_WORKING_STATE_TIMEOUT_MS);
    // Canonical pipeline — same as getFullStateMessages (line 1094).
    const cards = await this._buildBoardCards(db, wsId, workspaceRoot, activeRows, completedRows, timeoutMs);
    // Optional column filter (narrow to one column for the kanban-mode pane).
    const column = typeof msg.column === 'string' ? msg.column : null;
    const filtered = column ? cards.filter(c => c.column === column) : cards;
    return { success: true, cards: filtered };
}
```

> **Superseded:** `const wsId = await db.getWorkspaceId(workspaceRoot);`
> **Reason:** Invented signature — `KanbanDatabase.getWorkspaceId()` takes NO argument (KanbanDatabase.ts:5565), and the canonical call site (`getFullStateMessages`, KanbanProvider.ts:1076) chains a `getDominantWorkspaceId` fallback. Freestyling the call drops the fallback and passes an ignored argument.
> **Replaced with:** `const wsId = (await db.getWorkspaceId?.()) || (await db.getDominantWorkspaceId?.()) || '';` (code above already reflects this).

This reuses the exact `_buildBoardCards` pipeline the board uses (`KanbanProvider.ts:1094`), so the card set can never drift from what the Kanban tab renders.

**`src/services/verbSchemas.ts`** — add a schema to `KANBAN_VERB_SCHEMAS` (line 167). PRD contract #5 (schema validation at the HTTP boundary) applies to NEW verbs; "verbs with no schema pass through" is a burndown concession for legacy arms, not a license to skip validation on new ones:

```ts
getBoardCards: {
    fields: {
        column: { type: 'string' },
        workspaceRoot: { type: 'string' },
    },
},
```

> **Superseded:** "Register the verb in `protocol-catalog.json` (alongside `getKanbanStructure`) and in the top-level verb schema" with hand-written JSON blocks, "then run `npm run catalog:generate`".
> **Reason:** `protocol-catalog.json` is GENERATED from source by `scripts/generate-protocol-catalog.js --write` (`package.json:833`, `catalog:generate`); its `"line"` fields are scanner output. Hand-edits are reverted by the next generator run. The plan's JSON blocks describe files the implementer must never touch by hand.
> **Replaced with:** Add the `case 'getBoardCards'` to `_handleMessage` (above), add the `verbSchemas.ts` entry (above), then run `npm run catalog:generate` ONCE — it regenerates BOTH `protocol-catalog.json` (the verb appears alongside `getKanbanStructure` automatically) AND `src/generated/verbAllowlist.ts` (adds `getBoardCards` to `KANBAN_VERBS`). Verify with `npm run catalog:check`.

### 2. Frontend — pane-mode state (`src/webview/terminals.js`)

Add a parallel mode array alongside `paneAssignments` (declared at `terminals.js:12`):

```js
let paneModes = []; // 'terminal' | 'kanban' per slot; defaults to 'terminal'
```

In `loadLayoutSettings()` (`terminals.js:523`), load the persisted modes:
```js
const savedModes = await loadSetting('terminals.paneModes', []);
paneModes = savedModes;
```

In `saveLayoutSettings()` (`terminals.js:549`), persist `paneModes` alongside `paneAssignments`:
```js
await saveSetting('terminals.paneModes', paneModes);
```

In `renderPaneGrid()` (`terminals.js:1323`), pad `paneModes` to `getMaxSlotCount()` — exactly the model `paneAssignments` uses (documented at `terminals.js:1351-1355`: assignments stay padded to nine regardless of layout so parked state survives a shrink-grow round trip):
```js
while (paneModes.length < getMaxSlotCount()) { paneModes.push('terminal'); }
// Never trim: a kanban-mode slot's mode + chosen column survive layout shrink,
// mirroring paneAssignments' deliberate no-trim design.
```

> **Superseded:** "Trim `paneModes` to the slot count exactly as `paneAssignments` is handled (the while-loop at `terminals.js:1280-1285` removes surplus panes; add `paneModes.length = slotCount`)".
> **Reason:** Double error. (1) The while-loop (`terminals.js:1340-1345`) removes surplus pane ELEMENTS, not assignments — `paneAssignments` is never trimmed on layout shrink; the file documents this as deliberate (`terminals.js:1351-1355`) so a terminal parked in slot 5 survives a 3x3 → 1 → 3x3 round trip. (2) Trimming `paneModes` would amputate exactly the state that design exists to preserve — the user's kanban-mode choice and chosen column.
> **Replaced with:** Pad `paneModes` to `getMaxSlotCount()`, never trim (code above already reflects this).

### 3. Frontend — kanban-mode pane rendering (`src/webview/terminals.js`)

In `updatePaneElement()` (`terminals.js:1471`), branch on `paneModes[index]`:

- `'terminal'` (default): existing behavior unchanged.
- `'kanban'`: render a kanban column viewer instead of a terminal viewport.

Add a new function `renderKanbanPane(paneEl, index)`:

```js
async function renderKanbanPane(paneEl, index) {
    const contentEl = paneEl.querySelector('.pane-content');
    const titleEl = paneEl.querySelector('.pane-title');
    const actionsEl = paneEl.querySelector('.pane-actions');

    // Header: column picker + "switch to terminal" toggle
    titleEl.textContent = '';
    const idxEl = document.createElement('span');
    idxEl.className = 'pane-index-chip';
    idxEl.textContent = `P${index + 1}`;
    titleEl.appendChild(idxEl);

    const picker = document.createElement('select');
    picker.className = 'kanban-pane-column-picker';
    picker.title = 'Kanban column to display';
    // Populate from cached column structure (fetched by the poll loop).
    for (const col of kanbanColumnsCache) {
        const opt = document.createElement('option');
        opt.value = col.id;
        opt.textContent = col.label;
        if (col.id === kanbanPaneColumn[index]) { opt.selected = true; }
        picker.appendChild(opt);
    }
    picker.addEventListener('change', () => {
        kanbanPaneColumn[index] = picker.value;
        saveLayoutSettings();
        fetchBoardCardsForPane(index);
    });
    titleEl.appendChild(picker);

    // Toggle button: switch this pane back to terminal mode
    const modeBtn = actionsEl.children[1]; // reuse the second btn slot
    modeBtn.textContent = 'term';
    modeBtn.title = 'Switch this pane to terminal mode';
    modeBtn.onclick = (e) => {
        e.stopPropagation();
        paneModes[index] = 'terminal';
        saveLayoutSettings();
        renderPaneGrid();
    };
    actionsEl.style.display = '';

    // Body: plan list
    contentEl.textContent = '';
    const cards = kanbanPaneCards[index] || [];
    if (cards.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'pane-empty-slot';
        empty.textContent = `No plans in ${kanbanPaneColumn[index] || '—'}`;
        contentEl.appendChild(empty);
        return;
    }
    const list = document.createElement('div');
    list.className = 'kanban-pane-list';
    for (const card of cards) {
        const row = document.createElement('div');
        row.className = 'kanban-pane-row';
        const label = document.createElement('span');
        label.className = 'kanban-pane-row-title';
        label.textContent = card.topic;
        row.appendChild(label);

        const copyBtn = document.createElement('button');
        copyBtn.className = 'kanban-pane-copy-btn';
        copyBtn.textContent = 'Copy & Advance';
        copyBtn.title = 'Copy prompt to clipboard and advance to next column';
        copyBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            copyBtn.disabled = true;
            copyBtn.textContent = 'Copying…';
            try {
                const res = await fetch('/kanban/verb/promptSelected', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        column: card.column,
                        sessionIds: [card.planId || card.sessionId],
                        workspaceRoot: card.workspaceRoot
                    })
                });
                const data = await res.json();
                if (data.success) {
                    copyBtn.textContent = 'Copied!';
                    // Refresh this pane's list (the card advanced out)
                    fetchBoardCardsForPane(index);
                } else {
                    copyBtn.textContent = 'Failed';
                }
            } catch {
                copyBtn.textContent = 'Error';
            }
            setTimeout(() => { copyBtn.disabled = false; copyBtn.textContent = 'Copy & Advance'; }, 2000);
        });
        row.appendChild(copyBtn);
        list.appendChild(row);
    }
    contentEl.appendChild(list);
}
```

### 4. Frontend — mode toggle on empty terminal panes

In `updatePaneElement()`, when `paneModes[index] === 'terminal'` AND the slot is empty (`!assignedName`), add a "kanban" toggle button to the empty-slot placeholder so the operator can switch the dead slot to kanban mode:

```js
// Inside the !assignedName branch (empty-slot placeholder created at terminals.js:1579):
const emptySlot = document.createElement('div');
emptySlot.className = 'pane-empty-slot';
emptySlot.textContent = 'Click terminal in sidebar to assign';
const kanbanToggle = document.createElement('button');
kanbanToggle.className = 'pane-mode-toggle';
kanbanToggle.textContent = 'kanban mode';
kanbanToggle.title = 'Show a kanban column here instead';
kanbanToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    paneModes[index] = 'kanban';
    if (!kanbanPaneColumn[index]) { kanbanPaneColumn[index] = 'CREATED'; }
    saveLayoutSettings();
    renderPaneGrid();
    fetchBoardCardsForPane(index);
});
emptySlot.appendChild(kanbanToggle);
contentEl.appendChild(emptySlot);
```

### 5. Frontend — polling loop (`src/webview/terminals.js`)

Add a single interval that fetches `getKanbanStructure` + `getBoardCards` for every kanban-mode pane, only while at least one pane is in kanban mode:

```js
let kanbanPollTimer = null;
let kanbanColumnsCache = [];
let kanbanPaneColumn = []; // per-slot chosen column id
let kanbanPaneCards = {};  // index -> cards[]

function startKanbanPoll() {
    if (kanbanPollTimer) return;
    kanbanPollTimer = setInterval(pollKanbanPanes, 5000);
    pollKanbanPanes(); // immediate first fetch
}

function stopKanbanPoll() {
    if (kanbanPollTimer) { clearInterval(kanbanPollTimer); kanbanPollTimer = null; }
}

async function pollKanbanPanes() {
    const kanbanSlots = paneModes.map((m, i) => m === 'kanban' ? i : -1).filter(i => i >= 0);
    if (kanbanSlots.length === 0) { stopKanbanPoll(); return; }
    // Refresh column structure once per poll (cheap, cached server-side)
    try {
        const structRes = await fetch('/kanban/verb/getKanbanStructure', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        const structData = await structRes.json();
        if (structData.success) {
            kanbanColumnsCache = buildColumnList(structData.structure, structData.customColumns);
        }
    } catch { /* ignore — keep stale cache */ }
    for (const idx of kanbanSlots) {
        await fetchBoardCardsForPane(idx);
    }
}

async function fetchBoardCardsForPane(index) {
    const col = kanbanPaneColumn[index];
    if (!col) return;
    try {
        const res = await fetch('/kanban/verb/getBoardCards', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ column: col })
        });
        const data = await res.json();
        if (data.success) {
            kanbanPaneCards[index] = data.cards;
            // Re-render just this pane if it still exists and is still kanban mode
            const paneEl = paneGridEl.children[index];
            if (paneEl && paneModes[index] === 'kanban') {
                renderKanbanPane(paneEl, index);
            }
        }
    } catch { /* ignore — keep stale list */ }
}
```

Call `startKanbanPoll()` at the end of `renderPaneGrid()` if any slot is kanban mode; `stopKanbanPoll()` is self-correcting (the poll exits when no kanban slots remain).

### 6. Frontend — styles (`src/webview/terminals.html`)

Add CSS for the kanban-mode pane content (in the `<style>` block, near `.pane-empty-slot` at terminals.html:833):

```css
.kanban-pane-list {
    overflow-y: auto;
    height: 100%;
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.kanban-pane-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 4px 6px;
    border: 1px solid var(--border-color);
    border-radius: 3px;
    background: var(--panel-bg2);
}
.kanban-pane-row-title {
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
}
.kanban-pane-copy-btn {
    background: transparent;
    border: 1px solid var(--accent-teal);
    color: var(--accent-teal);
    font-size: 9px;
    font-family: inherit;
    padding: 2px 5px;
    border-radius: 2px;
    cursor: pointer;
    flex-shrink: 0;
}
.kanban-pane-copy-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--accent-teal) 12%, transparent); }
.kanban-pane-copy-btn:disabled { opacity: 0.5; cursor: default; }
.kanban-pane-column-picker {
    background: var(--panel-bg);
    color: var(--text-primary);
    border: 1px solid var(--border-bright);
    border-radius: 2px;
    font-size: 11px;
    font-family: inherit;
    padding: 0 2px;
    max-width: 120px;
}
.pane-mode-toggle {
    display: block;
    margin-top: 8px;
    background: transparent;
    border: 1px dashed var(--border-bright);
    color: var(--text-secondary);
    font-size: 10px;
    font-family: inherit;
    padding: 3px 8px;
    border-radius: 3px;
    cursor: pointer;
}
.pane-mode-toggle:hover { border-color: var(--accent-teal); color: var(--accent-teal); }
```

### 7. Solo-mode suppression

In `updatePaneElement()`, when `document.body.classList.contains('is-solo')`, force `paneModes[index] = 'terminal'` and skip the kanban toggle button. Solo mode pins one terminal and never offers grid choices (`terminals.html:971-973`).

## Dependencies

- None on other plans. Sibling subtasks in this feature touch `terminals.js`/`terminals.html` in different regions (this plan: `renderPaneGrid`/`updatePaneElement`/new CSS; the new-window subtask: `init()` + `.toolbar-actions`; the paste-images subtask: `materializeTerminalView` — which only ever runs for terminal-mode panes, so no interaction with kanban panes). See feature Dependencies & sequencing.

## Adversarial Synthesis

Key risks: state-model drift from `paneAssignments` (mitigated — `paneModes` pads to `getMaxSlotCount()` and never trims, mirroring the documented no-trim design); catalog desync from hand-editing a generated file (mitigated — verb added in source, `catalog:generate` run once, `catalog:check` verifies); unvalidated new verb at the HTTP boundary (mitigated — `verbSchemas.ts` entry per PRD contract #5); `promptSelected`'s advance side-effect surprising the operator (mitigated — "Copy & Advance" label, copy-only alternative via `copyPlanLink`). Polling is bounded (5s, only while a kanban pane exists) and the card pipeline is canonical, so the pane can never drift from the board.

## Verification Plan

> **Superseded:** Step 1 "…then `npm run compile` — must pass with no type errors" and step 7's "`paneModes` truncated to length 1 … truncated modes don't resurrect".
> **Reason:** (1) Session directive for this improvement pass — SKIP COMPILATION and SKIP TESTS: no project compilation and no automated tests run as part of verification. `npm run catalog:generate` is kept — it is code generation, not compilation, and produces `verbAllowlist.ts`, which the change requires. (2) Step 7 asserted the superseded trim behavior; `paneModes` is padded and never trimmed, so a kanban-mode slot's mode SURVIVES a shrink-grow round trip.
> **Replaced with:** The steps below.

1. **Codegen:** `npm run catalog:generate` (regenerates `protocol-catalog.json` + `verbAllowlist.ts` with `getBoardCards`), then `npm run catalog:check` — must pass.
2. **New verb smoke test:** With the extension running, `curl -X POST http://127.0.0.1:<port>/kanban/verb/getBoardCards -H 'Content-Type: application/json' -d '{"column":"CREATED"}'` returns `{success:true, cards:[…]}` matching the Kanban board's CREATED column. Compare card count against the board tab.
3. **Empty-slot → kanban mode:** Open the terminals panel in a 2x2 layout with 3 terminals assigned. The 4th pane shows "Click terminal in sidebar to assign" + a "kanban mode" button. Click it → the pane switches to a kanban column viewer with a column picker defaulting to CREATED.
4. **Column picker:** Change the picker to a different column → the list updates to that column's plans within 5s (or immediately on change).
5. **Copy & Advance:** Click "Copy & Advance" on a plan row → button shows "Copied!", the system clipboard contains the generated prompt (paste into any text field to verify), and the row disappears from the list on the next poll (card advanced to the next column). Verify in the Kanban board tab that the card moved.
6. **Switch back to terminal:** Click "term" in the kanban pane header → pane reverts to the empty terminal slot placeholder. `paneModes` persisted; reloading the page preserves the choice.
7. **Layout shrink-grow round trip:** Switch 2x2 → 1 while slot 3 is in kanban mode → the kanban pane element is removed, no JS errors, and `paneModes[2]` is RETAINED (padded, not trimmed). Switch back to 2x2 → slot 3 resurrects as a kanban pane with its previously chosen column (mirroring how a parked terminal assignment resurrects).
8. **Solo mode:** Open a solo terminal URL (`?solo=<name>`) → no "kanban mode" toggle appears on the pane; `paneModes` is forced to `['terminal']`.
9. **Poll lifecycle:** Confirm via devtools Network tab that `getBoardCards` requests stop within 5s of the last kanban-mode pane being switched back to terminal mode (no orphaned polling).
10. **No confirm dialogs:** No `window.confirm()` or modal appears during any of the above (per `CLAUDE.md` hard rule).

## Review Findings

Eight defects fixed, all in `src/webview/terminals.js`. Two CRITICAL: `renderKanbanPane` hijacked `actionsEl.children[0]` — the **pin** button — overwriting its `className` (destroying `btn-pin-pane`) and assigning `.onclick`, neither of which `updatePaneElement` restores, so after one mode round trip the pin lost its state styling and fired the mode handler alongside its own listener forever; and it hid clear/hide *individually*, which `updatePaneElement` never re-showed, so any pane that ever displayed kanban mode lost those buttons for the life of the page (panes are reused, not rebuilt). Fixed by giving the mode toggle its own button created in `createPaneElement` (now `children[3]`) and restoring the three displays explicitly. Six MAJOR: `fillEmptyPanes()` and the sidebar-click target scan both treated a kanban slot as a free seat, so Open All silently bulldozed the pane — kanban slots are now skipped for seating and only displaced as a deliberate last resort, with the mode reverted and the stale plan list stripped; the 5 s poll re-rendered the whole pane every tick, slamming an open column dropdown shut and resetting list scroll — now signature-gated with in-place picker reuse; `getBoardCards` had no in-flight guard, so a slow board overlapped requests and could render an out-of-order response — added a per-pane guard plus a post-response column re-check; the kanban empty state reused `.pane-empty-slot`, which stranded the pane on "No plans in …" with no toggle after switching back — now tagged `.kanban-pane-empty` and cleaned up; and solo mode *wrote* `paneModes[index]='terminal'` into a shared persisted setting, clobbering the cockpit window's choice — now suppress-only. Separately, the implementation commit broke a CI-wired contract that was green at `adbc5fd~1`: `terminal-pane-grid-reconcile-contract`'s "pane listeners are attached at creation, never per render" — caused both by a real `addEventListener` inside `updatePaneElement` (now delegated from `createPaneElement`) and by the five kanban helpers being inserted inside the pinned span (relocated below `resolveFlooredLayout`; the test was not weakened). Validation (run independently of the plan's superseded skip notes): `tsc --noEmit` clean apart from 5 pre-existing `TS2835` errors byte-identical in `adbc5fd~1`; `catalog:check`, `parity:check`, `push-routing:check`, `verb-returns:check` all green; 20/20 CI-wired terminal/pty/panel contract tests green. Remaining risks: the new arm reads config via `vscode.workspace.getConfiguration` rather than a seam — nominally PRD contract #3, but it is the canonical `getFullStateMessages` pattern and the standalone bundle aliases `vscode` to `vscodeShim.ts`, so it does run headless; and `Copy & Advance`'s advance side-effect is still only surfaced by the button label.

## Completion Summary

Implemented the kanban-mode pane. Added a `getBoardCards` verb to `KanbanProvider._handleMessage` (reuses the canonical `_buildBoardCards` pipeline with optional `column` filter, `getWorkspaceId`/`getDominantWorkspaceId` fallback) and a permissive `KANBAN_VERB_SCHEMAS.getBoardCards` entry in `src/services/verbSchemas.ts`; ran `npm run catalog:generate` + `npm run catalog:check` (both green) so `getBoardCards` reached `protocol-catalog.json` and `src/generated/verbAllowlist.ts`. In `src/webview/terminals.js`, added a parallel `paneModes`/`kanbanPaneColumn` state model (padded to `getMaxSlotCount()`, never trimmed — mirroring `paneAssignments`' no-trim design), persisted via `loadLayoutSettings`/`saveLayoutSettings`; `updatePaneElement` branches to `renderKanbanPane` for kanban-mode empty slots, adds a "kanban mode" toggle to the empty-slot placeholder (suppressed in solo + single-slot grids), and forces `paneModes='terminal'` in solo mode. Added `renderKanbanPane` (column picker + "term" toggle + plan rows with "Copy & Advance" hitting `promptSelected`), a self-correcting 5s `startKanbanPoll`/`pollKanbanPanes`/`fetchBoardCardsForPane` loop, and `buildColumnList`. Added CSS for the kanban pane content in `src/webview/terminals.html`. `npm run verb-returns:check`, `parity:check`, and `push-routing:check` all pass. No issues encountered.

## Reviewer Pass (2026-08-05)

Direct in-place reviewer pass completed with eight defect fixes plus one broken-contract repair, all in `src/webview/terminals.js`. The two CRITICALs both came from `renderKanbanPane` repurposing the pane header's pin button — it destroyed the pin's class and handler and hid clear/hide with no restore path — now resolved by giving the mode toggle its own button in `createPaneElement`. The MAJORs covered seating paths bulldozing the pane on Open All, the 5 s poll fighting the operator's own dropdown and scroll position, a missing in-flight guard, a stranded empty state, and a solo-mode write into shared persisted settings. Separately, the implementation commit had turned `terminal-pane-grid-reconcile-contract` red (green at `adbc5fd~1`); fixed by delegating the toggle listener and relocating the kanban helpers out of the test's pinned span, with the test left untouched. Verification was run independently of this file's superseded skip notes: `tsc --noEmit` shows no new errors, all four ratchet/parity gates are green, and 20/20 CI-wired terminal/pty/panel contract tests pass.
