# `_ensureRelativePlanFile` Fails Open to an Absolute Path

## Goal

Stop `_ensureRelativePlanFile` returning an absolute path when the workspace prefix does not match, so a miss is a failure rather than a silent widening.

### Problem analysis

`KanbanDatabase._ensureRelativePlanFile` warns and returns the path **unchanged** on a workspace-prefix miss (`:15080`, `console.warn('… _workspaceRoot not set, returning path unchanged')`). The docblock at `:15042` describes the same behaviour.

So a path that fails normalisation is used as-is, absolute, by every caller that assumed a workspace-relative value.

**The other half of the original finding is already fixed.** The database-instance half — `forWorkspace` caching on a non-realpath'd string — now applies `fs.realpathSync` (`:2012`, `:2034`), consistent with *Enforce one database instance per path and fix the is_feature clobber* having completed. Only the `_ensureRelativePlanFile` half, explicitly unowned in the original, remains.

**Provenance.** Split out of `memo-fourteen-single-defects-that-belong-to-no-cluster.md` (2026-09-04 memo triage), which held it as one of fourteen unrelated
findings. That card was an explicit holding pen — *"not a unit of work"* — and this is the
individually addressable form. Line numbers in the original were from 2026-09-04 and had drifted;
those below were re-checked on 2026-09-15 unless marked otherwise.

## Metadata

**Complexity:** 3
**Tags:** bugfix, security

## User Review Required

No.

## Proposed Changes

### `src/services/KanbanDatabase.ts:15080`
- **Logic:** on a prefix miss, fail or resolve — never return the absolute path as though it were relative.
- **Edge case:** callers currently tolerating the fail-open must be checked; making it strict will surface paths that have been quietly wrong.

## Verification Plan

### Goal Invariants

1. `_ensureRelativePlanFile` does not return an absolute path on a workspace-prefix miss. *(Paired: a genuinely relative path is still returned unchanged, so normalisation is unaffected.)*
