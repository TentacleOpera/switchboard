# Extract the kanban column-set derivation into a shared webview script

<!-- board-collapse-01 -->
> **RESCOPED 2026-09-04 (Board Collapse 01).** Steps 5 to 7 are **already built in the working tree** (`kanban.collapseCodersEnabled`, the `toggleCollapseCoders` verb and allowlist entry, the `collapseCodersState` pushes). Only the extraction of `buildDisplayColumns` into `sharedKanbanColumns.js` remains. Rewrite the Goal to the extraction alone, and verify the working-tree state before starting rather than assuming it.


## Goal

Make the terminals kanban pane and the kanban board derive their column list from **one** piece of code, so the pane cannot disagree with the board about which columns exist, what they are called, or what order they appear in.

### ⚠ Scope has changed — read this first

**The three visible defects this plan was written to fix are already fixed, in the working tree, by hand — in both surfaces' own copies of the logic.** What remains is *only* the extraction: collapsing the two independent-but-currently-agreeing implementations into one shared function, so they cannot drift apart again. Verified at the time of this pass (uncommitted working-tree state, `git status` shows `src/webview/terminals.js`, `src/webview/kanban.html`, `src/services/KanbanProvider.ts`, `src/test/browser-kanban-pane-order.test.js` all modified):

| Original step | Status |
|---|---|
| 1. Create `src/webview/sharedKanbanColumns.js` | **TODO** — file does not exist |
| 2. Wire the shared script into both hosts | **TODO** — and the mechanism is wrong, see Architecture decision |
| 3. Rewire the board's `renderColumns()` | **TODO** — `kanban.html:6227-6247` still holds its own `filter/concat/sort` |
| 4. Rewire the pane's `renderKanbanPane()` | **TODO** — `terminals.js:5015-5030` still holds its own `filter/concat/sort` |
| 5. Pane selection snapping (both directions, structure-gated) | **DONE** — `terminals.js:4983-5006` |
| 6. Host state plumbing (setting / verb / push / structure field) | **DONE** — see below |
| 7. Board write-through (`toggleCollapseCoders` + `collapseCodersState` adoption) | **DONE** — `kanban.html:10089` and `kanban.html:8965` |
| 8. Replace the pinning tests | **TODO** — but for the opposite reason the plan gives, see below |

Step 6 in detail, all present: `kanban.collapseCodersEnabled` scoped setting (`KanbanProvider.ts:478`, re-read at `842`), the `toggleCollapseCoders` arm following the `toggleDynamicComplexityRouting` pattern (`KanbanProvider.ts:9060-9075`, already in `src/generated/verbAllowlist.ts`), `collapseCodersState` pushes from the full-state builders (`KanbanProvider.ts:2148`, `3684`, `3881`), `collapseCoders` on the `getKanbanStructure` **return body** as well as the push (`KanbanProvider.ts:11301-11306`), and the pane reading `structData.collapseCoders !== false` (`terminals.js:5545`).

**The residual work is therefore a pure refactor with no behaviour change** — which raises the bar on the verification, not lowers it: the only way to know the extraction is correct is that both surfaces still render exactly what they render today.

### The problem (preserved — this is the history that produced the current code)

The terminals pane's column picker offered an aggregate option labelled `ALL CODED`, appended to the **end** of the list (after `Completed`), and shown **unconditionally**. The board renders the same concept as `AUTOCODE`, **substituted in place** of the coder columns at their own order slot, and **only** when the "collapse coders" toggle is on. Three visible defects, one cause.

### Root cause

`src/webview/terminals.js` re-implements a decision that `src/webview/kanban.html` already makes. The board's version lives inside `renderColumns()` (`kanban.html:6227`):

```
filter(d => d.kind !== 'coded')  →  concat(synthetic {id:'CODED_AUTO', label:'AUTOCODE', order: coderDefs[0].order || 180})  →  sort by order
```

