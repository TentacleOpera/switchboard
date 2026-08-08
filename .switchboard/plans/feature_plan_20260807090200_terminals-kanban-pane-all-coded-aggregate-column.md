# Add an "All Coded" Aggregate Option to the Terminals Kanban-Pane Column Picker

## Goal

The kanban-mode pane in the Terminals panel can show exactly one column at a time. The board itself collapses the three coder columns into a single **AUTOCODE** bucket, so the operator's normal view of "what is out for coding" is one column — but in a terminal pane they have to pick Lead Coder *or* Coder *or* Intern and watch only a third of the work. Add a fourth picker entry, **ALL CODED**, that shows the union of `LEAD CODED`, `CODER CODED` and `INTERN CODED`, alongside (not replacing) the three individual options.

### Problem analysis and root cause

The pane's picker is built from whatever `getKanbanStructure` returns:

- `fetchKanbanColumnStructure` (`src/webview/terminals.js:2947`) calls the verb and stores the result via `buildColumnList` (`terminals.js:2457`) into `kanbanColumnsCache`.
- `renderKanbanPane` (`terminals.js:2565`) renders one `<option>` per cache entry (`terminals.js:2655-2660`).
- `fetchBoardCardsForPane` (`terminals.js:2978`) posts the chosen id as `getBoardCards`'s `column` filter, which the handler applies as a flat `cards.filter(c => c.column === column)` (`src/services/KanbanProvider.ts:10670`).

`getKanbanStructure` returns **stored, writable** columns only — one entry per real column. AUTOCODE is not one of those: it is a *display-only* label. `src/services/agentConfig.ts:167-169` declares it as `DISPLAY_ONLY_COLUMN_LABELS = { 'AUTOCODE': { aliasOf: ['LEAD CODED', 'CODER CODED', 'INTERN CODED'] } }`, and the board synthesises it client-side at render time when `collapseCodersEnabled` is on (`src/webview/kanban.html:4216-4222` and the render pass below it, id `CODED_AUTO`, label `AUTOCODE`).

So there are two root causes, and both matter for the implementation:

