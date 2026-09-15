# Head Names Are Not Shell-Escaped in the Generated curl Recipes

## Goal

Shell-escape interpolated values in the generated curl recipes, so an apostrophe in a head name does not break the command handed to an operator.

### Problem analysis

`_buildBatchDrivePrefix` (`KanbanProvider.ts:5836`) and `_buildDrivePrefix` (`:5900`) both build `originVal` with `JSON.stringify(head).slice(1, -1)` — JSON escaping only — and drop the result inside a single-quoted `-d` argument. An apostrophe in a head name terminates the quote and breaks both recipes.

The sibling exposure is `agentPromptBuilder.ts:895` and `:912`, which interpolate `targetKey` and `planFile` the same way. (The original memo named `teamWiring.ts`; that file has no curl fragments — the citation was wrong, the defect is not.)

**Provenance.** Split out of `memo-fourteen-single-defects-that-belong-to-no-cluster.md` (2026-09-04 memo triage), which held it as one of fourteen unrelated
findings. That card was an explicit holding pen — *"not a unit of work"* — and this is the
individually addressable form. Line numbers in the original were from 2026-09-04 and had drifted;
those below were re-checked on 2026-09-15 unless marked otherwise.

## Metadata

**Complexity:** 3
**Tags:** bugfix, cli

## User Review Required

No.

## Proposed Changes

### `KanbanProvider.ts:5836`, `:5900` and `agentPromptBuilder.ts:895`, `:912`
- **Logic:** escape for single-quoted shell context, not JSON. JSON escaping is the bug, not an approximation of the fix.
- **Edge case:** the same treatment applies to `targetKey` and `planFile`, which are equally operator-supplied.

## Verification Plan

### Goal Invariants

1. A head name containing an apostrophe produces a runnable recipe from both builders. *(Paired: an ordinary head name produces a byte-identical recipe to today, so escaping did not change the common case.)*
