# Linear Free-Tier: Auto-Archive Issues on Plan Completion

## Goal

Automatically archive Linear issues when their corresponding Switchboard plan reaches a terminal column ("Done", "Completed", "Code Reviewed"), keeping the active issue count below the free tier's 250-issue hard limit. Add a toggle in the Linear setup panel (default: ON) and surface a clear warning about the limit.

### Background & Problem

Linear's free tier caps active (non-archived) issues at 250. The current Switchboard Linear integration syncs all plans as active issues indefinitely — completed and code-reviewed plans remain active in Linear, burning through the quota. Without auto-archiving, users with active boards will silently hit the cap, causing new plan syncs to fail or behave unexpectedly.

Switchboard already has `LinearSyncService.archiveIssue()` (lines 1528–1560) and a `deleteSyncEnabled` flag for archiving on plan deletion. The gap is a separate, status-triggered archive path for completed plans, and user awareness of the limit.

---

## Metadata

**Tags:** backend, api, ui, reliability
**Complexity:** 5

---

## User Review Required

- [ ] Confirm that Linear's free tier does impose a 250 active-issue hard limit (flagged as uncertain assumption — see below).
- [ ] Confirm the desired set of terminal columns: the existing `syncPlan()` code uses `['DONE', 'COMPLETED', 'ARCHIVED']` (line 1915). The plan originally proposed `"Done"` and `"Code Reviewed"` — these should be reconciled. **Recommendation:** align with the existing `terminalColumn` check and use `['DONE', 'COMPLETED', 'ARCHIVED']` plus `'CODE REVIEWED'` (which is a canonical column per `CANONICAL_COLUMNS` but not in the existing terminal list).
- [ ] Confirm default-ON behaviour is acceptable for existing installs (auto-archive activates on first load after upgrade).

---

## Complexity Audit

### Routine
- Adding `completionArchiveEnabled` field to `LinearConfig` interface (line 17–34) — follows the exact pattern of `deleteSyncEnabled` (line 30) and `completeSyncEnabled` (line 31).
- Adding the field to `_createEmptyConfig()` (line 181) — single-line addition, default `true`.
- Adding the field to `_normalizeConfig()` (line 202) — single-line addition with default `true` for missing key.
- Adding the field to `LinearApplyOptions` interface (line 36–46) — follows `deleteSyncEnabled` pattern.
- Adding the field to `applyConfig()` (line 1814) — single-line assignment, follows `deleteSyncEnabled` pattern at line 1875.
- Adding checkbox HTML to `setup.html` — follows the exact pattern of the `deleteSyncEnabled` checkbox (lines 1137–1145).
- Adding the field to `collectLinearApplyOptions()` (line 2626) — single-line addition.
- Adding the field to `renderLinearOptionSummary()` (line 2680) — single `setCheckboxState` call.
- Adding the field to `LinearSetupState` type (line 196) — single property addition.
- Adding the field to `linearState` object construction (line 4500) — single property addition.

### Complex / Risky
- **Wiring archive into `syncPlan()` flow:** The archive must fire AFTER the state update succeeds (line 1925–1938), not before. The existing `debouncedSync` → `syncPlan` path is the correct injection point, but the archive call must be appended after the successful issue update/create, and must not throw on failure. This requires careful placement within the try/catch at lines 1924–1945.
- **Pre-existing hydration gap:** `LinearSetupState` (line 196) and the `linearState` construction (line 4500) are missing `deleteSyncEnabled` and `excludeBacklog` fields, yet `renderLinearOptionSummary()` (line 2703) references `state.deleteSyncEnabled`. The new `completionArchiveEnabled` field must be added to BOTH the type AND the construction — and the implementer should also fix the pre-existing gap for `deleteSyncEnabled` and `excludeBacklog` while in the area (Clarification: not new scope, just fixing a bug that would otherwise cause the new checkbox to also fail to hydrate).
- **Terminal column definition:** The existing `syncPlan()` terminal check at line 1915 uses `['DONE', 'COMPLETED', 'ARCHIVED']`, but `CANONICAL_COLUMNS` (ClickUpSyncService line 135) includes `'CODE REVIEWED'` which is NOT in that list. The archive trigger must include `'CODE REVIEWED'` to match the plan's intent — this is a deviation from the existing terminal column set.

