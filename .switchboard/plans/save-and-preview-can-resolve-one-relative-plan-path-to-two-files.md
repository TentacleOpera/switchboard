# Save and Preview Can Resolve One Relative Plan Path to Two Files

## Goal

Make preview and save agree on which root a relative plan path belongs to, so the operator cannot read one file and write another.

### Problem analysis

`_resolveSaveTarget` honours a caller-supplied root. `_handleFetchKanbanPlanPreview(filePath, requestId)` takes **no** root at all — it loops `_getAllowedRoots()` and takes the first hit, and the call site at `:3912` passes only `filePath` and `requestId`.

With the same relative path present in two roots, the operator previews one file and saves the other. Nothing reports the divergence, because each half is individually behaving as written.

**Provenance.** Split out of `memo-fourteen-single-defects-that-belong-to-no-cluster.md` (2026-09-04 memo triage), which held it as one of fourteen unrelated
findings. That card was an explicit holding pen — *"not a unit of work"* — and this is the
individually addressable form. Line numbers in the original were from 2026-09-04 and had drifted;
those below were re-checked on 2026-09-15 unless marked otherwise.

## Metadata

**Complexity:** 4
**Tags:** bugfix, reliability

## User Review Required

No.

## Proposed Changes

### `_handleFetchKanbanPlanPreview` and `_resolveSaveTarget`
- **Logic:** thread the resolved root through the preview path so both resolve identically, and record which root answered.
- **Edge case:** an ambiguous path present in two roots must fail loudly or name the root it chose — first-hit-wins is the defect.

## Verification Plan

### Goal Invariants

1. For a relative path present in two allowed roots, preview and save resolve the same absolute file. *(Paired: the resolved root is reported, so 'which root answered' is answerable after the fact.)*
