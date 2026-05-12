# Plan: Remove Delete Sync Default True for ClickUp and Linear

## Goal

Change the default behavior for task deletion sync from opt-out to opt-in. Currently, Linear defaults `deleteSyncEnabled` to `true` for existing setups (`setupComplete === true`), which archives the Linear issue when a Switchboard plan is deleted unless the user explicitly opts out. This is dangerous and should require explicit user opt-in. ClickUp already has `deleteSyncEnabled` with a safe `false` default; only Linear needs fixing.

## Metadata

**Tags:** bugfix, UX, backend
**Complexity:** 4

## Problem

**Current State:**
- Linear: `deleteSyncEnabled` defaults to `true` for existing setups (`setupComplete === true`), meaning deleting a Switchboard plan automatically archives the corresponding Linear issue unless the user explicitly sets it to `false`
- ClickUp: `deleteSyncEnabled` already exists with a safe `false` default; deleting a plan only touches the ClickUp task if the user has explicitly opted in

**Risk:**
- Users may accidentally delete a Switchboard plan and unexpectedly lose the corresponding Linear issue
- The default should be safe (opt-in) rather than destructive (opt-out)

**Desired State:**
- Linear should default `deleteSyncEnabled` to `false` for all users, regardless of setup state
- Users must explicitly opt-in to have plan deletion sync to the external task

## Root Cause

1. Linear's config normalization in `LinearSyncService.ts` sets `deleteSyncEnabled` to `true` by default for existing setups (`setupComplete === true`) at lines 220-222
2. The Linear setup UI in `setup.html` uses `!== false` for the delete sync checkbox state at line 2874, which implicitly checks the box for existing users
3. The Linear delete handler in `TaskViewerProvider.ts` uses `!== false` at line 12495, which defaults to archiving the Linear issue
4. The Linear `applySetup()` method in `LinearSyncService.ts` uses `!== false` at line 1479, which defaults to enabling delete sync
5. The Linear setup summary text in `setup.html` uses `!== false` at line 2887, which displays "enabled" when the value is undefined
6. The Linear interface comment at line 27 says `// default: true`, documenting the unsafe default
7. The Linear `_createEmptyConfig()` at lines 168-186 omits `deleteSyncEnabled` entirely, relying on normalization to set the default
8. ClickUp already has `deleteSyncEnabled` with a `false` default in its config, normalization, empty config, and delete handler — no changes needed for ClickUp

## User Review Required

**Yes** — This is a breaking change for existing Linear users who relied on the implicit `deleteSyncEnabled: true` behavior (via `setupComplete === true`). These users will need to explicitly re-enable delete sync in the setup UI after this change.

## Complexity Audit

### Routine
- Step 1: Change Linear default from `(raw.setupComplete === true)` to `false` in config normalization (`LinearSyncService.ts` lines 220-222)
- Step 2: Fix Linear `applySetup()` from `!== false` to `=== true` (`LinearSyncService.ts` line 1479)
- Step 3: Fix Linear setup UI checkbox state from `!== false` to `=== true` in `setup.html` line 2874
- Step 4: Fix Linear setup summary text from `!== false` to `=== true` in `setup.html` line 2887
- Step 5: Fix Linear delete handler from `!== false` to `=== true` in `TaskViewerProvider.ts` line 12495
- Step 6: Update Linear interface comment from `// default: true` to `// default: false` in `LinearSyncService.ts` line 27
- Step 7: Add explicit `deleteSyncEnabled: false` to `_createEmptyConfig()` in `LinearSyncService.ts` (after line 181, before `completeSyncEnabled`)
- Step 8: Verify ClickUp `archiveTask()` already uses safe `false` default (already implemented)

### Complex / Risky
- None

## Edge-Case & Dependency Audit

### Race Conditions
- No race conditions. Config normalization is synchronous and runs at load time. The delete handler reads the config at deletion time, which is user-initiated and single-threaded within the VS Code extension host.

### Security
- No security implications. This change makes destructive behavior *harder* to trigger (opt-in vs opt-out), which is a security improvement.