---

## Edge-Case & Dependency Audit

### Race Conditions
- **Double-archive with deleteSyncEnabled:** If a plan is moved to a terminal column (triggering completion archive) and then immediately deleted (triggering delete-sync archive), both paths call `archiveIssue()` on the same issue. This is safe — Linear's `issueUpdate(archivedAt:)` mutation is idempotent. No mutex needed.
- **Debounced sync timing:** `debouncedSync` (line 2144) has a 500ms debounce. If a plan is rapidly moved through columns (e.g., CREATED → DONE in quick succession), only the final column triggers `syncPlan`. The archive will fire for the terminal column only — correct behaviour.

### Security
- No new API endpoints or token exposure. The archive call reuses the existing `graphqlRequest` helper which reads the token from secret storage.

### Side Effects
- **Archived issues disappear from Linear's default view.** Users on paid tiers who don't need auto-archive may be surprised. The toggle (default ON) and warning note mitigate this, but the default-ON choice means paid-tier users will have issues archived unless they explicitly disable it.
- **No undo in Linear UI for archive.** Linear issues can be un-archived manually, but there's no Switchboard-side undo. The non-blocking error notification should mention this.

### Dependencies & Conflicts
- **Depends on `archiveIssue()` handling already-archived issues gracefully.** Current implementation (lines 1528–1560) does NOT explicitly check — it blindly sends `issueUpdate(archivedAt:)`. If Linear's API rejects a double-archive, the method returns `{ success: false }` but does not throw. The caller must handle this gracefully (log + notify, don't block). **UPDATE after research:** `issueArchive` is confirmed idempotent (returns `success: true` on already-archived), but the existing method uses the WRONG mutation — see Critical Implementation Note above.
- **`columnToStateId` mapping must include the terminal column.** If the user hasn't mapped "Done"/"Completed"/"Code Reviewed" to a Linear state, `syncPlan()` returns early at line 1907–1910 before the archive logic fires. **Clarification:** The archive should fire even if the column isn't mapped to a Linear state — the issue may already exist from a previous sync when it WAS mapped. The archive check should be based on the Kanban column name, not the state mapping.
- **CRITICAL — Post-archive push-back from ContinuousSyncService.** When a plan is in the `'CODE REVIEWED'` column and auto-archive fires, the Linear issue is archived. Per the research, archived issues are **read-only** — `issueUpdate` calls on archived issues **fail**. So when the agent subsequently edits the plan (e.g. adds code review feedback), `_syncToLinear()` calls `syncPlanContent()` → `issueUpdate(input:{description})` which **fails**, content doesn't sync, and the user gets an error toast on every edit. **FIX:** Rather than blocking the push (which would also put plans out of sync), use an unarchive → push → re-archive flow in `_syncToLinear()` — temporarily restore the issue, push the content update, then re-archive. See Implementation Task 10. This requires a new `unarchiveIssue()` method on `LinearSyncService` (see Critical Implementation Note).

---

## Dependencies

None — this feature is self-contained within the Linear integration.

---

## Adversarial Synthesis

Key risks: (1) The archive fires inside `syncPlan()` which early-returns when a column has no state mapping — meaning unmapped terminal columns would silently skip archiving even if the issue exists. (2) The `LinearSetupState` type and construction are missing `deleteSyncEnabled`/`excludeBacklog`, so the new checkbox will also fail to hydrate unless the pre-existing gap is fixed. (3) Default-ON may surprise paid-tier users. (4) **Post-archive push-back**: archived Linear issues are read-only — `issueUpdate` fails on them, so agent edits after archive would error on every push and content would go out of sync. (5) The existing `archiveIssue()` uses the wrong mutation (`issueUpdate` instead of `issueArchive`). Mitigations: move archive logic to a separate check after `syncPlan` completes, fix the hydration gap, **unarchive → push → re-archive in `_syncToLinear()`** (keeps content in sync while keeping the issue archived — see Task 10, requires new `unarchiveIssue()` method), fix the `archiveIssue()` mutation, and ensure the warning note is prominent.

---

## Implementation Tasks

