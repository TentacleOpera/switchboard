# Browser Cockpit: Kill Phantom Features — Rebuild WS Resync From the Shared plan_id-Keyed Card Pipeline

## Goal

Make the browser cockpit's WebSocket full-state resync produce the **same board cards the editor webview shows**, by routing it through the same card-building pipeline `refreshWithData` uses — and delete the legacy `getAllPlans` → sessionIds → `_buildCardsFromDbSessionIds` round-trip that causes phantom features.

### Problem

The browser board (`/board`) is spammed with "ghost" features showing **FEATURE: 0 SUBTASKS** that do not appear on the VS Code kanban. Verified against the live `kanban.db` (workspace `038bffef-…`): 5 soft-deleted feature rows ("Host-Agnostic Verb Engine (A2b)", "Board Anywhere: Browser & Cloud Board Views", "Headless Switchboard Parity", + 2) and 31 other soft-deleted plans render in the browser only. Additionally, **every** feature card in the browser shows 0 subtasks immediately after page load, until some editor-side event triggers a real `updateBoard` broadcast that overwrites the board. Every browser reload/reconnect re-seeds the phantoms.

### Root Cause

On every WS (re)connect, `wsHub` pushes a full-state snapshot (`wsHub.ts:137-148`) built by `KanbanProvider.getFullStateMessages` (`KanbanProvider.ts:1059`), and `transport.js:94` applies it as a fresh `updateBoard`. That method was added with the Browser Cockpit work (commit `10362ec`, 2026-07-22) and builds cards through a **different, degraded pipeline** than the editor's live path (`refreshWithData`, `KanbanProvider.ts:1730-2003`):

1. **No status filter — soft-deleted rows resurrect.** It reads `db.getAllPlans(wsId)` (`KanbanDatabase.ts:5925`, `SELECT … WHERE workspace_id = ?` — no status clause), so `deleted`/`archived`/`missing` rows come back. Plan deletion is soft (`UPDATE plans SET status = 'deleted'`, `KanbanDatabase.ts:5536`). The editor path reads `getBoard` (`status = 'active'`, `KanbanDatabase.ts:3368`) + `getCompletedPlans`.
2. **Deprecated sessionId round-trip, no subtaskCount.** It throws away the full rows it just fetched, extracts `sessionId`s, and hands them to the legacy helper `_buildCardsFromDbSessionIds` (`KanbanProvider.ts:7025`), which re-looks-up every plan **one SELECT at a time** (~1,900 queries per browser connect on this DB) keyed on the long-deprecated `session_id` (plan_id is canonical). The helper never sets `subtaskCount`, so `kanban.html` renders `${card.subtaskCount || 0}` → "FEATURE: 0 SUBTASKS" on all 103 real features. It also silently drops any row with an empty `session_id` (latent missing-cards bug). The editor path computes counts via `getSubtaskCountsByFeature` (`KanbanProvider.ts:1821`) and maps rows → cards directly, never touching sessionId.
3. **No ghost-plan filter.** The editor drops active rows whose plan file no longer exists on disk (`refreshWithData:1780-1801`); the resync doesn't.
4. **No repoScope parity.** The editor's live broadcast applies the repo-scope filter server-side (`TaskViewerProvider._refreshRunSheetsImpl`); the resync ignores it.

The fix is structural: one shared card builder, so the two paths cannot drift again.

> **Note — extension-host only.** The standalone host (`npx switchboard`) has its own `buildBoardCards` function (`src/standalone/bootstrap.ts:139-187`) that already uses `getBoard` (status='active'), ghost-plan filter, `getSubtaskCountsByFeature`, `getFeatureWorkingStates`, and `getCompletedPlansInHotWindow`. The phantom-features bug is extension-host only. After this fix, the standalone's `buildBoardCards` remains a separate implementation — consolidating it into the shared `_buildBoardCards` is a follow-up refactor (see Risks & Edge Cases).

## Metadata
**Tags:** backend, bugfix, refactor, performance
**Complexity:** 5
**Project:** browser-switchboard

## User Review Required

None.

## Complexity Audit

### Routine
- Extracting the row→card mapping block of `refreshWithData` into a private helper — pure code motion, behavior-identical for the editor path.
- Swapping `getFullStateMessages`' data source from `getAllPlans` to the same `getBoard`/`getCompletedPlans` (+ repoScope branch) calls `_refreshRunSheetsImpl` uses.