### Side Effects
- **Breaking behavior change for existing Linear users**: Users with `setupComplete === true` who never explicitly set `deleteSyncEnabled` will find that deleting a Switchboard plan no longer archives their Linear issue. This is the intended safety improvement but is a breaking change.
- **No data loss risk from the change itself**: The change only prevents automatic archiving; it does not delete or modify any existing data.

### Dependencies & Conflicts
- No dependencies on other plans or sessions. This is a standalone behavioral change.
- The `completeSyncEnabled` and `excludeBacklog` fields use the same `!== false` / `!== true` patterns for Linear but are intentionally keeping their defaults (`true` for both). Those should NOT be changed as part of this plan.

## Dependencies

None — this is a standalone config/behavior change

## Adversarial Synthesis

Changing Linear's `deleteSyncEnabled` default from true to false is a correct safety fix, but the plan originally identified only 2 of 7 code locations that enforce the unsafe default. The `!== false` pattern appears in three additional locations: the `applySetup()` method (line 1479), the delete handler in TaskViewerProvider (line 12495), and the setup summary text (line 2887). Missing any of these creates an inconsistency where the normalization says "default false" but the runtime behavior still defaults to true. The breaking change for existing Linear users is manageable since they can re-enable via the setup UI, and no data is destroyed by the change itself.

## Proposed Changes

### `src/services/LinearSyncService.ts`

**Context 1:** Interface comment (line 27) documents the unsafe default.

**Logic:** Update the comment to reflect the new safe default.

**Implementation (line 27):**
```typescript
deleteSyncEnabled?: boolean;  // default: false — archive Linear issue when plan is deleted (opt-in)
```

**Edge Cases:** None — this is a comment change only.

---

**Context 2:** Config normalization (lines 220-222) currently sets `deleteSyncEnabled` to `true` by default for existing setups (`setupComplete === true`).

**Logic:** Change the default to `false` to require explicit opt-in for all users, regardless of setup state.

**Implementation (lines 220-222):**
```typescript
deleteSyncEnabled: raw.deleteSyncEnabled === undefined
  ? false  // Changed from (raw.setupComplete === true) — require explicit opt-in for ALL users
  : raw.deleteSyncEnabled === true,
```

**Edge Cases:** Existing configs with `deleteSyncEnabled: true` explicitly set will still work. Users with `setupComplete === true` who never set the flag will now default to `false`. This is intentional but breaking.

---

**Context 3:** `_createEmptyConfig()` (lines 168-186) omits `deleteSyncEnabled` entirely.

**Logic:** Add explicit `deleteSyncEnabled: false` for clarity and consistency with ClickUp's `_createEmptyConfig()`.

**Implementation (insert after line 181, before `completeSyncEnabled`):**
```typescript
deleteSyncEnabled: false,  // default false — require explicit opt-in
```

**Edge Cases:** None — normalization already handles undefined, but explicit is better than implicit.

---

**Context 4:** `applySetup()` method (line 1479) uses `!== false` which defaults to enabling delete sync.

**Logic:** Change to `=== true` to require explicit opt-in, matching the new default behavior.

**Implementation (line 1479):**
```typescript
config.deleteSyncEnabled = options.deleteSyncEnabled === true;
```

**Edge Cases:** When the setup UI sends `deleteSyncEnabled: undefined` (checkbox not present), it will now default to `false` instead of `true`. The setup UI checkbox already sends `checked === true` (line 2805), so the value will only be `true` when explicitly checked.

---

### `src/webview/setup.html`

**Context 5:** Linear setup UI checkbox state (line 2874) currently uses `!== false`, which checks the box when the value is `undefined` or `true`.

**Logic:** Change to `=== true` so the checkbox is only checked when the user has explicitly opted in.

**Implementation (line 2874):**
```typescript
setCheckboxState('linear-option-delete-sync', state.deleteSyncEnabled === true);
```

**Edge Cases:** Users loading the setup wizard for the first time will see the checkbox unchecked. Existing users who had delete sync implicitly enabled will see it unchecked and must re-check to opt in.

---

**Context 6:** Linear setup summary text (line 2887) uses `!== false` which displays "enabled" when the value is undefined.

**Logic:** Change to `=== true` so the summary accurately reflects the opt-in state.

**Implementation (line 2887):**
```typescript
`Delete sync: ${state.deleteSyncEnabled === true ? 'enabled' : 'disabled'}`
```