### 1. Extend `LinearConfig` with archive-on-completion flag

**File:** `src/services/LinearSyncService.ts`, `LinearConfig` interface (lines 17–34)

Add field:
```typescript
completionArchiveEnabled?: boolean;  // default: true — archive Linear issue when plan reaches terminal column
```

Update `_createEmptyConfig()` (line 181) to include:
```typescript
completionArchiveEnabled: true,  // default true — auto-archive on completion
```

Update `_normalizeConfig()` (line 202, around line 237 after `excludeBacklog`) to include:
```typescript
completionArchiveEnabled: raw.completionArchiveEnabled !== false,  // default true
```

This follows the exact pattern of `completeSyncEnabled` (line 237) and `excludeBacklog` (line 238).

### 2. Extend `LinearApplyOptions` and `applyConfig()`

**File:** `src/services/LinearSyncService.ts`

Add to `LinearApplyOptions` interface (lines 36–46):
```typescript
completionArchiveEnabled?: boolean;  // NEW: archive on completion
```

Add to `applyConfig()` method (line 1814), after line 1877 (`config.excludeBacklog = ...`):
```typescript
config.completionArchiveEnabled = options.completionArchiveEnabled !== false;  // default true
```

### 3. Trigger archive on column transition to terminal columns

**File:** `src/services/LinearSyncService.ts`, `syncPlan()` method (line 1902)

**Critical design decision:** The archive must fire AFTER the state update succeeds, and must fire even if the column has no state mapping (the issue may already exist from a prior sync). The cleanest approach is to add the archive call at the END of `syncPlan()`, after the existing try/catch block, as a separate fire-and-forget call.

After the existing try/catch at lines 1924–1945, add:
```typescript
// §5 — completionArchiveEnabled: archive the Linear issue when the plan
// reaches a terminal column. This is a separate concern from the state
// update above — the issue may already exist even if the column isn't
// mapped to a Linear state.
const archiveColumns = ['DONE', 'COMPLETED', 'ARCHIVED', 'CODE REVIEWED'];
if (config.completionArchiveEnabled !== false
    && archiveColumns.includes((newColumn || '').toUpperCase())
    && existingIssueId) {
  try {
    const archiveResult = await this.archiveIssue(existingIssueId);
    if (!archiveResult.success) {
      console.warn(
        `[LinearSync] Completion archive failed for issue ${existingIssueId}: ${archiveResult.error}. ` +
        `The state update succeeded — the issue is in the correct Linear state but remains active.`
      );
    }
  } catch (archiveError) {
    console.warn(
      `[LinearSync] Completion archive threw for issue ${existingIssueId}: ${archiveError}. ` +
      `Continuing — state update already succeeded.`
    );
  }
}
```

**Why this placement:** `existingIssueId` is already resolved at line 1921. The archive runs after the state update succeeds. If the state update fails (the catch at line 1942 re-throws), the archive is skipped — correct, because the issue may not be in the right state yet.

**Why `CODE REVIEWED` is included:** `CANONICAL_COLUMNS` (ClickUpSyncService line 135) includes `'CODE REVIEWED'` as a canonical column. The plan's intent is to archive when plans are "completed or code reviewed." The existing `terminalColumn` check at line 1915 does NOT include it, but the archive trigger should.

### 4. Define completion columns

Completion columns should be resolved from the `columnToStateId` mapping rather than hardcoded strings where possible. As a practical fallback, match against the canonical names `"Done"`, `"Completed"`, `"Code Reviewed"` case-insensitively. Do not archive for intermediate columns (In Progress, Review, etc.).

If the user has renamed their completion columns to non-standard names, they will not be auto-archived — this is acceptable behaviour for v1. Document this in the setup UI tooltip.

**Clarification:** The implementation in step 3 uses a hardcoded `archiveColumns` list. This is consistent with the existing `terminalColumn` check at line 1915 which also uses a hardcoded list. A future enhancement could derive this from `columnToStateId` + Linear state type metadata, but that's out of scope for v1.

### 5. Add warning note and toggle to setup.html

**File:** `src/webview/setup.html`, Linear section (lines 972+, `id="linear-fields"`)

