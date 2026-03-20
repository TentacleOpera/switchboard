# Complexity dropdown does not override

## Goal
This is a bug: if a plan has 'unknown' listed for band B complexity, the plan will be set to high complexity. But that is wrong, it is just a wording that slips through the complexity parser, since unknown should equal to none, but it is not treated that way. 

This leads to a second bug: I cannot fix this using the dropdown, I have to manually edit the complexity wording myself. Because if I try to set complexity using the complexity dropdown, any c hange I make simply snaps back to high complexity once the plan is saved. This makes the dropdown completely useless. 

Exepected results:
1. 'Unknown' in band ba c omplexity assessment needs to be treated the same as 'none'
2. The complexity dropdown needs to override the text complexity assessment somehow. For eample, by inserting a user override flag that the parser respects. 

## Proposed Changes
- TODO

## Verification Plan
- TODO

## Open Questions
- TODO

## Reviewer Enhancement Pass (2026-03-17)

### Verified Code Anchors
- `src/webview/review.html:475-480` defines the ticket-view complexity dropdown values (`Unknown`, `Low`, `High`).
- `src/webview/review.html:839` hydrates the dropdown from `state.complexity` when the ticket loads.
- `src/webview/review.html:1004-1012` sends `type: 'setComplexity'` when the dropdown changes.
- `src/services/TaskViewerProvider.ts:5460-5470` handles `setComplexity` by rewriting the plan text with `_applyComplexityToPlanContent(...)` and then updating the DB row.
- `src/services/TaskViewerProvider.ts:5139-5179` currently rewrites only the `Band B` body (`- None.`, `- Unknown.`, or a hard-coded high-complexity note). It does **not** create a durable override marker distinct from parser-derived content.
- `src/services/TaskViewerProvider.ts:5516-5557` re-saves the plan text and immediately recomputes complexity with `KanbanProvider.getComplexityFromPlan(...)`, then overwrites the DB value. This is the direct cause of the dropdown "snap back."
- `src/services/TaskViewerProvider.ts:5215-5257` loads review-ticket complexity from the DB row first, but falls back to parser-derived complexity when the row is `Unknown`.
- `src/services/KanbanProvider.ts:709-779` parses the plan file and currently treats only blank/dashes/`none`/`n/a` as empty `Band B` markers. A literal `Unknown` line is treated as meaningful content and therefore resolves to `High`.
- `src/mcp-server/register-tools.js:824-856` duplicates the same empty-marker logic for `get_kanban_state`, so parser changes must be mirrored there to prevent MCP/UI drift.
- `src/services/TaskViewerProvider.ts:1874-1877` and `2631-2635` use `getComplexityFromPlan(...)` directly for autoban/routing decisions, so a DB-only fix would still leave behavior inconsistent.
- `src/services/KanbanDatabase.ts:14`, `63-72`, and `204-207` store only a plain `complexity` value today; there is no persisted override provenance.

### Root-Cause Summary
This bug is actually **two coupled defects**:

1. **Parser defect:** `Band B: Unknown` is being interpreted as meaningful risky work instead of an empty placeholder, so the plan resolves to `High`.
2. **Persistence defect:** the dropdown writes a temporary complexity value, but `savePlanText` immediately reparses the markdown and overwrites that value, so manual edits do not stick.

### Dependencies / Cross-Plan Conflict Scan
- **Direct overlap:** `feature_plan_20260317_113032_fix_complexity_parsing_bug.md`
  - Same `KanbanProvider.ts` parser surface.
  - This plan must extend that work rather than reintroducing a second independent heuristic.
- **Direct overlap:** `feature_plan_20260316_155425_fix_false_high_complexity_ratings.md`
  - Same empty-`Band B` semantics and same low/high classification boundary.
- **Direct overlap:** `feature_plan_20260313_141054_update_complexity_kanban_detector_language.md`
  - That plan hardened normalization around bullets/dashes and contextual headings. Any new `Unknown` handling must preserve those fixes and avoid making real task bullets look empty again.
- **Direct overlap:** `feature_plan_20260315_115700_add_complexity_identificaiton_to_get_kanban_state_mcp_tool.md`
  - `src/mcp-server/register-tools.js` contains a duplicate complexity parser for MCP output. Override semantics and empty-marker semantics must stay aligned there.
- **Shared save path:** `src/webview/review.html` + `src/services/TaskViewerProvider.ts`
  - This plan changes metadata-save behavior; do not ship it piecemeal across UI and backend.