**Edge Cases:** None — this is a display-only change that aligns with the checkbox state change.

---

### `src/services/TaskViewerProvider.ts`

**Context 7:** Delete handler (line 12495) uses `!== false` which defaults to archiving the Linear issue when `deleteSyncEnabled` is undefined.

**Logic:** Change to `=== true` to require explicit opt-in, matching the new default behavior and the ClickUp pattern at line 12517.

**Implementation (line 12495):**
```typescript
if (linearConfig?.deleteSyncEnabled === true) {  // default false — require explicit opt-in
```

**Edge Cases:** This is the runtime enforcement point. If this line is not changed, the normalization change is ineffective — deleting a plan would still archive the Linear issue even when `deleteSyncEnabled` is `false`/undefined. This is the most critical change in the plan.

---

### `src/services/ClickUpSyncService.ts` (ALREADY IMPLEMENTED)

**Context:** The ClickUp side of this feature has already been implemented in the codebase.

- `ClickUpConfig` interface includes `deleteSyncEnabled?: boolean` (default `false`) at line 32
- `_createEmptyConfig()` initializes `deleteSyncEnabled: false` at line 254
- `_normalizeConfig()` defaults `deleteSyncEnabled` to `false` at lines 292-294
- `archiveTask()` is implemented at lines 1414-1438 using the ClickUp DELETE endpoint

**Note:** The actual `archiveTask()` uses an irreversible HTTP DELETE, which differs semantically from Linear's `archiveIssue()` that merely archives the issue. This is already documented in code comments. No further changes are needed for ClickUp.

---

### `src/services/TaskViewerProvider.ts` — ClickUp delete handler (ALREADY IMPLEMENTED)

**Context:** The ClickUp delete handler already uses the safe `=== true` check at line 12517. No changes needed.

---

## Verification Plan

### Automated Tests
- Unit test in `LinearSyncService.test.ts`: Verify `_normalizeConfig()` returns `deleteSyncEnabled: false` when raw config has `setupComplete: true` but no `deleteSyncEnabled` field.
- Unit test in `LinearSyncService.test.ts`: Verify `_normalizeConfig()` returns `deleteSyncEnabled: true` when raw config explicitly sets `deleteSyncEnabled: true`.
- Unit test in `LinearSyncService.test.ts`: Verify `_normalizeConfig()` returns `deleteSyncEnabled: false` when raw config has `setupComplete: false` and no `deleteSyncEnabled` field.
- Unit test in `LinearSyncService.test.ts`: Verify `_createEmptyConfig()` returns `deleteSyncEnabled: false`.
- Manual test: Open Linear setup wizard, verify the "Archive Linear issues when plans are deleted" checkbox is unchecked by default for a new setup.
- Manual test: For an existing Linear config with `setupComplete: true` and no `deleteSyncEnabled`, verify the checkbox appears unchecked after loading setup.
- Manual test: Delete a Switchboard plan with a linked Linear issue, verify the Linear issue is NOT archived when `deleteSyncEnabled` is not explicitly set to `true`.
- Manual test: Check the Linear setup summary text shows "Delete sync: disabled" when `deleteSyncEnabled` is not explicitly `true`.

## Risks & Notes

- **Breaking Change:** Existing Linear users who relied on the implicit `deleteSyncEnabled: true` behavior (via `setupComplete === true`) will need to manually enable `deleteSyncEnabled` in the setup UI after this change. This is a breaking change but improves safety.
- **ClickUp Semantics:** ClickUp's `archiveTask()` uses an irreversible HTTP DELETE, which differs semantically from Linear's `archiveIssue()` that merely archives the issue. This is already implemented and documented in code comments; no change needed for this plan.
- **Config Migration:** No automatic migration is planned - users will need to manually update their config if they want the old behavior. This is intentional to make the opt-in explicit. Consider adding a one-time migration that writes explicit `deleteSyncEnabled: true` for users who currently have it implicitly enabled.
- **Documentation:** Update setup docs and integration docs to reflect the new default and how to opt-in.

## Recommendation

Send to Coder

---

## Reviewer Notes