**Warning note** — add near the top of the Linear sync options, visually distinct (amber/yellow left-border callout, not an error):
```
⚠ Linear free tier limit: 250 active issues. Completed and code-reviewed plans are 
archived automatically to stay within this limit. Upgrade your Linear plan or disable 
auto-archive below if you are on a paid tier.
```

**Toggle checkbox** — add in the automation/sync options area, after the existing `deleteSyncEnabled` checkbox (lines 1137–1145, specifically after the closing `</div>` at line 1145):
- Label: **"Archive Linear issues when plans are completed or code reviewed"**
- Sub-label: *"Recommended for free-tier Linear accounts (250 active issue limit)."*
- Default: checked (ON)
- ID: `#linear-option-completion-archive`
- On change: included in `collectLinearApplyOptions()` and saved via the existing APPLY LINEAR SETTINGS button flow

HTML pattern (follows `deleteSyncEnabled` checkbox at lines 1137–1145):
```html
<div>
    <label class="startup-row" style="display:flex; align-items:flex-start; gap:8px;">
        <input id="linear-option-completion-archive" type="checkbox" checked style="width:auto; margin:0; margin-top:2px;">
        <span>Archive Linear issues when plans are completed or code reviewed</span>
    </label>
    <div style="font-size:9px; color:var(--text-secondary); margin-left:20px; margin-top:2px; line-height:1.3;">
        Recommended for free-tier Linear accounts (250 active issue limit). Archived issues can be restored in Linear.
    </div>
</div>
```

### 6. Persist the toggle value — setup.html collection

**File:** `src/webview/setup.html`, `collectLinearApplyOptions()` function (line 2626)

Add to the returned object (after line 2642):
```javascript
completionArchiveEnabled: document.getElementById('linear-option-completion-archive')?.checked !== false
```

Note: `!== false` means default true if the element is missing — consistent with the backend default.

### 7. Persist the toggle value — setup.html hydration

**File:** `src/webview/setup.html`, `renderLinearOptionSummary()` function (line 2680)

Add after line 2704 (`setCheckboxState('linear-option-exclude-backlog', ...)`):
```javascript
setCheckboxState('linear-option-completion-archive', state.completionArchiveEnabled !== false);
```

Also add to the `parts` array (around line 2715):
```javascript
if (state.completionArchiveEnabled !== false) parts.push('Completion archive: ON');
```

### 8. Persist the toggle value — TaskViewerProvider state construction

**File:** `src/services/TaskViewerProvider.ts`

**8a.** Add `completionArchiveEnabled` to `LinearSetupState` type (line 196):
```typescript
type LinearSetupState = {
    setupComplete: boolean;
    mappingsReady: boolean;
    labelReady: boolean;
    includeProjectNames: string[];
    excludeProjectNames: string[];
    realTimeSyncEnabled: boolean;
    autoPullEnabled: boolean;
    completeSyncEnabled: boolean;
    completionArchiveEnabled: boolean;  // NEW
    deleteSyncEnabled: boolean;         // FIX: add missing field
    excludeBacklog: boolean;            // FIX: add missing field
    columns: LinearSetupColumnState[];
    availableLabels: Array<{ id: string; name: string }>;
    availableStates: Array<{ id: string; name: string; type: string }>;
    automationRules: LinearAutomationRule[];
    error?: string;
};
```

**8b.** Add `completionArchiveEnabled`, `deleteSyncEnabled`, and `excludeBacklog` to the `linearState` object construction (line 4500):
```typescript
linearState = {
    setupComplete: linearConfig.setupComplete === true,
    mappingsReady,
    labelReady: String(linearConfig.switchboardLabelId || '').trim().length > 0,
    includeProjectNames: linearConfig.includeProjectNames ?? [],
    excludeProjectNames: linearConfig.excludeProjectNames ?? [],
    realTimeSyncEnabled: linearConfig.realTimeSyncEnabled === true,
    autoPullEnabled: linearConfig.autoPullEnabled === true,
    completeSyncEnabled: linearConfig.completeSyncEnabled !== false,
    completionArchiveEnabled: linearConfig.completionArchiveEnabled !== false,  // NEW
    deleteSyncEnabled: linearConfig.deleteSyncEnabled === true,                  // FIX
    excludeBacklog: linearConfig.excludeBacklog !== false,                       // FIX
    columns: currentColumns.map((column) => ({
        columnId: column.id,
        label: column.label
    })),
    availableLabels: [],
    availableStates: [],
    automationRules: linearConfig.automationRules
};
```