### Complex / Risky
- `refreshWithData` is the single live refresh path feeding BOTH the editor webview and the browser mirror — the extraction must be byte-identical in output (card field set, `working` semantics, completed cards forced to `COMPLETED` with no `working` field).
- `getFullStateMessages` runs on every WS connect; it must remain resilient (current behavior: any error → `[]` and the browser falls back to broadcasts).

## Edge-Case & Dependency Audit

- **Completed cards:** the editor path forces completed rows into column `COMPLETED` and omits `working`. The resync previously placed them by their stored `kanban_column` — 30 of the 36 deleted rows sat in `COMPLETED`, so Done-column spam disappears too. The shared builder must preserve the editor's completed-card shape exactly.
- **Completed-plans query variant:** the plan mirrors `_refreshRunSheetsImpl` (which feeds `refreshWithData`), using `getCompletedPlans` (count-capped at 100). The other editor refresh path, `_refreshBoardImpl`, uses `getCompletedPlansInHotWindow` (time-windowed, 45-day default). The standalone `buildBoardCards` also uses `getCompletedPlansInHotWindow`. This discrepancy is pre-existing between the two editor paths and is out of scope. The plan correctly mirrors the live broadcast path (`_refreshRunSheetsImpl` → `refreshWithData`), which is the semantic equivalent of the WS resync.
- **Ordering:** `getAllPlans` ordered `updated_at ASC`; `getBoard` orders `DESC`. `kanban.html` groups/sorts client-side per column, so ordering of the `cards` array is not a rendering contract. No action needed.
- **`_buildCardsFromDbSessionIds` retains ONE caller** — the `promptSelected` fallback (`KanbanProvider.ts:~8867`) when `_lastCards` misses. That is a webview-message contract (`msg.sessionIds` carries planId-or-sessionId values and the helper already falls back to `getPlanByPlanId`). Out of scope here: do NOT extend it, do NOT delete it in this plan; add a `@deprecated — legacy sessionId path; sole caller is the promptSelected fallback` doc comment so the next reader doesn't reuse it.
- **repoScope:** read via `this.getRepoScopeFilter() ?? null` — the public accessor (`KanbanProvider.ts:6299`) returns `this._repoScopeFilter`. Project filter must NOT be applied server-side — it is client-side by design since the session-independence change (`browser-kanban-session-independence-view.md`); pass `null` for the project argument exactly as `_refreshRunSheetsImpl` does.
- **Standalone host:** `src/standalone/bootstrap.ts` has its own `buildBoardCards` function (lines 139-187) and its own `getFullState` closure (lines 321-342) that does NOT use `KanbanProvider.getFullStateMessages`. The standalone path already builds cards correctly (status filter, ghost-plan filter, subtask counts, working states). This plan fixes the extension-host path only. The standalone's `buildBoardCards` remains a separate implementation — see Risks & Edge Cases for the follow-up consolidation recommendation.
- **Race conditions:** none new — the resync is a read-only snapshot; wsHub already sequences it before broadcasts (subscribe-after-snapshot).
- **Security:** no new surface; same auth-gated WS path, same data the editor already broadcasts.

## Dependencies

- None — single-plan, self-contained, one file (`src/services/KanbanProvider.ts`).

## Adversarial Synthesis

Key risks: (1) the extraction from `refreshWithData` must be byte-identical in output — any field omission or semantic drift breaks the editor board; (2) the standalone host's parallel `buildBoardCards` remains unconsolidated, leaving a third card-builder that can drift from the shared helper; (3) the `vscode` dependency for the working-state timeout must be parameterized out of the helper to keep it pure and safe for future standalone reuse. Mitigations: pure code-motion extraction with no logic edits inside the moved block; `timeoutMs` accepted as a parameter; standalone consolidation flagged as a follow-up.

## Proposed Changes

### `src/services/KanbanProvider.ts` — extract shared card builder from `refreshWithData` (~lines 1775-1861)

Extract the block that turns DB rows into `KanbanCard[]` into a private method:

