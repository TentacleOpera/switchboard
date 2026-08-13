# Extract the kanban column-set derivation into a shared webview script

## Goal

Make the terminals kanban pane and the kanban board derive their column list from **one** piece of code, so the pane cannot disagree with the board about which columns exist, what they are called, or what order they appear in.

### The problem

The terminals pane's column picker offered an aggregate option labelled `ALL CODED`, appended to the **end** of the list (after `Completed`), and shown **unconditionally**. The board renders the same concept as `AUTOCODE`, **substituted in place** of the coder columns at their own order slot, and **only** when the "collapse coders" toggle is on. Three visible defects, one cause.

### Root cause

`src/webview/terminals.js` re-implements a decision that `src/webview/kanban.html` already makes. The board's version lives inside `renderColumns()` (kanban.html ~line 5734):

```
filter(d => d.kind !== 'coded')  →  concat(synthetic {id:'CODED_AUTO', label:'AUTOCODE', order: coderDefs[0].order || 180})  →  sort by order
```

The pane's version (terminals.js ~line 4318) was written independently and drifted on all three axes. Nothing structural prevents the drift, and it will recur on the next column-model change (a new `kind`, a reordered built-in, a new collapse rule).

A fourth axis is latent and will bite the naive fix: the board **stores** `'AUTOCODE'` in caps and relies on `.column-name { text-transform: uppercase }` (kanban.html:759) to display every label that way — its stored labels are title case (`New`, `Planned`, `Lead Coder`). The pane's picker is a plain `<select>` with **no** text-transform, so it renders labels raw. Sharing the board's literal string would reintroduce the caps defect on the pane. The shared function must return title case and let the board's CSS keep doing its job.

A fifth: the collapse toggle itself is unreadable from the pane. `collapseCodersEnabled` lives in the kanban webview's `vscode.getState()`, which is per-webview. No other surface can see it, so "only appear when the board shows AUTOCODE" is unimplementable without host-side persistence.

### Existing regression tests made this worse, not better

`src/test/browser-kanban-pane-order.test.js` asserted the buggy shape by regex — `coded.length > 1` and the tail `concat` — so the defects were pinned in place and a correct fix turns those tests red. They are source-shape change-detectors, not behavioural tests; the file itself notes "the pane has no headless harness". This plan replaces that class of assertion for this feature with a single parity assertion that has real teeth.

## Investigation findings — can `terminals.js` import anything?

**No ES modules. But a shared-script mechanism already exists and already reaches both files in both hosts.** Verified:

| Question | Finding |
|---|---|
| Is `terminals.js` a module? | No. `terminals.html:1768` loads it as `<script nonce src>` with no `type="module"`, and the file is wrapped in an IIFE (`(function() { 'use strict';`). `import` would throw. |
| Is there an existing sharing pattern? | Yes — `sharedUtils.js`, `sharedDefaults.js`, `transport.js`. Plain scripts declaring top-level functions, loaded **before** the consumer, consumed as globals. |
| Does `kanban.html` load external scripts? | It has exactly one `<script>` tag and it is inline — **but** it already receives `sharedDefaults.js` in both hosts (see next row). No new mechanism is needed. |
| VS Code host wiring | `KanbanProvider.ts:12190` builds `sharedDefaultsUri` via `webview.asWebviewUri(... 'dist','webview','sharedDefaults.js')`. Panel providers use a `{{X_URI}}` placeholder (e.g. `DesignPanelProvider.ts:950-953`). |
| Headless/browser host wiring | `headlessPanelHtml.ts` maps `{{X_URI}}` → `/static/webview/X.js` and injects a `firstScript` tag. For `kanban.html`/`setup.html` it replaces a **marker comment** instead (`headlessPanelHtml.ts:66-75`), and `expectMarker` warns if that marker is deleted. |
| Build config change needed? | **No.** `webpack.config.js:86-89` copies `src/webview/*.js` → `dist/webview/[name][ext]` by glob. A new file is picked up automatically. |
| CSP blocker? | No. `terminals.html:5` is `script-src 'nonce-{{NONCE}}' 'self'`; a same-origin nonce'd tag is fine. |

**Conclusion:** the shared unit must be a plain (non-module) script exposing a global, following `sharedDefaults.js`'s existing two-host path exactly. This is materially cheaper than it looked — no build changes, no new injection mechanism, both target files already on the path.

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

### Cross-surface state

`collapseCoders` must become host-persisted so both surfaces read one value:

- New scoped setting `kanban.collapseCodersEnabled`, default `true` (matches the board's current in-webview default, so no behaviour change for the install base and no migration needed — the current value is per-webview `vscode.getState()`, which was never authoritative across surfaces).
- New verb `toggleCollapseCoders`, following the `toggleDynamicComplexityRouting` pattern exactly (`KanbanProvider.ts`): assign → `_markConfigDirty()` → `_updateScopedSetting` → return `{success, enabled}`.
- Push `collapseCodersState` from the full-state builders so a second board window stays in step.
- Carry `collapseCoders` on the `getKanbanStructure` verb **return body** (not only the push) — the pane reads that verb over HTTP and needs the flag with the structure. This keeps it to zero extra round-trips.
- Pane reads it as `structData.collapseCoders !== false`, so a host predating the field defaults to ON rather than silently stripping AUTOCODE from a collapsed board.

## Implementation steps

1. **Create `src/webview/sharedKanbanColumns.js`** — plain script, IIFE-free top-level function declaration matching `sharedUtils.js`'s shape. Port the logic **from `kanban.html:renderColumns()`**, which is canonical; do not re-derive it from the pane's copy. Normalise the aggregate label to title case.

2. **Wire it into both hosts**, mirroring `sharedDefaults.js`:
   - `KanbanProvider.ts` (~12190): build the URI alongside `sharedDefaultsUri`.
   - The terminals panel provider: add a `{{SHARED_KANBAN_COLUMNS_URI}}` placeholder + `<script>` tag in `terminals.html`, ordered **before** `{{TERMINALS_JS_URI}}`.
   - `headlessPanelHtml.ts`: add the placeholder→`/static/webview/` mapping, and extend the kanban marker-comment injection.
   - Confirm the marker-comment path still satisfies `expectMarker`.

3. **Rewire the board**: `renderColumns()` calls `buildDisplayColumns(columnDefinitions, { collapseCoders: collapseCodersEnabled })` and renders the result. Its collapse branch is deleted, not left alongside.

4. **Rewire the pane**: `renderKanbanPane()` calls the same function. Delete the local `filter/concat/sort`. Keep the existing pre-structure fallback (empty cache → synthesise a one-entry list from the persisted id) — it is load-bearing: without it a persisted `CODED_AUTO` is rewritten to `CREATED` on first paint and `saveLayoutSettings()` persists the clobber.

5. **Pane selection snapping** — both directions, gated on a populated structure cache:
   - aggregate withdrawn (toggle off, or all coder columns hidden in Setup) → fall to the first coder column, else `CREATED`.
   - aggregate adopted while the pane sits on an individual coder column → follow it into the bucket, since that column is no longer offered.
   - On snap: clear `kanbanPaneCards[index]`, `saveLayoutSettings()`, and refetch via `setTimeout(..., 0)` — a direct call is swallowed by the `kanbanFetchInFlight` guard when this render runs inside the fetch's own response handler.

6. **Host state plumbing** — the setting, verb, push, and structure-response field described above.

7. **Board write-through** — the collapse button posts `toggleCollapseCoders`; the board adopts `collapseCodersState`. Keep `saveWebviewState()` as the pre-hydration mirror so the first paint after reload matches what the host will send.

8. **Replace the pinning tests.** Delete the two source-shape assertions in `browser-kanban-pane-order.test.js` that encode the old shape. Replace with direct tests of `buildDisplayColumns` (see below). Do not add more regex-on-source assertions for this feature.

## Verification plan

`sharedKanbanColumns.js` is a pure function in a plain script, so it can be `require`d directly by a node test — this feature stops needing a webview harness.

1. **Unit — `buildDisplayColumns`** (new test file):
   - `collapseCoders: false` → input returned unchanged, all coder columns present.
   - `collapseCoders: true`, 3 coder columns → exactly one `CODED_AUTO` entry; no `kind === 'coded'` originals; its index sits between `Planned` and `Reviewed`, **not** last.
   - `collapseCoders: true`, 1 coder column → still substituted (matches the board; substitution means no duplicate option).
   - `collapseCoders: true`, 0 coder columns → no aggregate emitted.
   - Label assertion: `label !== label.toUpperCase()` — pins the casing defect directly rather than pinning a string.
   - A custom column with `kind: 'coded'` joins the union; a `custom-user` column does not.

2. **Parity — the assertion that replaces a dozen brittle ones:** board and pane call the same function with the same input, so assert both call sites pass the live column list and the live toggle, and neither retains a local collapse branch. This is the one source-shape check worth keeping, because it guards the *absence* of a second implementation.

3. **Existing suites:** `browser-kanban-pane-order.test.js`, `verb-engine-kanban-headless.test.js`, `kanban-card-prompt-labels-regression.test.js` green.

4. **Generated artefacts:** `npm run catalog:generate` after adding `toggleCollapseCoders`, then `npm run catalog:check`, `node scripts/check-protocol-parity.js`, and `node scripts/check-standalone-push-parity.js` (the new push must ride the delegated full-state builder, not a hardcoded field).

5. **Manual UAT — requires a VSIX build.** `dist/` is not used during development and the browser cockpit serves the VSIX's `dist`, so `src` edits are invisible until packaged. Then: open the terminals panel beside the board; toggle collapse on the board; confirm the pane's picker gains/loses `Autocode` in the coder columns' position, that a pane sitting on `Lead Coder` follows into the bucket, and that the option reads `Autocode` — not `ALL CODED`, not `AUTOCODE`.

**Note:** `~12 test suites are red at HEAD` in this tree (DB init, setup-panel, project-panel, terminal-pane-fit and others), unrelated to this work. Baseline them before starting so pre-existing reds are not attributed to this change.

## Out of scope

- The board's rendering internals below the column-list decision.
- Any other duplicated-logic pair (the dispatch plans array is built in 5 places; that is its own plan).
- Migrating other webview state out of `vscode.getState()`.

## Metadata

- **Complexity:** 5
- **Files:** `src/webview/sharedKanbanColumns.js` (new), `src/webview/terminals.js`, `src/webview/terminals.html`, `src/webview/kanban.html`, `src/services/KanbanProvider.ts`, `src/services/headlessPanelHtml.ts`, the terminals panel provider, `src/test/browser-kanban-pane-order.test.js`, plus generated `src/generated/verbAllowlist.ts` / `protocol-catalog.json`
- **Build config:** no change required (webpack copies `src/webview/*.js` by glob)
- **Migrations:** none. The new setting defaults to the board's existing default; the value it supersedes was per-webview `vscode.getState()`, never authoritative across surfaces.
- **User Review Required:** None