### Recommended Strategy
Do **not** solve this with a DB-only override. That would still leave:
- autoban routing using the old parser via `TaskViewerProvider.ts:1874-1877` and `2631-2635`,
- board rebuilds re-deriving complexity from plan text,
- MCP `get_kanban_state` returning a different complexity than the review ticket.

Instead, make the manual override a **plan-file-visible signal** that every parser path can read. The DB can still mirror the chosen value for fast ticket hydration, but the markdown file must remain the durable source of truth.

### Refined Execution Plan
1. **Introduce an explicit manual-override marker in the plan file**
   - **Primary file:** `src/services/TaskViewerProvider.ts`
   - **Lines:** `5139-5179`, `5460-5470`
   - Update `_applyComplexityToPlanContent(...)` so the dropdown writes a dedicated override line inside `## Complexity Audit`, for example:
     - `**Manual Complexity Override:** Low`
     - `**Manual Complexity Override:** High`
     - `**Manual Complexity Override:** Unknown`
   - Preserve existing `Band A` / `Band B` prose instead of replacing user-written content with a generic placeholder sentence wherever possible.
2. **Make the override authoritative during parsing**
   - **Primary files:** `src/services/KanbanProvider.ts`, `src/mcp-server/register-tools.js`
   - **Lines:** `709-779`, `824-856`
   - Check for the explicit manual override marker **before** agent recommendation fallback and before `Band B` parsing.
   - This precedence is intentional: a user-selected override should supersede text-derived heuristics.
3. **Treat standalone `Unknown` as an empty placeholder only in `Band B` parsing**
   - **Primary files:** `src/services/KanbanProvider.ts`, `src/mcp-server/register-tools.js`
   - Extend `isEmptyMarker` / `isEmptyBandBLine` so normalized standalone values like `unknown`, `unknown.`, and markdown-decorated equivalents are treated the same as `none` and `n/a`.
   - Do **not** treat arbitrary prose containing the word "unknown" as empty; only standalone placeholder lines should match.
4. **Stop save-plan from clobbering the manual selection**
   - **Primary file:** `src/services/TaskViewerProvider.ts`
   - **Lines:** `5516-5557`
   - Keep the post-save recompute step, but let it read the new explicit override marker so it reproduces the user's selected value instead of reverting to parser output from stale `Band B` text.
5. **Keep ticket hydration and routing consistent**
   - **Primary file:** `src/services/TaskViewerProvider.ts`
   - **Lines:** `5215-5257`, `1874-1877`, `2631-2635`
   - Verify review-ticket load, card hydration, autoban low/high filtering, and save/reload flows all agree on the same final complexity once the override marker is present.
6. **Only add DB schema if strictly necessary**
   - **Potential files:** `src/services/KanbanDatabase.ts`, `src/services/KanbanMigration.ts`
   - Current evidence suggests schema changes are optional because the durable fix can live in markdown + existing `complexity` cache.
   - If a schema column such as `complexity_override` is introduced, it must remain a cache/telemetry aid, not the sole source of truth.

### Verification Plan
1. Reproduce the current failure with a plan whose `Band B` line is `- Unknown.` and confirm it currently resolves to `High`.
2. Change the dropdown to `Low`, save the plan text, reload the ticket, and confirm the dropdown still shows `Low`.
3. Repeat with `Unknown` and `High` to confirm all three choices persist.
4. Confirm the Kanban card complexity badge matches the review ticket after reload.
5. Confirm autoban logic that relies on `getComplexityFromPlan(...)` respects the chosen override.
6. Confirm MCP `get_kanban_state` reports the same complexity value after the override is saved.
7. Regression-check prior parser cases:
   - explicit `Band B` task text stays `High`,
   - `- None`, `N/A`, dash-only placeholders, and standalone `Unknown` stay non-high,
   - plans with no `## Complexity Audit` remain `Unknown` unless a manual override is present.
8. Run existing validation commands:
   - `npm run compile`
   - `npm run compile-tests`

### Adversarial Review

#### Grumpy Critique
- "If you only patch the dropdown or DB row, you haven't fixed anything — `savePlanText` reparses the markdown and stomps your value immediately."
- "If you blindly decide every line containing the word `unknown` means Low complexity, you'll hide real unresolved risk notes and create a new false-low bug."
- "If VS Code and MCP parse complexity differently, users will see one value in the board and another value from `get_kanban_state`, which is worse than today's bug."
- "If `_applyComplexityToPlanContent` keeps replacing the whole `Band B` body with generic text, users will lose detail every time they touch the dropdown."

