# Linear Free-Tier: Auto-Archive Issues on Plan Completion

## Goal

Automatically archive Linear issues when their corresponding Switchboard plan reaches the "Code Reviewed" or "Done" column, keeping the active issue count below the free tier's 250-issue hard limit. Add a toggle in the Linear setup panel (default: ON) and surface a clear warning about the limit.

### Background & Problem

Linear's free tier caps active (non-archived) issues at 250. The current Switchboard Linear integration syncs all plans as active issues indefinitely — completed and code-reviewed plans remain active in Linear, burning through the quota. Without auto-archiving, users with active boards will silently hit the cap, causing new plan syncs to fail or behave unexpectedly.

Switchboard already has `LinearSyncService.archiveIssue()` (lines 1528–1560) and a `deleteSyncEnabled` flag for archiving on plan deletion. The gap is a separate, status-triggered archive path for completed plans, and user awareness of the limit.

---

## Implementation Tasks

### 1. Extend `LinearConfig` with archive-on-completion flag

**File:** `src/services/LinearSyncService.ts`, `LinearConfig` interface (lines 17–34)

Add field:
```typescript
completionArchiveEnabled: boolean; // default true
```

Update `loadConfig()` to default `completionArchiveEnabled` to `true` for existing installs where the key is absent (forward-compat default — safe to apply, no destructive effect on data).

### 2. Trigger archive on column transition to completion columns

**File:** `src/services/LinearSyncService.ts` (or the call site in `TaskViewerProvider.ts` that pushes status changes to Linear)

When a plan's Kanban column changes and Linear sync is active:
- If the new column name is `"Done"` or `"Code Reviewed"` (case-insensitive match)
- And `LinearConfig.completionArchiveEnabled === true`
- And the plan has a `linearIssueId`
- Call `archiveIssue(linearIssueId)`

Do not fail the local column transition if archiving fails — log the error, surface a non-blocking notification ("Could not archive Linear issue — check your Linear API token"), and continue.

**Important:** This should fire on the sync push that writes the new status to Linear, not as a separate polling pass. The archive call replaces no existing logic — it's additive.

### 3. Define completion columns

Completion columns should be resolved from the `columnToStateId` mapping rather than hardcoded strings where possible. As a practical fallback, match against the canonical names `"Done"` and `"Code Reviewed"` case-insensitively. Do not archive for intermediate columns (In Progress, Review, etc.).

If the user has renamed their completion columns to non-standard names, they will not be auto-archived — this is acceptable behaviour for v1. Document this in the setup UI tooltip.

### 4. Add warning note and toggle to setup.html

**File:** `src/webview/setup.html`, Linear section (lines 972–1161, `id="linear-fields"`)

**Warning note** — add near the top of the Linear sync options, visually distinct (amber/yellow left-border callout, not an error):
```
⚠ Linear free tier limit: 250 active issues. Completed and code-reviewed plans are 
archived automatically to stay within this limit. Upgrade your Linear plan or disable 
auto-archive below if you are on a paid tier.
```

**Toggle checkbox** — add in the automation/sync options area (near the existing `deleteSyncEnabled` checkbox at lines 1139–1143):
- Label: **"Archive Linear issues when plans are completed or code reviewed"**
- Sub-label: *"Recommended for free-tier Linear accounts (250 active issue limit)."*
- Default: checked (ON)
- ID: `#linear-completion-archive-checkbox`
- On change: save to `LinearConfig.completionArchiveEnabled` via existing config save path

### 5. Persist the toggle value

**File:** `TaskViewerProvider.ts` (Linear config save handler, near lines 4756 and 4795)

When saving Linear config from the setup panel, read `#linear-completion-archive-checkbox` state and write `completionArchiveEnabled` to `LinearConfig` in the DB. Ensure it is included in the config reset/fresh-setup path, defaulting to `true`.

---

## Edge Cases & Risks

- **Existing installs:** `completionArchiveEnabled` will be absent in existing `LinearConfig` records. Defaulting to `true` in `loadConfig()` means auto-archive activates on first load after upgrade. This is the right behaviour — existing users are the most likely to have accumulated 250+ issues.
- **Archive fails silently:** Linear API errors during archive should not block local state transitions. Log and notify non-blockingly.
- **Already archived:** Calling `archiveIssue()` on an already-archived issue should be a no-op. Verify `archiveIssue()` handles this gracefully (check existing implementation at lines 1528–1560).
- **Paid tier users:** Users on paid Linear plans have no active issue cap. The toggle (default ON) is harmless for them but may clutter their Linear history. The warning note should acknowledge this and make it easy to disable.
- **Column name mismatches:** If completion columns are renamed, auto-archive won't fire. The setup UI tooltip should mention this so users know to check.
- **Race with deleteSyncEnabled:** If a plan is deleted from Switchboard, `deleteSyncEnabled` may also try to archive. This is a no-op double-archive — safe.

---

## Migration

No schema changes. `LinearConfig` is stored as a JSON blob in the Kanban DB config table. Adding a new key with a default in `loadConfig()` is a non-destructive migration.

---

## Out of Scope

- No change to what "archive" means in Linear (uses existing `archiveIssue()` GraphQL mutation)
- No configurable list of completion column names (v1: canonical names only)
- No retroactive archiving of already-completed plans on upgrade (only new transitions trigger it)

---

## Metadata

**Complexity:** 3
**Tags:** backend, api, ui, reliability, infrastructure