### 9. Update `syncSectionDisclosure` for the new checkbox

**File:** `src/webview/setup.html`, `syncSectionDisclosure('linear')` function (around line 3017)

Add the new checkbox to the automation disclosure check:
```javascript
const completionArchive = document.getElementById('linear-option-completion-archive')?.checked;
const aOpen = !!(realtimeSync || deleteSync || autoPull || completionArchive || hasAutomationRules);
```

### 10. Unarchive → push → re-archive in terminal columns

**File:** `src/services/ContinuousSyncService.ts`, `_syncToLinear()` method (line 874)

**Problem:** When a plan is in the `'CODE REVIEWED'` column and auto-archive fires, the Linear issue is archived. Per the research, archived issues are **read-only** — `issueUpdate` calls on archived issues **fail** (return an error or `success: false`). So when the agent subsequently edits the plan (e.g. adds code review feedback), `_syncToLinear()` calls `syncPlanContent()` → `issueUpdate(input:{description})` which **fails**, content doesn't sync, and the user gets an error toast on every edit. The plans go out of sync — the exact problem we want to avoid.

**Why NOT block the push:** Blocking sync for `'CODE REVIEWED'` would also mean content doesn't sync. The whole point of having the issue linked is to keep it in sync, including code review additions.

**Fix — unarchive before push, re-archive after:** Let the content sync by temporarily unarchiving the issue, pushing the update, then re-archiving. Replace the body of `_syncToLinear()` (lines 891-896) with:
```typescript
const archiveColumns = ['CODE REVIEWED', 'COMPLETED'];
const needsArchiveDance = config.completionArchiveEnabled !== false
    && archiveColumns.includes(plan.kanbanColumn);

// §10 — Archived issues are read-only (issueUpdate fails on them).
// If the plan is in a terminal column where auto-archive would have fired,
// unarchive first so the push succeeds, then re-archive after.
if (needsArchiveDance) {
  const unarchiveResult = await linear.unarchiveIssue(plan.linearIssueId);
  if (!unarchiveResult.success) {
    // Could be already un-archived, or token/API issue. Log and try
    // the push anyway — if the issue was already active, it'll work.
    console.warn(
      `[ContinuousSync] Pre-push unarchive failed for ${plan.linearIssueId}: ${unarchiveResult.error}. ` +
      `Attempting push anyway.`
    );
  }
}

const result = await linear.syncPlanContent(plan.linearIssueId, content, signal);
if (!result.success) {
  console.warn(`[ContinuousSync] Linear sync failed for ${plan.planFile}: ${result.error}`);
  // If we unarchived but the push failed, re-archive to restore state.
  if (needsArchiveDance) {
    try { await linear.archiveIssue(plan.linearIssueId); } catch (e) { /* best effort */ }
  }
  throw new Error(result.error);
}

// §10 — Re-archive so the issue stays archived while keeping content up-to-date.
if (needsArchiveDance) {
  try {
    await linear.archiveIssue(plan.linearIssueId);
  } catch (rearchiveError) {
    // Non-blocking — the content synced, which is the important part.
    // The issue may remain un-archived until the next push cycle or manual archive.
    console.warn(
      `[ContinuousSync] Re-archive after push failed for ${plan.linearIssueId}: ${rearchiveError}. ` +
      `Content was synced; issue may be temporarily un-archived.`
    );
  }
}

return { skipped: false };
```

**Flow summary:**
1. **Unarchive** — restore the issue to active state so `issueUpdate` can write to it. If this fails (issue may already be active, or API error), log and try the push anyway.
2. **Push** — `syncPlanContent()` succeeds because the issue is now active. If the push fails after a successful unarchive, re-archive to restore the original state before throwing.
3. **Re-archive** — put the issue back in the archive with updated content. `issueArchive` is idempotent (confirmed by research), so this is safe even if the issue was never actually un-archived. If re-archive fails, the issue is temporarily un-archived with updated content — non-blocking, it'll be re-archived on the next push cycle.