1. **The picker has no source for a synthetic entry.** It renders the structure verbatim, and the structure will never contain an aggregate.
2. **The server deliberately refuses AUTOCODE as a column ref.** The label-resolution pass in `LocalApiServer` explicitly excludes display-only labels — "a many→one label must never resolve by picking one" (`src/services/LocalApiServer.ts:1139-1152`, `_unknownColumnError`), and `src/test/kanban-auto-export.test.ts:454-458` asserts that refusal. Passing `AUTOCODE` or `CODED_AUTO` to `getBoardCards` as `column` would filter to zero cards (the handler's filter is a literal string compare, so it silently returns an empty list rather than erroring — a worse failure than a 400).

**Confirmed by grep this session:** `CODED_AUTO` appears **nowhere** in `src/services/*.ts`. It exists only in `src/webview/kanban.html` and in webview regression tests. There is no server-side resolution path for it at all — not in `DISPLAY_MODE_COLUMNS`, not in `LEGACY_COLUMN_LABELS`, not in `DEFAULT_KANBAN_COLUMNS`. Sending it is guaranteed to produce an empty list, never an error.

The aggregate therefore has to be resolved **client-side in the pane**, exactly as the board resolves it client-side: fetch the unfiltered card set once and select the coded columns locally.

### Deliberate decision: always offered, not tied to the board's collapse toggle

`collapseCodersEnabled` is board-view state persisted in the board's own view state (`kanban.html`, the collapse toggle and its persistence). The user asked for the aggregate **in addition to** the three individual options, so the pane offers all four unconditionally and does not read the board's toggle. That keeps the pane independent of another panel's view preference and matches the ask.

### Line references

All `terminals.js` / `KanbanProvider.ts` / `agentConfig.ts` / `LocalApiServer.ts` line numbers in this plan were **re-verified against HEAD on 2026-08-07**. A previous revision carried references that had drifted by roughly 39 lines in `terminals.js` (the file has grown since the plan was first written). The corrected numbers are used throughout. Treat symbol names as the durable anchor and line numbers as a convenience — re-grep before editing.

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, feature
**Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine
- Appending one synthetic entry to the picker's option list.
- A `column` chip on each row so a merged list is legible.
- Empty-state and title text mapping the synthetic id to its label.
- One CSS rule in `terminals.html`.

### Complex / Risky
- **Never send the synthetic id to the server.** `fetchBoardCardsForPane` must branch: for `CODED_AUTO`, omit `column` entirely and filter client-side. Sending it yields a silent empty list (see root cause 2) that looks exactly like "no work out for coding" — the most misleading possible failure.
- **Identifying the coded columns without hardcoding.** The three ids are the built-in defaults (`agentConfig.ts:136-138`, each carrying `kind: 'coded'`), but a custom column can carry that kind too — `_buildSetupKanbanStructure` passes `kind` straight through (`src/services/TaskViewerProvider.ts:3860`), which this session verified. `buildColumnList` currently **drops** `kind` (`terminals.js:2457-2468`) — it must be preserved, and the aggregate derived from it, or a workspace with a custom coded column gets a wrong union.
- **Body-signature completeness.** `renderKanbanPane`'s render skip is keyed on `bodySig` (`terminals.js:2694-2696`), which does not include `c.column`. In aggregate mode a card moving Lead → Coder changes only its column, so the signature would not change and the chip would show the stale column indefinitely.
- **Persistence round trip.** `CODED_AUTO` gets saved to `terminals.kanbanPaneColumn` (`terminals.js:773`). On reload, before the structure lands, the picker's fallback builds a single option from the raw `chosen` id (`terminals.js:2578-2580`) — which would print the literal `CODED_AUTO` as a label unless that path is taught the synthetic label too.

## Edge-Case & Dependency Audit

- **Race Conditions:**
  - The in-flight guard `kanbanFetchInFlight` (`terminals.js:2986`) and the post-response re-check `kanbanPaneColumn[index] === col` (`terminals.js:2998`) both key on the chosen column string. Using `CODED_AUTO` as that key keeps both guards intact — the aggregate is still one request per pane per tick, so no new overlap window is introduced. Do NOT implement the aggregate as three parallel `getBoardCards` calls: that would need a three-way completion barrier inside a guard designed for one response, and a picker change mid-flight could interleave two columns' cards under one heading.
  - **`codedColumnIds()` is read twice per cycle** — once when the request is built and once when the response is filtered. `fetchKanbanColumnStructure` can land between them (both run inside `pollKanbanPanes`, `terminals.js:2963-2976`), so the union used for filtering may differ from the one used at request time. This is benign: the request carries no column at all, so a changed union only changes which of the already-fetched cards are shown, and the next tick converges. Do not "fix" it by caching the union across the await — a stale union is worse than a fresh one.
  - A card advancing out of a coded column while the pane is open resolves on the next 5 s poll tick, same as today.
- **Security:** No new verb, no new endpoint, no change to the refusal logic in `LocalApiServer` (`_unknownColumnError`'s explicit handling of display-only labels stays exactly as-is — this plan does **not** make AUTOCODE writable). Purely additive client-side filtering.
- **Side Effects:**
  - The aggregate fetch requests the board with **no** column filter, so the response is the full display card set instead of one column's slice. On a large board that is a bigger payload per 5 s tick per aggregate pane. Acceptable: `getBoardCards` already builds the entire card set server-side regardless (`KanbanProvider.ts:10667` runs `_buildBoardCards` *before* any filtering), so this adds transfer, not server work. Only panes actually set to ALL CODED pay it.

    > **Superseded:** "Feature roll-up, project filtering and repo-scope filtering all happen server-side **before** the column filter (`KanbanProvider.ts:10491-10499`), so an unfiltered fetch inherits them unchanged."
    > **Reason:** Factually wrong about the order, verified against HEAD. The actual `getBoardCards` pipeline is: repo-scope filter at the DB read (`KanbanProvider.ts:10658-10664`) → `_buildBoardCards` (`:10667`) → **column filter first** (`:10670`) → feature roll-up `filter(c => !c.featureId)` (`:10680`) → project filter (`:10684-10686`). Roll-up and project filtering run *after* the column filter, not before it.
    > **Replaced with:** The conclusion still holds, but for a different reason: roll-up and project filtering are both **per-card predicates that do not depend on the column filter's result**. `!c.featureId` and `(c.project || '') === msg.project` evaluate identically whether or not the set was narrowed first, so `filter(column) → filter(roll-up) → filter(project)` and `filter(roll-up) → filter(project) → client-side filter(coded)` produce the same rows. The aggregate cannot leak subtasks or out-of-project cards. Set-commutativity of independent predicates is the guarantee — not an ordering claim.

  - The response's `projects` array is `await db.getProjects(wsId)` (`KanbanProvider.ts:10689`) — a **workspace-wide** DB read, not derived from the filtered card set. So the aggregate's unfiltered fetch returns the *same* project list a single-column fetch returns, and `kanbanPaneProjectsCache` / the workspace-project picker are unaffected. No change needed there.
  - Per-card actions are unaffected: **Copy Prompt** posts `card.column` (`terminals.js:2844`) and drag-dispatch posts `card.column` (`terminals.js:2753`). Both already use the card's own real column, so a merged list dispatches correctly with no change.
  - **Empty-state text changes for single-column mode too.** Today `empty.textContent` prints the raw column **id** (`No plans in LEAD CODED`, `terminals.js:2714`). Routing it through `columnLabelForId` prints the **label** (`No plans in Lead Coder`). That is an intended, strictly-better side effect — the picker above it already shows labels, so the two now agree — but it is a visible change to existing behaviour and should not surprise a reviewer.
- **Dependencies & Conflicts:**
  - Files: `src/webview/terminals.js`, `src/webview/terminals.html`. No `.ts` change, no `protocol-catalog.json` regeneration, no migration (`terminals.kanbanPaneColumn` is a per-slot string array; an older build reading `CODED_AUTO` posts it as a column filter and renders an empty pane — visibly harmless and self-correcting once the picker is changed back).
  - **No sibling conflict — this plan is now independent.** The feature's other subtask (`feature_plan_20260807090100_terminals-pane-memo-mode.md`) was replaced: it no longer adds a memo *pane mode* to `terminals.js`, it presents the existing `/memo` panel as a shell modal (`shell.js`, `shell.html`, `headlessPanelHtml.ts`). It touches neither file this plan touches. The earlier revision's strict "this plan lands FIRST, never run them concurrently" constraint was a consequence of the pane design and is **void** — the two subtasks may now run in parallel, in either order.
  - The synthetic id `CODED_AUTO` is chosen to match the board's own synthetic column id (`kanban.html:4216-4222`) so the two surfaces name the same concept identically. The **label** is `ALL CODED` per the ask; the option title spells out the mapping.

## Dependencies

- None. No prior plan must land first; this is self-contained within `terminals.js` / `terminals.html`.

## Adversarial Synthesis

**Risk Summary:** The load-bearing risk is the silent-empty failure — `getBoardCards` filters columns with a literal string compare, so posting `CODED_AUTO` returns `[]` that reads as "nothing is out for coding" rather than as an error; the fetch branch that omits `column` entirely is the whole plan's correctness hinge. Two secondary risks: `buildColumnList` dropping `kind` would silently exclude a custom coded column from the union, and `bodySig` omitting `c.column` would freeze the per-row chip on its first value forever. Mitigations: derive the union from live `kind === 'coded'` structure data rather than hardcoded ids, add `c.column` to `bodySig`, include the union in `pickerSig` so a hidden coder agent rebuilds the option set, and gate the option on `coded.length > 1` so it is never offered when it would just duplicate a single column.

## Proposed Changes

### 1. `src/webview/terminals.js` — preserve `kind` and derive the aggregate

`buildColumnList` (line 2457) currently drops `kind`:

```js
function buildColumnList(structure, customColumns) {
    const list = [];
    if (Array.isArray(structure)) {
        for (const item of structure) {
            if (item && item.id) {
                list.push({
                    id: item.id,
                    label: item.label || item.id,
                    role: item.role || null,
                    // kind is what identifies a coder column ('coded'). Sourced from
                    // the live structure (TaskViewerProvider._buildSetupKanbanStructure
                    // passes it through, TaskViewerProvider.ts:3860), so a custom coded
                    // column joins the ALL CODED union automatically instead of being
                    // silently excluded.
                    kind: item.kind || null,
                    order: Number(item.order) || 0
                });
            }
        }
    }
    list.sort((a, b) => (a.order - b.order) || String(a.label).localeCompare(String(b.label)));
    return list;
}
```

New module-level constants and helpers (place beside `defaultKanbanWorkspace`, line 2550):

```js
/** Synthetic, DISPLAY-ONLY column id for the coder aggregate. Matches the id the
 *  board uses for its collapsed bucket (kanban.html:4216-4222) so both surfaces
 *  name the same concept. It is NOT a stored column: it exists nowhere in
 *  src/services/*.ts, and the server refuses AUTOCODE as a column ref on purpose
 *  (LocalApiServer.ts:1139-1152 — a many→one label must never resolve by picking
 *  one of its backing columns), so this id must never be sent as getBoardCards'
 *  `column`. getBoardCards compares columns with a literal `===`, so sending it
 *  returns an EMPTY list rather than an error. */
const AGGREGATE_CODED_ID = 'CODED_AUTO';
const AGGREGATE_CODED_LABEL = 'ALL CODED';

/** The real column ids the aggregate covers, from the live structure. Empty
 *  until the first getKanbanStructure lands — which is why the aggregate option
 *  is only offered once the cache is populated. */
function codedColumnIds() {
    return kanbanColumnsCache.filter(c => c.kind === 'coded').map(c => c.id);
}

/** Human label for a chosen picker value, synthetic id included. */
function columnLabelForId(id) {
    if (id === AGGREGATE_CODED_ID) { return AGGREGATE_CODED_LABEL; }
    const hit = kanbanColumnsCache.find(c => c.id === id);
    return hit ? hit.label : (id || '—');
}
```

### 2. `src/webview/terminals.js` — offer the option

In `renderKanbanPane`, replace the `columns` / `pickerSig` derivation at lines 2578-2581:

```js
const coded = codedColumnIds();
const liveColumns = (kanbanColumnsCache.length > 0)
    ? kanbanColumnsCache
    // Pre-structure fallback: label the synthetic id properly instead of
    // printing the raw 'CODED_AUTO' at the operator.
    : (chosen ? [{ id: chosen, label: columnLabelForId(chosen) }] : []);

// Appended, never substituted: the three individual coder columns stay in the
// picker. Only offered when the structure has landed and actually has MORE THAN
// ONE coded column — codedColumnIds() is the union's definition, so a one-column
// union would be a duplicate option and an empty one an option that can only
// ever show zero cards.
const columns = (kanbanColumnsCache.length > 0 && coded.length > 1)
    ? liveColumns.concat([{
        id: AGGREGATE_CODED_ID,
        label: AGGREGATE_CODED_LABEL,
        aggregate: true
      }])
    : liveColumns;

// pickerSig must move when the union changes, or hiding a coder agent in Setup
// leaves a stale option set on screen.
const pickerSig = columns.map(c => `${c.id} ${c.label}`).join('') + '|' + coded.join(',');
```

In the option loop (line 2655):

```js
for (const col of columns) {
    const opt = document.createElement('option');
    opt.value = col.id;
    opt.textContent = col.label;
    if (col.aggregate) {
        opt.title = `Union of ${coded.join(' + ')} — the board's AUTOCODE bucket`;
    }
    picker.appendChild(opt);
}
```

**Edge case — the selected option can vanish.** `if (chosen && picker.value !== chosen) { picker.value = chosen; }` (line 2672) is a no-op when `chosen` is not among the options. If the operator has `CODED_AUTO` selected and then hides coder agents in Setup until only one coded column remains, the aggregate option disappears from a rebuilt picker while `kanbanPaneColumn[index]` still holds `CODED_AUTO`. The `<select>` then displays its first option while the pane still renders the aggregate — picker and content disagree. Handle it in the same block: if `chosen === AGGREGATE_CODED_ID && coded.length <= 1`, reset `kanbanPaneColumn[index]` to `coded[0] || 'CREATED'`, `saveLayoutSettings()`, and refetch. Do this *before* building the options so the picker is built against the corrected value.

### 3. `src/webview/terminals.js` — fetch without sending the synthetic id

In `fetchBoardCardsForPane` (line 2978):

```js
async function fetchBoardCardsForPane(index) {
    const col = kanbanPaneColumn[index];
    if (!col) { return; }
    if (kanbanFetchInFlight.has(index)) { return; }
    kanbanFetchInFlight.add(index);
    try {
        const wsRoot = kanbanPaneWorkspace[index];
        const proj = kanbanPaneProject[index] || '';
        const isAggregate = col === AGGREGATE_CODED_ID;
        // The aggregate omits `column` entirely rather than sending CODED_AUTO.
        // getBoardCards' filter is a literal `c.column === column` compare
        // (KanbanProvider.ts:10670), so sending the synthetic id returns an EMPTY
        // list — indistinguishable from "nothing is out for coding". Server-side
        // repo-scope, feature roll-up and project filters are per-card predicates
        // independent of the column filter, so an unfiltered fetch inherits them
        // unchanged (see the Side Effects audit).
        const body = { workspaceRoot: wsRoot, project: proj };
        if (!isAggregate) { body.column = col; }
        const res = await fetch('/kanban/verb/getBoardCards', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (data.success && kanbanPaneColumn[index] === col) {
            const all = Array.isArray(data.cards) ? data.cards : [];
            const codedNow = codedColumnIds();
            kanbanPaneCards[index] = isAggregate
                ? all.filter(c => codedNow.includes(c.column))
                : all;
            // …existing projects cache + re-render, unchanged…
```

Two details that must not be lost from the existing body:
- The post-response `kanbanPaneColumn[index] === col` re-check (line 2998) is kept **verbatim** — it is what stops a picker change mid-flight from rendering the wrong set.
- `kanbanPaneCards[index] = data.cards` currently assigns the raw value. The `Array.isArray` normalisation above is a deliberate hardening: `bodySig` maps over this array, so a non-array would throw inside the render path.

### 4. `src/webview/terminals.js` — make the merged list legible

`bodySig` (line 2694) must react to a card changing column:

```js
const bodySig = `${chosenWs || ''} ${chosenProj || ''} ${chosen || ''} ${hasFetched ? '1' : '0'}`
    + cards.map(c => `${c.planId || c.sessionId || ''} ${c.topic || c.title || ''} ${c.complexity || ''} ${c.working ? 'w' : ''} ${c.project || ''} ${c.isFeature ? 'f' : ''} ${c.subtaskCount || 0} ${c.column || ''}`).join('');
```

Empty state (line 2714):

```js
empty.textContent = `No plans in ${columnLabelForId(kanbanPaneColumn[index])}`;
```

Per-row column chip, appended in the row `meta` block after the project chip (line 2804):

```js
// In aggregate mode the list merges three columns, so each row must say which
// one it is in — otherwise the operator cannot tell lead work from intern work,
// and the chip is the only thing that distinguishes them.
if (chosen === AGGREGATE_CODED_ID && card.column) {
    const colChip = document.createElement('span');
    colChip.className = 'kanban-pane-column-chip';
    colChip.textContent = columnLabelForId(card.column);
    colChip.title = card.column;
    meta.appendChild(colChip);
}
```

### 5. `src/webview/terminals.html` — chip CSS

Add beside `.kanban-pane-project` (line 994):

```css
.kanban-pane-column-chip {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.4px;
    padding: 0 3px;
    border-radius: 2px;
    color: var(--accent-teal);
    background: color-mix(in srgb, var(--accent-teal) 16%, transparent);
    flex-shrink: 0;
}
```

## Verification Plan

### Automated Tests

No new automated tests, and **no test run is performed in this session** (session directive: skip tests). Two existing assertions constrain this work and must be preserved by inspection rather than by execution:

- `src/test/kanban-auto-export.test.ts:454-458` asserts `AUTOCODE` refuses as a column ref and that the refusal names its three backing ids. This plan touches no `.ts` file, so the assertion is untouched by construction — confirm by diff that `src/services/LocalApiServer.ts` and `src/services/agentConfig.ts` are unmodified.
- `src/test/kanban-subtask-column-leak-regression.test.js:104-109` asserts the board's own `CODED_AUTO` branch excludes subtasks. This plan does not touch `kanban.html`; the pane's equivalent guarantee comes from the server-side `!c.featureId` roll-up (`KanbanProvider.ts:10680`), covered by manual step 11.

### Manual

1. **Option appears.** Open `/terminals`, put a pane in kanban mode. Once the structure has loaded (≤30 s, or immediately on the mode-toggle's direct fetch), the column picker lists `Lead Coder`, `Coder`, `Intern` **and** `ALL CODED`. Hovering `ALL CODED` shows `Union of LEAD CODED + CODER CODED + INTERN CODED — the board's AUTOCODE bucket`.
2. **Union is correct.** With known cards seeded in all three coder columns, select `ALL CODED` and confirm the row count equals the sum of the three individual columns, and that selecting each individual column still shows only its own cards.
3. **No silent-empty regression.** Watch the network tab while `ALL CODED` is selected: the `getBoardCards` request body must have **no** `column` key. Confirm the pane is populated, not empty — this is the failure the branch exists to prevent.
4. **Chips.** In `ALL CODED`, every row carries a column chip naming its real column. Chips are absent when a single column is selected.
5. **Chip freshness.** With `ALL CODED` open, move a card from Lead Coder to Coder on the board. Within one 5 s poll tick the row's chip updates — this is the `bodySig` fix; without it the chip stays stale forever.
6. **Copy Prompt.** Click **Copy Prompt** on a row in `ALL CODED` that lives in `INTERN CODED`. Confirm the prompt copied is the intern-column prompt and the card advances out of `INTERN CODED` (not out of Lead).
7. **Drag dispatch.** Drag a row from `ALL CODED` onto a terminal pane. Confirm the dispatched prompt matches the row's real column.
8. **Empty state.** Empty all three coder columns. The pane reads `No plans in ALL CODED`, not `No plans in CODED_AUTO`.
9. **Empty state, single column.** Select `Lead Coder` with that column empty. The pane now reads `No plans in Lead Coder` (the label), where it previously read `No plans in LEAD CODED` (the id). Confirm this intended change.
10. **Persistence.** With `ALL CODED` selected, reload the panel. The pane returns to `ALL CODED` with the correct label showing even in the first paint before the structure lands (the fallback path), and repopulates.
11. **Project filter composes.** Set the pane's workspace/project picker to a specific project while in `ALL CODED`. Confirm only that project's coded cards appear — the server-side project filter must still apply through the unfiltered fetch.
12. **Feature roll-up composes.** With a feature whose subtasks sit in coder columns, confirm `ALL CODED` shows the feature card and NOT its loose subtasks (server-side roll-up preserved).
13. **Project picker unchanged.** Confirm the workspace/project dropdown offers the same project list in `ALL CODED` as in a single column — `projects` is a workspace-wide DB read, so the unfiltered fetch must not widen or narrow it.
14. **Custom coded column.** Add a custom column with `kind: 'coded'` in Setup. Confirm it joins the `ALL CODED` union and appears in the option's tooltip — this is what preserving `kind` in `buildColumnList` buys.
15. **Hidden coder agent.** Hide the Intern agent in Setup so its column drops out of the structure (`_filterVisibleColumns`, `TaskViewerProvider.ts:3827-3839`). Confirm the tooltip and union narrow to two columns within the 30 s structure refresh, and that the picker rebuilds (the `pickerSig` now includes the union).
16. **Union collapses to one while selected.** With `ALL CODED` selected, hide coder agents until only one coded column remains. Confirm the pane does NOT strand on a picker showing one label while rendering another — it resets to the surviving coded column (or `CREATED`) and refetches.
17. **Single coder column.** In a workspace where only one column has `kind: 'coded'`, confirm `ALL CODED` is **not** offered (it would duplicate that column).
18. **No open dropdown slam.** Open the column picker and hold it open across a 5 s poll tick. It must not close or lose focus — the `pickerSig` gate must still short-circuit the header rebuild.

## Recommendation

**Complexity 4 → Send to Coder.**