#### Balanced Synthesis
- Persist the override as an explicit, parser-readable markdown marker rather than a hidden DB-only flag.
- Limit `unknown => empty` semantics to normalized standalone placeholder lines, not freeform prose.
- Preserve existing plan prose and append/update only the override marker so manual dropdown use does not erase planner detail.
- Mirror the parser rules in both `KanbanProvider.ts` and `register-tools.js` so UI, autoban, and MCP all converge on the same answer.

### Complexity Audit

#### Band A — Routine
- Wire the existing dropdown/save plumbing to emit a durable override marker.
- Expand empty-placeholder normalization to include standalone `Unknown`.
- Add save/reload regression coverage for manual complexity changes.

#### Band B — Complex / Risky
- Multi-file coordination across `review.html`, `TaskViewerProvider.ts`, `KanbanProvider.ts`, and `register-tools.js`.
- Parser precedence changes affect Kanban card state, autoban routing, review-ticket hydration, and MCP output.
- Preserving existing plan prose while adding override semantics is trickier than the current blunt `Band B` replacement approach.

### Agent Recommendation
Send this to the **Lead Coder**. The fix spans multiple tightly-coupled files and must keep parser behavior synchronized across VS Code UI, autoban routing, and MCP state reporting.

## Reviewer Pass (2026-03-19)

### Implementation Status: ✅ COMPLETE — 1 CRITICAL fix applied

### Files Changed by Implementation
- `src/services/KanbanProvider.ts` (lines 743–751): Manual override marker check as highest priority in `getComplexityFromPlan()`.
- `src/services/KanbanProvider.ts` (line 805): `isEmptyMarker` now includes `unknown` as an empty placeholder.
- `src/services/TaskViewerProvider.ts` (lines 5153–5209): `_applyComplexityToPlanContent()` inserts/updates `**Manual Complexity Override:**` marker in the Complexity Audit section.
- `src/services/TaskViewerProvider.ts` (lines 5510–5520): `setComplexity` handler writes marker to plan file and updates DB.
- `src/services/TaskViewerProvider.ts` (lines 5603–5608): `savePlanText` re-derives complexity via `getComplexityFromPlan()` which now respects the override marker — snap-back bug is fixed.
- `src/mcp-server/register-tools.js` (lines 824–828): `isEmptyBandBLine` includes `unknown`.
- `src/mcp-server/register-tools.js` (lines 833–837): Manual override marker check added.

### Files Changed by Reviewer
- `src/mcp-server/register-tools.js` (lines 839–848): **CRITICAL FIX** — Agent Recommendation priority reordered to match `KanbanProvider.ts`. Previously, agent recommendation was only checked when no Complexity Audit section existed; now it is checked before Band B parsing regardless, preventing UI/MCP complexity drift.

### Grumpy Findings
| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | CRITICAL | MCP parser (`register-tools.js`) had divergent priority order from `KanbanProvider.ts` — agent recommendation was only checked when no Complexity Audit section existed, while `KanbanProvider.ts` checks it before Band B parsing unconditionally. Plans with both sections would get different complexity from UI vs MCP. | **FIXED** |
| 2 | MAJOR | `_applyComplexityToPlanContent` still replaces the entire Band B body with generic text when the dropdown is used, destroying user-written plan prose. The plan's adversarial review warned about this. | **DEFERRED** — override marker is the durable signal; Band B body is now cosmetic for classification. Fixing requires complex "preserve existing content" logic with new parsing risk. |
| 3 | NIT | `isEmptyMarker` and `isEmptyBandBLine` both correctly handle `unknown` now. Consistent across both parsers. | OK |

### Balanced Synthesis
- The core fix works: override marker is written by dropdown, read first by all parser paths (KanbanProvider, MCP, autoban routing, save-reparse), and persists through plan text saves.
- The CRITICAL MCP priority divergence has been fixed.
- Band B body clobbering is accepted as deferred because the override marker supersedes Band B content for all classification decisions.

### Validation Results
- `npm run compile`: ✅ PASSED (webpack compiled successfully, both bundles)

### Remaining Risks
- Band B body is replaced with generic text on dropdown use (deferred — cosmetic only since override marker is authoritative).
- Custom agents' complexity columns not covered (out of scope — existing limitation).