**API call count:** 3 mutations per push cycle (unarchive + update + archive) instead of 1. The push is debounced (3s, max 60s) by ContinuousSyncService's file-change debounce, so this fires at most once per debounce window — 3 extra mutations per cycle is negligible within Linear's 2,500 req/hour budget.

**Why `_syncToLinear` is the right place:** It already has `plan` (with `kanbanColumn`), `config` (loaded at line 881, has `completionArchiveEnabled`), and `linear` (has `archiveIssue()` and the new `unarchiveIssue()`). No new dependencies or constructor changes needed.

**Optional extension — un-block COMPLETED:** Currently `_isEligibleForLiveSync()` (line 251) blocks sync for `'COMPLETED'`. If the user wants final content edits on completed plans to also reach Linear (with the same unarchive-push-rearchive pattern), remove `'COMPLETED'` from that gate. The code above already handles `'COMPLETED'`. This is a separate decision — the user should confirm whether completed plans should continue syncing.

---

## Edge Cases & Risks

- **Existing installs:** `completionArchiveEnabled` will be absent in existing `LinearConfig` records. Defaulting to `true` in `_normalizeConfig()` means auto-archive activates on first load after upgrade. This is the right behaviour — existing users are the most likely to have accumulated 250+ issues.
- **Archive fails silently:** Linear API errors during archive should not block local state transitions. Log and notify non-blockingly. The implementation in step 3 wraps the archive call in its own try/catch, separate from the state update.
- **Already archived:** Calling `archiveIssue()` on an already-archived issue sends `issueUpdate(archivedAt:)` with a new timestamp. Linear's API likely treats this as idempotent (success), but if it returns `{ success: false }`, the warning log is non-blocking. **Uncertain assumption:** Linear's API behaviour on double-archive is not verified from code — flagged below.
- **Paid tier users:** Users on paid Linear plans have no active issue cap. The toggle (default ON) is harmless for them but may clutter their Linear history. The warning note should acknowledge this and make it easy to disable.
- **Column name mismatches:** If completion columns are renamed, auto-archive won't fire. The setup UI tooltip should mention this so users know to check.
- **Race with deleteSyncEnabled:** If a plan is deleted from Switchboard, `deleteSyncEnabled` may also try to archive. This is a no-op double-archive — safe.
- **Pre-existing hydration bug:** `LinearSetupState` type and `linearState` construction are missing `deleteSyncEnabled` and `excludeBacklog` fields, causing those checkboxes to not hydrate from saved config. This plan's implementation fixes this as a necessary prerequisite (the new `completionArchiveEnabled` checkbox would have the same bug otherwise).
- **Post-archive push-back from ContinuousSyncService:** When a plan is archived in Linear (after reaching `'CODE REVIEWED'`), `ContinuousSyncService` continues pushing description updates on agent edits — which is the desired behavior (keeps Linear content in sync). Because archived issues are read-only (`issueUpdate` fails on them), Task 10 uses an unarchive → push → re-archive flow. If the unarchive or re-archive fails (non-blocking), the issue may be temporarily un-archived with updated content until the next push cycle. Content sync is never blocked.
- **Plan moved back from CODE REVIEWED for rework:** If a plan is moved back from `'CODE REVIEWED'` to an earlier column (e.g. `'CODER CODED'`), the archive dance in Task 10 no longer fires (the column check fails). The issue is still archived from the previous CODE REVIEWED state. The next status-sync push (`syncPlan()`) will call `issueUpdate(input:{stateId})` on the archived issue — this **fails** (archived issues are read-only), so `syncPlan()` falls back to `createIssue()` (line 1934-1935), creating a fresh Linear issue for the reworked plan. The old archived issue stays archived.

---

## Migration

No schema changes. `LinearConfig` is stored as a JSON blob in the Kanban DB config table. Adding a new key with a default in `_normalizeConfig()` is a non-destructive migration.

---

## Out of Scope

- No change to the *semantic meaning* of "archive" in Linear (still removes from active view) — but the **mutation shape must change** from `issueUpdate(archivedAt)` to the dedicated `issueArchive` mutation (see Critical Implementation Note above)
- No configurable list of completion column names (v1: canonical names only)
- No retroactive archiving of already-completed plans on upgrade (only new transitions trigger it)