```ts
/**
 * Shared row→card pipeline used by BOTH the editor refresh (refreshWithData)
 * and the browser WS resync (getFullStateMessages). Applies the ghost-plan
 * file-existence filter to active rows, computes workspace-wide subtask
 * counts and feature working states, and forces completed rows into the
 * COMPLETED column. Keyed on plan_id throughout — sessionId is never used.
 *
 * `timeoutMs` is passed in by the caller (read from vscode config in
 * refreshWithData, or from the standalone config provider) so the helper
 * has no vscode dependency — keeping it pure and safe for standalone reuse.
 */
private async _buildBoardCards(
    db: KanbanDatabase,
    workspaceId: string,
    workspaceRoot: string,
    activeRows: KanbanPlanRecord[],
    completedRows: KanbanPlanRecord[],
    timeoutMs: number
): Promise<KanbanCard[]>
```

> **Superseded:** The original plan proposed a helper signature without `timeoutMs`, with the helper reading `vscode.workspace.getConfiguration('switchboard.activityLight').get<number>('timeoutMs', ...)` internally.
> **Reason:** A `vscode` dependency inside the helper makes it non-pure and creates a latent seam violation (PRD contract #3: "Providers reach the host only through `hostSeams.ts`") if the helper is ever called from the standalone host. The helper should be pure — callers read the config and pass the value.
> **Replaced with:** The helper accepts `timeoutMs: number` as a parameter. `refreshWithData` reads it from `vscode.workspace.getConfiguration(...)` at the call site (line 1822-1824) and passes it in. `getFullStateMessages` reads it the same way (the extension host always has `vscode` available).

Body = the existing logic, moved verbatim:
- `filterGhostPlans(activeRows)` (file-existence check incl. `file://` normalization, lines 1780-1801);
- `completedRows.filter(row => !!row.planFile)`;
- `subtaskCountMap = await db.getSubtaskCountsByFeature(workspaceId)` (line 1821);
- `featureWorkingMap = await db.getFeatureWorkingStates(workspaceId, timeoutMs)` (line 1822 — now uses the parameter, not an inline `vscode.workspace.getConfiguration` call);
- active-row mapping (lines 1828-1845) and completed-row mapping with `column: 'COMPLETED'` and no `working` field (lines 1847-1861).

`refreshWithData` then calls the helper, passing `timeoutMs` from its existing `vscode.workspace.getConfiguration('switchboard.activityLight').get<number>('timeoutMs', DEFAULT_WORKING_STATE_TIMEOUT_MS)` read, and keeps everything around it unchanged: the no-op guard, the `allActiveRows`/occupancy computation (view-specific — stays inline), `this._lastCards = cards`, column building, and the broadcast. The editor path's output must be identical before/after — this is pure extraction.

### `src/services/KanbanProvider.ts` — rewrite `getFullStateMessages` (~lines 1059-1105)

Replace the card-sourcing block:

```ts
// DELETE:
const allPlans = await db.getAllPlans(wsId);
const sessionIds = allPlans.map(p => p.sessionId).filter((s): s is string => typeof s === 'string' && s.length > 0);
const cards = await this._buildCardsFromDbSessionIds(root, sessionIds);

// REPLACE WITH (mirrors TaskViewerProvider._refreshRunSheetsImpl's query branch):
const repoScope = this.getRepoScopeFilter() ?? null;
const activeRows = repoScope
    ? await db.getBoardFilteredByProject(wsId, null, repoScope)
    : await db.getBoard(wsId);
const completedRows = repoScope
    ? await db.getCompletedPlansFilteredByProject(wsId, null, repoScope)
    : await db.getCompletedPlans(wsId);
const timeoutMs = vscode.workspace.getConfiguration('switchboard.activityLight').get<number>('timeoutMs', DEFAULT_WORKING_STATE_TIMEOUT_MS);
const cards = await this._buildBoardCards(db, wsId, root, activeRows, completedRows, timeoutMs);
```

Everything else in the method (columns, projects, `featureWorktrees`, `updateWorkspaceSelection`, `cliTriggersState`, message array shape) stays as-is. The `repoScope` accessor is `this.getRepoScopeFilter()` (public method, `KanbanProvider.ts:6299`) — one call, one null fallback, matching `_refreshRunSheetsImpl`'s `this._kanbanProvider?.getRepoScopeFilter() ?? null` pattern.

### `src/services/KanbanProvider.ts` — mark `_buildCardsFromDbSessionIds` legacy (~line 7025)

Add a `@deprecated` doc comment: legacy sessionId-keyed lookup; sole remaining caller is the `promptSelected` `_lastCards`-miss fallback (~line 8867). Never use for board/resync data. No behavior change.

## Verification Plan

### Automated Tests

Per session directives: compilation and automated tests are SKIPPED. All verification is manual.

### Manual Verification
1. **Phantoms gone:** with the extension running, open the browser board fresh (new tab → forces a WS resync). The 5 deleted features ("Host-Agnostic Verb Engine (A2b)", "Board Anywhere: Browser & Cloud Board Views", "Headless Switchboard Parity", +2) must NOT appear. Cross-check: `sqlite3 .switchboard/kanban.db "SELECT COUNT(*) FROM plans WHERE workspace_id='<ws>' AND is_feature=1 AND status='deleted'"` returns 5, and none of them render.
2. **Real subtask counts at load:** feature cards show their true `FEATURE: N SUBTASKS` immediately after page load, BEFORE any editor-side change triggers a broadcast (this is the resync payload itself, not a later overwrite).
3. **Reload stability:** hard-reload the browser board 3×; no phantoms reappear, counts stay correct.
4. **Editor parity / no regression:** VS Code kanban shows the identical card set and counts before and after the change (the `refreshWithData` extraction is behavior-neutral).
5. **Delete round-trip:** delete a feature from the editor board, then reload the browser — it must not resurrect.
6. **repoScope parity:** set a repo-scope filter, reload the browser — the resync respects it (same cards as the editor).
7. **`promptSelected` fallback intact:** clear `_lastCards` (reload window), immediately use a copy-prompt path on a card — prompt still generates (the legacy helper's one caller still works).
8. **Connect cost:** (informational) resync now issues ~4 queries instead of ~1,900 per browser connection.

## Risks & Edge Cases

- **Editor regression risk concentrated in the extraction.** Mitigation: pure code motion, no logic edits inside the moved block; manual step 4 gates it.
- **Standalone `buildBoardCards` duplication.** The standalone host (`src/standalone/bootstrap.ts:139-187`) has its own card builder that already works correctly. After this fix, there are three card builders: the shared `_buildBoardCards`, the standalone `buildBoardCards`, and the deprecated `_buildCardsFromDbSessionIds`. The standalone path can drift from the shared helper over time. **Follow-up:** consolidate the standalone's `buildBoardCards` into the shared `_buildBoardCards` (requires standalone-specific testing and a `timeoutMs` source from the standalone config provider — the helper's parameterized signature already enables this). Out of scope for this plan.
- **`getCompletedPlans` volume:** the resync now includes completed cards exactly as the editor broadcast does (466 completed rows currently). This matches editor behavior by construction; if payload size ever matters it is a shared future optimization (card projection), not part of this fix.
- **Resync-vs-broadcast convergence:** unchanged — wsHub still sends the snapshot before any broadcast on that connection; broadcasts after the fix carry the same-shaped cards, so there is no longer a "wrong snapshot, corrected later" window.
- **Empty-session_id rows:** previously silently dropped by the resync; now included like any other row. This is strictly a correctness gain (the editor already showed them).

---

**Recommendation:** Send to Coder (complexity 5 — multi-file extraction with byte-identical output requirement, but well-scoped with clear verification steps).

---

## Completion Summary

Implemented the shared `plan_id`-keyed card pipeline in `src/services/KanbanProvider.ts`: extracted the row→card mapping block of `refreshWithData` into a pure private helper `_buildBoardCards(db, workspaceId, workspaceRoot, activeRows, completedRows, timeoutMs)` (with `timeoutMs` parameterized to keep the helper vscode-free), plus a shared `_filterGhostPlans` private method used by both the helper and `refreshWithData`'s inline column-occupancy computation. Rewrote `getFullStateMessages` to source cards through `getBoard`/`getCompletedPlans` (or their `*FilteredByProject` variants when a repoScope is set, mirroring `_refreshRunSheetsImpl` exactly with `null` project) and route them through `_buildBoardCards`, deleting the `getAllPlans` → sessionIds → `_buildCardsFromDbSessionIds` round-trip. Added a `@deprecated` doc comment to `_buildCardsFromDbSessionIds` (sole remaining caller is the `promptSelected` fallback at line ~8929, untouched). No issues encountered; the editor-path extraction is pure code motion (byte-identical card output), and the resync now issues ~4 queries per connect instead of ~1,900. Per session directives, compilation and automated tests were skipped — verification is manual per the plan's Manual Verification steps.
