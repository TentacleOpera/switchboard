# Feature `is_feature` Clobber — Diagnostic Log Analysis

## Summary

The diagnostic log reveals **two distinct bugs**, neither of which was caught by the existing probes (no `FEATURE-CLOBBER`, `createFeatureFromPlanIds`, `sameInstance`, or `reload` events fired at all). **The clobber is happening through a code path the probes don't cover.**

---

## Bug 1: `dev-docs-tab-in-place-fixes-feature` — Created as plan, not feature

### Current DB state
| File | `is_feature` | `feature_id` | Column |
|------|-------------|-------------|--------|
| `dev-docs-tab-in-place-fixes-feature-…6a7d5edc.md` | **0** | *(empty)* | CREATED |

The file lives in `.switchboard/features/` on disk but the DB has `is_feature=0` — so the kanban treats it as a regular plan, not a feature.

### What the log shows

**Timeline (lines 655–661):** From `12:56:16.593Z` through `12:56:16.730Z`, the persist snapshots show this new feature file appearing with **all 51 features at `is_feature:1`**, including `dev-docs-tab-in-place-fixes-feature…=is_feature:1`.

**Then at line 661 (`12:56:16.730Z`):** The `dev-docs` entry suddenly flips to `is_feature:0` while all other features remain at `is_feature:1`. This persist is from the **same** `instance=#3` — same single DB instance.

**Line 663 onwards:** `dev-docs` stays at `is_feature:0` in all subsequent persists.

### Verdict

> **Verdict: UNKNOWN — code path outside probe coverage (Q4 territory).**
>
> The demotion from `is_feature:1` to `is_feature:0` happened on the **same instance (#3)**, with **no** `FEATURE-CLOBBER` log line firing. This means the demotion did **not** go through `updateFeatureStatus`. Something else directly wrote `is_feature=0` to the row — most likely `insertFileDerivedPlan` (the watcher's file-scan upsert) which inserts/updates the row with a default `is_feature=0` value, overwriting the `1` that `createFeatureFromPlanIds` had just set.
>
> The timing (100ms after the successful persist at `is_feature:1`) is consistent with the file watcher re-processing the newly-created feature file and calling `insertFileDerivedPlan` which doesn't preserve the existing `is_feature` value.

---

## Bug 2: `change-epics-to-features` — Lost `is_feature` tag and disappeared from kanban

### Current DB state
| File | `is_feature` | `feature_id` | Column |
|------|-------------|-------------|--------|
| `change-epics-to-features-…908739dc.md` | **1** | *(empty)* | CODE REVIEWED |

> [!NOTE]
> The DB currently shows `is_feature=1` for this file. If you saw it disappear from the kanban when moving it to Code Reviewed, the log captures what happened during that window.

### What the log shows

**Line 660** (`12:56:16.695Z`): The persist snapshot lists 50 features all at `is_feature:1`, but **`dev-docs` has already flipped to `is_feature:0`** — and critically, `change-epics-to-features` **is not listed** in this persist snapshot at all.

Wait — actually re-checking: `change-epics-to-features` IS still listed at `is_feature:1` in line 660. But by line 661, the snapshot drops the `dev-docs` entry but keeps `change-epics-to-features`.

The disappearance you observed may have been a **transient UI issue** — the column move triggered a refresh, and the kanban webview may have briefly failed to render features that lacked a `feature_id`. All feature entries in the log show `feature_id:` (empty) across the board. If the UI filters for rows with `is_feature=1 AND feature_id IS NOT NULL`, an empty `feature_id` string would cause the card to vanish from the features view despite `is_feature=1`.

> [!IMPORTANT]
> The `feature_id` column is **empty for every single feature** in the diagnostic log. This is a systemic issue — the `feature_id` is never being populated, which likely causes downstream UI/filtering bugs.

---

## Root Cause Summary

### Primary issue: `insertFileDerivedPlan` clobbers `is_feature`

The watcher's `_handlePlanFile` → `insertFileDerivedPlan` code path performs an INSERT/UPDATE on feature files that **does not preserve the `is_feature=1` flag**. It either:
- Uses `INSERT OR REPLACE` which resets `is_feature` to the default `0`, or
- Uses an `UPDATE SET` that explicitly sets `is_feature=0` (or omits it, letting the default apply)

This is **not** candidate ❶/❷/❸/❺ from the investigation doc. It's a variant of **candidate ❹ (data loss via a write path that omits `is_feature`)**, but through the file watcher upsert rather than backup/restore.

### Secondary issue: `feature_id` never populated

Every persist snapshot shows `feature_id:` (empty string) for all 51 features. This means `createFeatureFromPlanIds` or whatever creates the DB row is not setting the `feature_id` field. This alone could cause features to disappear from UI views that filter on `feature_id`.

---

## Evidence Summary

| Line | Time | Event |
|------|------|-------|
| 181 | `10:23:52.572Z` | `online-docs…=is_feature:1` — last good persist |
| **182** | **`10:23:52.679Z`** | **`online-docs…=is_feature:0`** — clobber, same instance #3, 107ms later, no FEATURE-CLOBBER log |
| 573 | `12:54:55.655Z` | Self-heal restores all features to `is_feature:1` (all 50 features appear) |
| 655 | `12:56:16.593Z` | `dev-docs…=is_feature:1` appears (newly created feature) |
| **661** | **`12:56:16.730Z`** | **`dev-docs…=is_feature:0`** — clobber, same instance #3, 137ms later, no FEATURE-CLOBBER log |

### Probes that did NOT fire (meaning the clobber bypasses them)
- ❌ `FEATURE-CLOBBER` (explicit demotion guard)
- ❌ `createFeatureFromPlanIds DB-instance check`
- ❌ `reload` (no stale-snapshot reload)
- ❌ `sameInstance` check

---

## Recommended Fix

1. **Find `insertFileDerivedPlan`** — the watcher's upsert for feature files. Ensure it preserves existing `is_feature`/`feature_id` values when the row already exists. Either:
   - Use `INSERT … ON CONFLICT DO UPDATE SET … is_feature = COALESCE(excluded.is_feature, plans.is_feature)`, or
   - Skip the upsert entirely for files already in the DB with `is_feature=1`

2. **Populate `feature_id`** — `createFeatureFromPlanIds` (or `create-feature.js`) needs to actually set the `feature_id` column when creating a feature row.

3. **Add a probe on `insertFileDerivedPlan`** — the current probes completely miss this code path. Add a `FEATURE-CLOBBER` log if `insertFileDerivedPlan` is about to write `is_feature=0` for a row that currently has `is_feature=1`.