---

## Uncertain Assumptions

> **Research completed.** The user ran web research (findings in `docs/imported_document_2026_06_27t11_27_53.md`) and the results have been incorporated below.

1. **Linear free-tier 250 active-issue limit — CONFIRMED.** Linear's free tier restricts workspaces to **250 non-archived issues** (per workspace, not per team). The limit includes backlog, triage, active, completed, and canceled states — only issues with `archivedAt` populated are excluded. The plan's core premise is VALID. Auto-archiving completed/canceled issues is the correct mitigation.
2. **Linear API idempotency on double-archive — CONFIRMED with a CRITICAL CORRECTION.** The dedicated `issueArchive` mutation is fully idempotent: calling it on an already-archived issue returns `success: true` and the original `archivedAt` — no error, no pre-check needed. **HOWEVER**, the research states archival MUST use the dedicated `issueArchive` mutation, NOT `issueUpdate(input:{archivedAt})`. The existing `archiveIssue()` at `LinearSyncService.ts:1540-1549` currently uses `issueUpdate(input:{archivedAt: $archivedAt})` — this is the WRONG mutation per the current Linear API. **This moves fixing `archiveIssue()` INTO scope** (see Critical Implementation Note below). There is no `isArchived` boolean field; use `archivedAt` to check state if ever needed, though idempotency makes pre-checks unnecessary.

### Critical Implementation Note: `archiveIssue()` Mutation Correction + New `unarchiveIssue()`

The existing `archiveIssue()` (lines 1528-1560) uses:
```graphql
mutation($id: String!, $archivedAt: DateTime!) {
  issueUpdate(id: $id, input: { archivedAt: $archivedAt }) { success }
}
```
Per the research, Linear requires the dedicated `issueArchive` mutation:
```graphql
mutation IssueArchive($id: String!) {
  issueArchive(id: $id) { success entity { id archivedAt } }
}
```
**Action required:** As part of this plan, update `archiveIssue()` to use the `issueArchive` mutation (no `archivedAt` input needed — Linear stamps it). This also benefits the existing `deleteSyncEnabled` archive path. The "Out of Scope" line below ("No change to what 'archive' means in Linear") is superseded by this correction — the mutation shape must change, though the semantic meaning of "archive" is unchanged.

**Additionally — new `unarchiveIssue()` method required.** Per the research, archived issues are in a read-only state: `issueUpdate` calls on archived issues **fail** (return an error or `success: false`). To push content updates to an archived issue, it must first be restored via the `issueUnarchive` mutation. This is needed for Task 10 (unarchive → push → re-archive flow). Add a new method:
```typescript
async unarchiveIssue(issueId: string): Promise<{ success: boolean; error?: string }> {
  // ... same config/validation pattern as archiveIssue() ...
  const result = await this.graphqlRequest(`
    mutation IssueUnarchive($id: String!) {
      issueUnarchive(id: $id) { success entity { id archivedAt } }
    }
  `, { id: normalizedIssueId });
  // ... same success/error handling as archiveIssue() ...
}
```
Place it immediately after `archiveIssue()` (after line 1560).

---

## Proposed Changes

### `src/services/LinearSyncService.ts`

**Context:** Core Linear sync service. Contains `LinearConfig` interface (line 17), `LinearApplyOptions` interface (line 36), `_createEmptyConfig()` (line 181), `_normalizeConfig()` (line 202), `applyConfig()` (line 1814), `syncPlan()` (line 1902), `archiveIssue()` (line 1528).

**Logic:**
1. Add `completionArchiveEnabled?: boolean` to `LinearConfig` (after line 31, following `completeSyncEnabled` pattern).
2. Add `completionArchiveEnabled: true` to `_createEmptyConfig()` (after line 196).
3. Add `completionArchiveEnabled: raw.completionArchiveEnabled !== false` to `_normalizeConfig()` (after line 238).
4. Add `completionArchiveEnabled?: boolean` to `LinearApplyOptions` (after line 45).
5. Add `config.completionArchiveEnabled = options.completionArchiveEnabled !== false` to `applyConfig()` (after line 1877).
6. Add archive-on-completion block to `syncPlan()` after the existing try/catch (after line 1945), checking `archiveColumns` list and calling `this.archiveIssue(existingIssueId)`.