### Stage 1: Grumpy Review (Adversarial)
* "Ah, the original plan found 2 out of 7 code locations. That's a 28% hit rate. The plan confidently declared 'only Linear needs fixing' and then missed the most important line — the actual runtime enforcement in TaskViewerProvider.ts line 12495. Without changing that line, the entire plan is theater: you change the normalization default to `false`, but the delete handler still checks `!== false`, so it still archives the Linear issue. You've accomplished nothing except making the config file look different while the runtime behavior stays identical. That's not a bug fix, that's cosmetic surgery on a config file.

And it gets better. The `applySetup()` method at line 1479 also uses `!== false`, meaning every time a user completes the Linear setup wizard, `deleteSyncEnabled` gets set to `true` regardless of whether they checked the box. The setup UI sends `checked === true` from the checkbox (line 2805), which correctly maps to `true` or `undefined`, but then `applySetup()` converts `undefined` to `true` via `!== false`. So even if the user deliberately leaves the checkbox unchecked, the config still ends up with `deleteSyncEnabled: true`. The plan didn't catch this at all.

The setup summary text at line 2887 also uses `!== false`, which means it displays 'enabled' for undefined values. After the normalization change, the config will say `false`, but if any code path sets it back to `undefined`, the summary will lie to the user.

The `_createEmptyConfig()` doesn't include `deleteSyncEnabled` at all. ClickUp's version explicitly sets `deleteSyncEnabled: false`. This inconsistency means a new empty Linear config has an implicit undefined that gets resolved by normalization, while ClickUp's is explicit. Not a bug, but sloppy.

And the interface comment at line 27 still says `// default: true`. So the type definition, the normalization, the apply method, the delete handler, the UI, and the summary text are all out of sync. That's six inconsistencies, and the original plan caught one of them." [CRITICAL]

### Stage 2: Balanced Synthesis
* **What's valid:** The safety-first intent is correct — destructive defaults are bad. The core change (normalization default from `setupComplete === true` to `false`) is the right thing to do. The fact that ClickUp is already implemented correctly provides a clear template for what the Linear code should look like.
* **What's overstated:** The missed locations are real gaps, but they're all the same pattern (`!== false` → `=== true`) applied consistently. Once you identify the pattern, the fixes are mechanical. The `_createEmptyConfig()` omission is cosmetic — normalization handles it — but adding it improves clarity. The interface comment is documentation, not logic.
* **What needs fixing:** The plan must include all 7 code locations where the `!== false` / `default: true` pattern appears for Linear's `deleteSyncEnabled`. The most critical is TaskViewerProvider.ts line 12495 — without that change, the entire fix is ineffective at runtime. The second most critical is LinearSyncService.ts line 1479 (`applySetup()`), which would re-enable delete sync on every setup completion. The remaining changes (UI checkbox, summary text, interface comment, empty config) are consistency fixes that prevent future confusion.
* **Convergence:** Execute all 7 changes as a single atomic commit. The pattern is identical across all locations: change `!== false` to `=== true`, change `default: true` to `default: false`, add explicit `deleteSyncEnabled: false` to empty config. No partial deployment — if any location is missed, the behavior is inconsistent.

### Validation Results
* **Files Changed:** `src/services/LinearSyncService.ts` (4 locations), `src/webview/setup.html` (2 locations), `src/services/TaskViewerProvider.ts` (1 location)
* **Status:** EXECUTED. All 7 code locations modified. ClickUp implementation verified as already complete.
* **Code Fixes Applied:**
  1. `LinearSyncService.ts:27` — Interface comment updated to `// default: false`
  2. `LinearSyncService.ts:182` — `_createEmptyConfig()` now explicitly sets `deleteSyncEnabled: false`
  3. `LinearSyncService.ts:221-222` — `_normalizeConfig()` defaults to `false` instead of `(raw.setupComplete === true)`
  4. `LinearSyncService.ts:1480` — `applySetup()` changed from `!== false` to `=== true`
  5. `setup.html:2908` — Linear setup UI checkbox changed from `!== false` to `=== true`
  6. `setup.html:2921` — Linear setup summary text changed from `!== false` to `=== true`
  7. `TaskViewerProvider.ts:12588` — Delete handler changed from `!== false` to `=== true`
* **Remaining Risks:** Breaking change for existing Linear users; one-time config migration should be considered.