The pane's version (`terminals.js:5015`) was written independently and drifted on all three axes. **Nothing structural prevents the drift, and it will recur on the next column-model change** (a new `kind`, a reordered built-in, a new collapse rule). The hand-fix now in the working tree brought the pane's copy into agreement with the board's — it did not remove the second implementation, so the structural cause is untouched. That is exactly what this plan still exists to fix.

A fourth axis is latent and will bite the naive fix: the board **stores** `'AUTOCODE'` in caps and relies on `.column-name { text-transform: uppercase }` (`kanban.html:759-764`, verified) to display every label that way — its stored labels are title case (`New`, `Planned`, `Lead Coder`). The pane's picker is a plain `<select>` with **no** text-transform, so it renders labels raw. Sharing the board's literal string would reintroduce the caps defect on the pane. The shared function must return title case and let the board's CSS keep doing its job.

A fifth: the collapse toggle itself was unreadable from the pane. `collapseCodersEnabled` lived in the kanban webview's `vscode.getState()`, which is per-webview. **This one is resolved** — the host-side setting, verb, push and structure-response field listed in the scope table above are all in place, and `kanban.html:4888-4897` now keeps `vscode.getState()` only as a pre-hydration mirror.

> **Superseded:** "Existing regression tests made this worse, not better — `browser-kanban-pane-order.test.js` asserted the buggy shape by regex (`coded.length > 1` and the tail `concat`), so a correct fix turns those tests red. This plan replaces that class of assertion for this feature with a single parity assertion."
> **Reason:** Factually no longer true, and the replacement is now *more* urgent, not less. Those two assertions are already gone; the file was rewritten alongside the hand-fix and now pins the **correct** shape. But it pins it **as source text inside `terminals.js`** — `liveColumns.filter(c => c.kind !== 'coded')`, `order: kanbanColumnsCache.find(c => c.kind === 'coded')?.order || 180`, `.sort((a, b) => (a.order || 0) - (b.order || 0))`, `doesNotMatch(/liveColumns\.concat\(\[\s*\{\s*\n?\s*id:\s*AGGREGATE_CODED_ID/)`, and the `AGGREGATE_CODED_LABEL` declaration. Moving that logic into `sharedKanbanColumns.js` deletes every one of those strings from `terminals.js`, so **the extraction turns these tests red** — the tests now pin the duplication this plan exists to remove.
> **Replaced with:** Step 8 stands, retargeted: the assertions to replace are the five listed above, in `test('the aggregate SUBSTITUTES for the coder columns and keeps their order slot')` and `test('the aggregate label is title case, not SHOUTED')`. They become direct unit tests of `buildDisplayColumns` (which can assert *behaviour*, not text) plus the parity assertion. The three surviving pane tests — `aggregateOffered` gating, `structureLanded` gating, and the `!== false` structure read — stay: they pin pane-local logic the extraction does not move.

## Investigation findings — can `terminals.js` import anything?

**No ES modules. But a shared-script mechanism already exists and already reaches both files.** Re-verified this pass:

| Question | Finding |
|---|---|
| Is `terminals.js` a module? | No. `terminals.html:2058` loads it as `<script nonce src="{{TERMINALS_JS_URI}}">` with no `type="module"`, and the file is wrapped in an IIFE (`(function() { 'use strict';`). `import` would throw. |
| Is there an existing sharing pattern? | Yes — `sharedUtils.js`, `sharedDefaults.js`, `transport.js`. Plain scripts declaring top-level functions, loaded **before** the consumer, consumed as globals. |
| Does `kanban.html` load external scripts? | It has exactly one `<script>` tag and it is inline — **but** it carries `<!-- SHARED_DEFAULTS_SCRIPT -->` at `kanban.html:3605`, which both hosts replace with script tags. No new mechanism is needed. |
| Does `terminals.html` carry that marker too? | **Yes — `terminals.html:2053`**, immediately above the xterm tags and `{{TERMINALS_JS_URI}}`. This is the finding that changes the wiring plan; see Architecture decision. |
| VS Code host wiring | `KanbanProvider.ts:12361-12362` builds `sharedDefaultsUri` via `webview.asWebviewUri(... 'dist','webview','sharedDefaults.js')` and injects it by **replacing the marker comment**, not a `{{X_URI}}` placeholder. |
| Headless/browser host wiring | `headlessPanelHtml.ts:73-88` `injectTransportShim(content, nonce, marker, firstScript, expectMarker)` replaces the same marker with `sharedDefaults.js` + `transport.js`; falls back to injecting before `firstScript` when the marker is absent, and `expectMarker` warns on that fallback (`kanban.html` and `setup.html` pass `true`). Kanban: `headlessPanelHtml.ts:182`. Terminals: `headlessPanelHtml.ts:408`. |
| Who serves `terminals.html` in the **VS Code** host? | **Nobody — there is no VS Code webview provider for it.** `{{TERMINALS_JS_URI}}` is replaced in exactly one place in the repo: `headlessPanelHtml.ts:399`. The panel is HTTP-served via `LocalApiServer.ts:4056` (`/terminals`) in both hosts. The plan's "add a placeholder in the terminals panel provider" step has no second host to wire. |
| Build config change needed? | **No.** `webpack.config.js:86-89` copies `src/webview/*.js` → `dist/webview/[name][ext]` by glob. A new file is picked up automatically. |
| CSP blocker? | No. `terminals.html:5` is `script-src 'nonce-{{NONCE}}' 'self'`; a same-origin nonce'd tag is fine. The headless kanban CSP (`headlessPanelHtml.ts:179`) is likewise `'nonce-… 'self'`. |

**Conclusion:** the shared unit must be a plain (non-module) script exposing a global. Both consuming files already carry the same injection marker, so the wiring is three edits to existing replacement sites — no new placeholder, no new marker, no new mechanism.

## Architecture decision

Add `src/webview/sharedKanbanColumns.js` exposing one pure function:

```
buildDisplayColumns(columns, { collapseCoders }) -> [{ id, label, kind, order, aggregate? }]
```

- **Input** is the already-ordered `{id,label,role,kind,order}` list both surfaces already hold (`columnDefinitions` on the board, `kanbanColumnsCache` in the pane).
- **Pure** — no DOM, no fetch, no `vscode` handle. That is what makes it testable without a webview harness.
- Returns the aggregate as `{ id: 'CODED_AUTO', label: 'Autocode', kind: 'coded', order: <first coded column's order || 180>, aggregate: true }`, substituted for the coder columns, list re-sorted by `order`.
- **Title case, not `AUTOCODE`.** The board keeps its `text-transform: uppercase`; the pane renders raw. One string, correct on both surfaces.

Each surface renders the returned list its own way — the board emits column DOM (headers, count badges, agent sublines, mode toggles, drop containers), the pane emits `<option>` elements. Only the *decision* is shared. Do **not** attempt to share the rendering; it is genuinely different output and the attempt is what makes extractions in this codebase fail.

### The board's synthetic carries three extra fields — verified droppable

The board's current synthetic literal (`kanban.html:6233-6241`) is wider than the proposed return shape: it also sets `role: null`, `autobanEnabled: true`, and `dragDropMode: 'cli'`. Dropping a consumed field would be a silent regression, so each was traced:

- **`dragDropMode`** — dead. `renderColumns` reads the per-column mode from `columnDragDropModes[def.id]` (`kanban.html:6259`), never `def.dragDropMode`.
- **`autobanEnabled`** — dead on the synthetic. `autobanColumns` is derived from `columnDefinitions` (the real defs), not from `renderDefs`.
- **`role`** — dead on the synthetic. `columnToRole()` (`kanban.html:6697-6700`) resolves via `getColumnDefinition(col)` against the **real** definitions, where `CODED_AUTO` does not exist and already returns `null` today. `CODED_AUTO`'s agent subline is special-cased separately (`kanban.html:6740`, `6784-6785`).

`renderDefs` is consumed at `kanban.html:6249`, `6254`, `6255` and inside the map body, which reads only `def.id`, `def.kind`, `def.label`, and positional index. **The five-field return shape is sufficient for the board.** Record this in the code comment so the next reader does not have to re-derive it.

### ⚠ `'AUTOCODE'` has a second, unrelated life — do not sweep it

`src/services/agentConfig.ts:183` defines `'AUTOCODE': { aliasOf: ['LEAD CODED', 'CODER CODED', 'INTERN CODED'] }` — a **server-side column-reference alias**, not a display label. Changing the board's rendered label from `'AUTOCODE'` to `'Autocode'` must not touch it. A find-and-replace of `AUTOCODE` across the repo breaks column-ref resolution. Change only the literal at `kanban.html:6235`, by deleting the block that contains it.

### Wiring — supersedes the original step 2

> **Superseded:** "Add a `{{SHARED_KANBAN_COLUMNS_URI}}` placeholder + `<script>` tag in `terminals.html`, ordered before `{{TERMINALS_JS_URI}}`; add the placeholder→`/static/webview/` mapping in `headlessPanelHtml.ts`; build the URI in `KanbanProvider.ts` alongside `sharedDefaultsUri`; extend the kanban marker-comment injection; confirm the marker path still satisfies `expectMarker`."
> **Reason:** It proposes a *new* placeholder mechanism for `terminals.html`, and a *separate* marker path for `kanban.html` — two mechanisms — on the belief that only `kanban.html` carries the marker. **`terminals.html:2053` carries the identical `<!-- SHARED_DEFAULTS_SCRIPT -->` marker.** Both files already take the same path. Worse, a `{{SHARED_KANBAN_COLUMNS_URI}}` placeholder in `kanban.html` would need a matching replacement in **both** `KanbanProvider.ts` and `headlessPanelHtml.ts`, and any host that missed it would render a literal unreplaced `{{...}}` as a script `src` — a 404 and a dead pane, with nothing to catch it. The plan also names a "terminals panel provider" to edit; there is none.
> **Replaced with:** extend the two **existing** marker replacements. No new placeholder, no new marker, and the load-order guarantee ("before the panel's own script") is inherited free, because the marker already sits above every script tag in both files.

Concretely, three edit sites:

1. **`headlessPanelHtml.ts:73-88`** — give `injectTransportShim` an optional trailing `extraScripts: string[] = []` parameter appended to the `shim` string it builds.
2. **`headlessPanelHtml.ts:182`** (kanban) and **`:408`** (terminals) — pass `['/static/webview/sharedKanbanColumns.js']`. Do **not** add it to the other `injectTransportShim` callers (project / planning / design / setup / memo / connections): they do not render kanban columns, and a default-on `extraScripts` would ship a kanban concern to six unrelated panels.
3. **`KanbanProvider.ts:12361-12362`** — build a second `asWebviewUri` for `sharedKanbanColumns.js` and emit **both** `<script>` tags in the single `.replace('<!-- SHARED_DEFAULTS_SCRIPT -->', ...)`, shared script second so `sharedDefaults` is still first.

`expectMarker` is unaffected — the marker is still consumed by the same call, so its deletion still warns.

### Cross-surface state — already shipped

`collapseCoders` is host-persisted and both surfaces read one value. This was the plan's hardest open question and it is resolved; the detail is retained here as the contract the extraction must not break:

- Scoped setting `kanban.collapseCodersEnabled`, default `true` (matches the board's in-webview default, so no behaviour change for the install base and no migration needed — the value it supersedes was per-webview `vscode.getState()`, which was never authoritative across surfaces).
- Verb `toggleCollapseCoders`, following the `toggleDynamicComplexityRouting` pattern: assign → `_markConfigDirty()` → `_updateScopedSetting` → push `collapseCodersState` → return `{success, enabled}`.
- `collapseCodersState` pushed from the full-state builders so a second board window stays in step.
- `collapseCoders` rides the `getKanbanStructure` **return body**, not only the push — the pane reads that verb over HTTP and needs the flag with the structure. Zero extra round-trips.
- Pane reads it as `structData.collapseCoders !== false`, so a host predating the field defaults to ON rather than silently stripping the aggregate from a collapsed board.

## Metadata

- **Tags:** frontend, ui, refactor, test
- **Complexity:** 4
- **Project:** Browser Switchboard
- **Files:** `src/webview/sharedKanbanColumns.js` (new), `src/webview/terminals.js`, `src/webview/kanban.html`, `src/services/KanbanProvider.ts`, `src/services/headlessPanelHtml.ts`, `src/test/browser-kanban-pane-order.test.js`, plus a new unit test file
- **Not needed:** `terminals.html` (marker already present), `webpack.config.js` (glob copy), `src/generated/*` (no new verb — `toggleCollapseCoders` already shipped)
- **Migrations:** none. The setting already ships and defaults to the board's existing default.

> **Superseded:** Complexity 5; files list including `src/webview/terminals.html`, "the terminals panel provider", and `src/generated/verbAllowlist.ts` / `protocol-catalog.json`.
> **Reason:** Steps 5-7 are already implemented, which removes the new-verb work (and therefore the catalog regeneration entirely — `toggleCollapseCoders` is already in `verbAllowlist.ts`), the setting plumbing, and the cross-surface-state design risk. `terminals.html` needs no edit because it already carries the marker, and there is no VS Code terminals provider to edit. What is left is a same-shape extraction across two known call sites plus a test rewrite.
> **Replaced with:** Complexity **4**, and the files list above.

## User Review Required

None.

## Complexity Audit

### Routine

- Writing a pure function that reproduces logic already present, verbatim, in two places.
- Deleting two now-dead local derivations and pointing both call sites at the shared function.
- Extending two existing script-injection sites with one extra tag each.

### Complex / Risky

- **The tests currently pin the duplication.** Five assertions in `browser-kanban-pane-order.test.js` scan `terminals.js` for the exact source text the extraction deletes. They must be retargeted in the same change, or the change lands red — and "the test is red because I moved the code" is the sentence under which a real regression hides.
- **Refactor with no behaviour change means the only proof is equivalence.** There is no user-visible symptom to check off. The board's `renderColumns` and the pane's picker must produce byte-identical output before and after, including for the degenerate inputs (0 coder columns, 1 coder column, collapse off).
- **The pane's pre-structure fallback is load-bearing and must survive.** `renderKanbanPane` builds `liveColumns` from a synthesised one-entry list when `kanbanColumnsCache` is empty (`terminals.js:5008-5014`). Without it a persisted `CODED_AUTO` is rewritten to `CREATED` on first paint and `saveLayoutSettings()` persists the clobber. This is *caller* logic, not derivation logic — it stays in `terminals.js`, outside `buildDisplayColumns`.
- **The board's synthetic has three extra fields.** Traced above and confirmed unread; the risk is that a future field is added to the board's literal and silently lost to the shared shape. Mitigate with the comment in the shared file naming which fields were checked and why they were dropped.
- **`'AUTOCODE'` is also a server-side alias** (`agentConfig.ts:183`). A repo-wide sweep of the string breaks column-ref resolution.

## Edge-Case & Dependency Audit

### Race Conditions

- None introduced. `buildDisplayColumns` is pure and synchronous; both callers invoke it inside an existing render pass.
- The one live ordering hazard is pre-existing and unchanged: the pane's snap-on-render path defers its refetch via `setTimeout(..., 0)` because a direct call is swallowed by the `kanbanFetchInFlight` guard when the render runs inside the fetch's own response handler. Do not "simplify" that during the extraction.

### Security

- No new network surface, no new verb, no new user input. The shared script is same-origin and nonce'd under the existing CSP on both panels.

### Side Effects

- New script tag on two panels. `sharedKanbanColumns.js` is a few hundred bytes; it must **not** be added to the other six `injectTransportShim` callers.
- No persisted-state change. No migration.

### Dependencies & Conflicts

- Shares `src/webview/terminals.js` with its sibling subtask (*Fill Grid Does Not Displace Panes Held by Other Roles*) — serialise edits to this file. The regions are ~1,400 lines apart (`~4920-5030` here vs `~6474-6580` there) and share no symbol, so this is merge hygiene rather than a design dependency.
- **Builds on uncommitted working-tree changes.** The scope table above describes state that is modified-but-uncommitted in `terminals.js`, `kanban.html`, `KanbanProvider.ts`, and `browser-kanban-pane-order.test.js`. Commit or otherwise secure that work before starting, so the extraction is a separable diff — and re-read the four files first, because the scope table is a snapshot.
- No shared test file with the sibling.

## Dependencies

- None — no upstream session dependencies.

## Adversarial Synthesis

**Risk summary.** This is now a pure refactor whose entire value is removing a second implementation, so the failure mode is a *partial* extraction that leaves a residual branch and quietly re-creates the drift the plan exists to kill. The second risk is the test suite: five assertions currently scan `terminals.js` for the exact strings the extraction deletes, so the change lands red by construction and a real regression can hide inside that expected redness. Mitigations: assert the *absence* of a local collapse branch on both surfaces as a first-class test; retarget the five source-shape assertions to behavioural unit tests of `buildDisplayColumns` in the same commit; and verify the shared five-field return shape against the board's wider synthetic literal (done — `role` / `autobanEnabled` / `dragDropMode` are unread).

## Proposed Changes

### `src/webview/sharedKanbanColumns.js` (new)

Plain script, top-level function declaration matching `sharedUtils.js`'s shape (no IIFE wrapper, so the function is a global). Port the logic **from `kanban.html:renderColumns()`**, which is canonical; do not re-derive it from the pane's copy.

- Signature `buildDisplayColumns(columns, opts)`; treat a missing/short `opts` as `{ collapseCoders: true }`? **No** — require the caller to pass it explicitly and treat `opts && opts.collapseCoders` as the read, so a caller that forgets the flag gets the un-collapsed list rather than silently inheriting a default that differs from its surface's own.
- Guard the input: a non-array `columns` returns `[]`.
- When `collapseCoders` is falsy, or no `kind === 'coded'` column is present, return the input list unchanged (same array contents; do not sort what was not collapsed — the board does not, and re-sorting could reorder equal-`order` columns).
- Otherwise: `filter(c => c.kind !== 'coded')`, `concat` the synthetic, `sort((a, b) => (a.order || 0) - (b.order || 0))`.
- Synthetic: `{ id: 'CODED_AUTO', label: 'Autocode', kind: 'coded', order: firstCoded.order || 180, aggregate: true }` where `firstCoded` is the first `kind === 'coded'` entry **in the input order** (matching `coderDefs[0]` on the board).
- Carry the field-audit comment: `role`, `autobanEnabled`, and `dragDropMode` were on the board's literal and are deliberately not returned — traced unread at `kanban.html:6249-6420`, `columnToRole` (`:6697`), and the `columnDragDropModes[def.id]` read (`:6259`).
- Carry the casing comment: `'Autocode'`, not `'AUTOCODE'` — the board's `.column-name` is `text-transform: uppercase` (`kanban.html:761`); the pane's `<select>` is not. And note that `'AUTOCODE'` remains a live **server-side alias** in `agentConfig.ts:183` and is not this string.

### `src/webview/kanban.html` — `renderColumns()` (line 6227)

Replace the whole `if (collapseCodersEnabled) { ... }` block (lines 6229-6247) with:

```js
const renderDefs = buildDisplayColumns(columnDefinitions, { collapseCoders: collapseCodersEnabled });
```

The collapse branch is **deleted, not left alongside**. `renderDefs` becomes `const`. Everything below (`renderDefs.map`, `findIndex(d => d.kind === 'completed')`, `indexOf(def)`) is untouched. The literal `label: 'AUTOCODE'` disappears with the block — that is the only place it should change.

### `src/webview/terminals.js` — `renderKanbanPane()` (line 5015)

Replace the `const columns = aggregateOffered ? liveColumns.filter(...).concat([...]).sort(...) : liveColumns;` expression with a call passing the pane's already-computed gate:

```js
const columns = buildDisplayColumns(liveColumns, { collapseCoders: aggregateOffered });
```

`aggregateOffered` (`structureLanded && kanbanCollapseCoders && coded.length > 0`) already encodes both the toggle and the non-empty-coder-set condition, and `buildDisplayColumns` re-checks the coder set itself, so passing it is correct and keeps the pane's structure gate where it belongs.

**Keep unchanged:** the `structureLanded` derivation, the two-directional snap block, the `setTimeout(..., 0)` refetch, and the pre-structure `liveColumns` fallback. `AGGREGATE_CODED_ID` stays (the fetch path and `columnLabelForId` both reference it). `AGGREGATE_CODED_LABEL` moves into the shared file — if `columnLabelForId` still needs it, have it read the aggregate's label from the shared function's output rather than re-declaring the string.

### `src/services/headlessPanelHtml.ts`

- `injectTransportShim` (line 73): add `extraScripts: string[] = []`, appended to the `shim` string as nonce'd `<script src>` tags after `transport.js`.
- Kanban caller (line 182) and terminals caller (line 408): pass `['/static/webview/sharedKanbanColumns.js']`. No other caller changes.

### `src/services/KanbanProvider.ts` (line 12361)

Build a second `asWebviewUri` for `dist/webview/sharedKanbanColumns.js` and emit both tags in the existing single marker replacement, `sharedDefaults.js` first.

### `src/test/browser-kanban-pane-order.test.js`

Retarget the assertions the extraction invalidates; keep the ones it does not.

**Delete** (they scan `terminals.js` for source text that moves into the shared file):
- in `test('the aggregate SUBSTITUTES for the coder columns and keeps their order slot')` — the `doesNotMatch(/liveColumns\.concat\(\[\s*\{\s*\n?\s*id:\s*AGGREGATE_CODED_ID/)`, the `liveColumns\s*\n?\s*\.filter\(c => c.kind !== 'coded'\)` match, the `order: kanbanColumnsCache.find(...)?.order || 180` match, and the `.sort((a, b) => (a.order || 0) - (b.order || 0))` match.
- `test('the aggregate label is title case, not SHOUTED')` — its `AGGREGATE_CODED_LABEL` declaration lookup no longer resolves in `terminals.js`. The casing assertion moves to the unit tests, where it can check the returned label instead of a declaration.

**Keep** (pane-local, unmoved): `aggregateOffered` gating, `structureLanded` gating, the `structData.collapseCoders !== false` read, the `getBoardCards` aggregate-omission test, the board's `toggleCollapseCoders` / `collapseCodersState` write-through test, and everything unrelated to the aggregate.

**Add** the parity assertion — the one source-shape check worth keeping, because it guards the *absence* of a second implementation:

```js
test('neither surface retains a local collapse branch', () => {
    assert.match(kanbanSrc, /buildDisplayColumns\(columnDefinitions,\s*\{\s*collapseCoders:/,
        'the board must derive its column list from the shared function');
    assert.match(terminalsSrc, /buildDisplayColumns\(liveColumns,\s*\{\s*collapseCoders:/,
        'the pane must derive its column list from the shared function');
    assert.doesNotMatch(kanbanSrc, /label:\s*'AUTOCODE'/,
        'the board must not still build its own synthetic column — that is the duplication this extraction removed');
    assert.doesNotMatch(terminalsSrc, /\.filter\(c\s*=>\s*c\.kind\s*!==\s*'coded'\)/,
        'the pane must not still filter coder columns itself');
});
```

### New unit test file — `buildDisplayColumns`

`sharedKanbanColumns.js` is a pure function in a plain script, so it can be `require`d directly by a node test. This feature stops needing a webview harness.

## Verification Plan

### Automated Tests

1. **Unit — `buildDisplayColumns`** (new file):
   - `collapseCoders: false` → input returned unchanged, all coder columns present, order preserved.
   - `collapseCoders: true`, 3 coder columns → exactly one `CODED_AUTO` entry; no `kind === 'coded'` originals besides it; its index sits between `Planned` and `Reviewed`, **not** last.
   - `collapseCoders: true`, 1 coder column → still substituted (matches the board; substitution means no duplicate option).
   - `collapseCoders: true`, 0 coder columns → no aggregate emitted, input returned unchanged.
   - Order inheritance: aggregate takes the **first** coded column's `order`; falls back to `180` when that column has no `order`.
   - Label assertion: `label !== label.toUpperCase()` — pins the casing defect directly rather than pinning a string.
   - Shape assertion: the aggregate carries `aggregate: true` and `kind: 'coded'`.
   - A custom column with `kind: 'coded'` joins the union; a `custom-user` column does not.
   - Degenerate input: `undefined` / non-array → `[]`, no throw.
2. **Parity — `neither surface retains a local collapse branch`**, as written above.
3. **Equivalence spot-check (the refactor's real proof).** Feed the pre-change board branch and `buildDisplayColumns` the same three fixtures (0 / 1 / 3 coder columns, collapse on and off) and assert identical `[{id, label, kind, order}]` sequences, modulo the intended `'AUTOCODE'` → `'Autocode'` label change. Write this as a temporary local check if it does not earn a permanent test.
4. **Existing suites:** `browser-kanban-pane-order.test.js` (retargeted), `verb-engine-kanban-headless.test.js`, `kanban-card-prompt-labels-regression.test.js` green.
5. **Generated artefacts:** no catalog regeneration is required — `toggleCollapseCoders` already ships in `src/generated/verbAllowlist.ts`. Still run `npm run parity:check` and `node scripts/check-standalone-push-parity.js` as a no-regression check, since `KanbanProvider.ts` is touched.
6. **Injection check:** render both panels through `headlessPanelHtml` and assert the output contains `sharedKanbanColumns.js` **before** the panel's own script, and that the six non-kanban panels do **not** contain it.

**Note:** several test suites are red at HEAD in this tree (DB init, setup-panel, project-panel, terminal-pane-fit and others), unrelated to this work. Baseline them before starting so pre-existing reds are not attributed to this change.

### Manual UAT

Requires a VSIX build — `dist/` is not used during development and the browser cockpit serves the VSIX's `dist`, so `src` edits are invisible until packaged. Then, in **both** hosts (VS Code webview and browser cockpit, because they use different injection paths):

1. Open the terminals panel beside the board.
2. Toggle collapse on the board. Confirm the pane's picker gains/loses `Autocode` **in the coder columns' position** (between Planned and Reviewed), not at the tail.
3. Confirm a pane sitting on `Lead Coder` follows into the bucket when collapse turns on, and falls back to a coder column when it turns off.
4. Confirm the option reads `Autocode` — not `ALL CODED`, not `AUTOCODE` — and that the **board's** header still reads `AUTOCODE` (uppercased by CSS).
5. Confirm no console error about a missing `buildDisplayColumns` on first paint (load-order regression).

## Out of scope

- The board's rendering internals below the column-list decision.
- Any other duplicated-logic pair (the dispatch plans array is built in 5 places; that is its own plan).
- Migrating other webview state out of `vscode.getState()`. The board's `saveWebviewState()` mirror of `collapseCodersEnabled` stays as the pre-hydration paint source.

## Recommendation

Complexity 4 → **Send to Coder**.