**Implementation:** See steps 1–3 above for exact code.

**Edge Cases:**
- `existingIssueId` may be null (plan not yet synced to Linear) — the `&& existingIssueId` guard skips archive.
- `config.completionArchiveEnabled !== false` means default true for missing key.
- Archive failure is caught and logged, does not propagate.

### `src/webview/setup.html`

**Context:** Setup panel webview. Contains Linear section HTML (line 972+), `collectLinearApplyOptions()` (line 2626), `renderLinearOptionSummary()` (line 2680), `syncSectionDisclosure()` (line ~3017).

**Logic:**
1. Add warning callout near top of Linear section (after line 975).
2. Add checkbox HTML after `deleteSyncEnabled` checkbox (after line 1145).
3. Add `completionArchiveEnabled` to `collectLinearApplyOptions()` return object (after line 2642).
4. Add `setCheckboxState` call for new checkbox in `renderLinearOptionSummary()` (after line 2704).
5. Add `completionArchive` to `syncSectionDisclosure` automation check (around line 3017).

**Implementation:** See steps 4–9 above for exact code.

**Edge Cases:**
- Checkbox default is `checked` (ON) — matches backend default.
- `document.getElementById(...)?.checked !== false` handles missing element gracefully.

### `src/services/TaskViewerProvider.ts`

**Context:** Task viewer provider. Contains `LinearSetupState` type (line 196), `getIntegrationSetupStates()` (line 4382), `linearState` construction (line 4500).

**Logic:**
1. Add `completionArchiveEnabled: boolean` to `LinearSetupState` type (after line 204).
2. Add `deleteSyncEnabled: boolean` and `excludeBacklog: boolean` to `LinearSetupState` type (fix pre-existing gap).
3. Add `completionArchiveEnabled`, `deleteSyncEnabled`, `excludeBacklog` to `linearState` object construction (after line 4508).

**Implementation:** See step 8 above for exact code.

**Edge Cases:**
- `deleteSyncEnabled` and `excludeBacklog` were already referenced by `renderLinearOptionSummary()` but missing from the type and construction — this is a bug fix, not new scope.

---

## Verification Plan

### Manual Verification
1. **Config round-trip:** Open Linear setup panel → verify new checkbox appears checked by default → uncheck → APPLY → close and reopen panel → verify checkbox state persisted.
2. **Archive on completion:** Create a plan synced to Linear → move plan to "Done" column → verify Linear issue is archived (check Linear UI).
3. **Archive on code reviewed:** Move plan to "Code Reviewed" column → verify Linear issue is archived.
4. **No archive on intermediate columns:** Move plan to "In Progress" → verify Linear issue is NOT archived.
5. **Toggle off:** Uncheck "Archive on completion" → move plan to "Done" → verify Linear issue is NOT archived.
6. **Archive failure:** With invalid API token, move plan to "Done" → verify local column transition succeeds, error is logged, non-blocking notification shown.
7. **Already archived:** Move already-archived plan to "Done" again → verify no error thrown, graceful handling.
8. **Delete sync coexistence:** Enable both "delete sync" and "completion archive" → delete a plan in "Done" column → verify no double-archive error.
9. **Existing install upgrade:** Load workspace with pre-existing `LinearConfig` (no `completionArchiveEnabled` key) → verify checkbox defaults to checked, archive fires on next completion transition.

### Automated Tests
- `src/test/setup-panel-migration.test.js` — verify setup.html includes `id="linear-option-completion-archive"` checkbox and `collectLinearApplyOptions` includes `completionArchiveEnabled`.
- Unit test for `_normalizeConfig()` — verify `completionArchiveEnabled` defaults to `true` when absent from raw config.
- Unit test for `syncPlan()` — verify archive is called when column is terminal and `completionArchiveEnabled` is true; verify archive is NOT called when column is non-terminal or `completionArchiveEnabled` is false.

---

**Recommendation:** Complexity 5 → **Send to Coder**
