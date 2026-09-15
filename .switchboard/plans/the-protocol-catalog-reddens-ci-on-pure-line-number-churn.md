# The Protocol Catalog Reddens CI on Pure Line-Number Churn

## Goal

Stop a commit that shifts only line numbers from reddening the first CI step and blocking everything behind it.

### Problem analysis

`catalog:check` is green at HEAD, but the checked-in `protocol-catalog.json` carries **2,065** `"line":` fields (re-counted 2026-09-15; it was 2,028 at the original triage, so the exposure is growing) plus a `totalPushSites` count.

So the next commit that shifts lines without regenerating the catalog reddens `catalog:check` — which is the **first** CI step — and blocks every gate behind it, for a reason unrelated to any protocol change. The failure is maximally expensive and carries no signal.

**Provenance.** Split out of `memo-fourteen-single-defects-that-belong-to-no-cluster.md` (2026-09-04 memo triage), which held it as one of fourteen unrelated
findings. That card was an explicit holding pen — *"not a unit of work"* — and this is the
individually addressable form. Line numbers in the original were from 2026-09-04 and had drifted;
those below were re-checked on 2026-09-15 unless marked otherwise.

## Metadata

**Complexity:** 3
**Tags:** devops, reliability

## User Review Required

No. Either remedy below is acceptable; the plan does not need the choice made in advance.

## Proposed Changes

### Option 1 — regenerate on commit
- A pre-commit hook regenerates the catalog so line drift never reaches CI.
- **Edge case:** the hook must be reproducible, or it trades a red gate for a noisy diff on every commit.

### Option 2 — a line-number-free catalog
- Drop `"line"` from the checked-in artifact and key on a stable identifier.
- **Edge case:** confirm nothing consumes `"line"` for navigation before removing it.

## Verification Plan

### Goal Invariants

1. A commit that shifts only line numbers leaves `catalog:check` green — either the catalog carries no `"line":` fields, or regeneration happens before the gate runs.
