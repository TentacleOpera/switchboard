# Fix Stage Complete Marker Parser to Handle Multiple Accumulated Markers

## Goal

Fix the activity-light OFF-switch so a plan file that has accumulated multiple `**Stage Complete:**` markers (one per stage it passed through) correctly clears the card's working state. Today only the first marker is parsed; if it doesn't match the card's current column, the stale-marker guard blocks the clear and the light stays on forever.

### The problem (root-cause analysis)

**Symptom:** The plan file `feature_plan_20260707_tickets-tab-markdown-editor.md` has two markers on consecutive lines (143–144):

```
**Stage Complete:** PLAN REVIEWED
**Stage Complete:** PLAN CODED
```

The card's activity light never turned off.

**Root cause:** `src/services/planMetadataUtils.ts:129-136` uses `content.match(stageRegex)`, which returns only the **first** match. The regex is correct for a single marker, but `String.match` with a non-global regex stops at the first hit. So when a plan legitimately passes through multiple stages (REVIEWED → CODED), only the oldest marker (`PLAN REVIEWED`) is captured — the `PLAN CODED` marker on the very next line is invisible to the parser.

**Why the stale-marker guard then blocks the clear:** `GlobalPlanWatcherService.ts:844-862` compares the single captured `stageComplete` value against the card's current `kanbanColumn`. If the card was dispatched for `PLAN CODED` but the parser only sees `PLAN REVIEWED`, the columns don't match → the guard logs "stale marker, not clearing" → `dispatched_at` is never nulled → the light stays on.

**Why the "working" example worked:** `feature_plan_20260707145417_phone-a-friend-not-optional.md` also has two markers (lines 78, 80), but the first one (`INTERN CODED`) happened to match the card's current column at the time the watcher processed the mtime change — so the clear succeeded. The bug is latent in that file too; it would resurface the moment the card is re-dispatched to a stage whose name differs from the first marker.

**The bug is not about markers being on the "same line" vs. separate lines** — it's about the parser only ever seeing the first marker regardless of layout. Consecutive lines, blank-line-separated lines, and (hypothetically) same-line markers all produce the same failure: only the first is captured.

## Metadata

**Complexity:** 2

**Tags:** bugfix, backend

## Fix

### 1. Parser: capture ALL `Stage Complete` markers (`src/services/planMetadataUtils.ts`)

Change `stageComplete: string | undefined` to `stageComplete: string[] | undefined` in the `PlanMetadata` interface (line 63). Replace the single-match logic (lines 128-136) with a global match that collects every marker's column value:

```ts
let stageComplete: string[] | undefined;
const stageRegex = new RegExp(
    `^(?:>\\s+)?\\*\\*${STAGE_COMPLETE_LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\*\\*\\s*(.*)$`,
    'gim'   // add 'g' flag
);
const stageMatches = [...content.matchAll(stageRegex)];
if (stageMatches.length > 0) {
    stageComplete = stageMatches.map(m => m[1].trim());
}
```

`undefined` still means "no marker present" (watcher does nothing). An empty array is impossible (length > 0 guard). A bare `**Stage Complete:**` with no column yields `['']` in the array — same semantics as the old empty-string case.

### 2. Watcher: clear if ANY marker matches the current column (`src/services/GlobalPlanWatcherService.ts:844-862`)

Replace the single-value comparison with an array-aware check:

```ts
if (metadata.stageComplete !== undefined && metadata.stageComplete.length > 0) {
    const currentCol = updatedRecord.kanbanColumn || '';
    const hasBare = metadata.stageComplete.some(v => v.trim() === '');
    const hasMatch = metadata.stageComplete.some(v => v.trim() === currentCol);
    if (hasBare || hasMatch) {
        // clear working state (existing try/catch + log)
    } else {
        // stale-marker log: list all echoed values vs current
    }
}
```

This preserves the stale-marker guard's intent (an old marker from a *different* stage must not clear a re-dispatched light) while fixing the accumulation case: if the current stage's marker is present anywhere in the file, the light clears.

### 3. Update the doc comments

- `planMetadataUtils.ts:57-63` — update the `stageComplete` JSDoc to say it's now `string[]` (all markers, oldest-first) and that the watcher clears if any entry matches the current column or any entry is bare.
- `GlobalPlanWatcherService.ts:836-843` — update the comment to reflect "any marker matches" semantics.

## Edge cases

- **Single marker (the common case):** array has one element; behavior identical to today.
- **Bare marker (`**Stage Complete:**` with no column):** `['']` → `hasBare` true → clears unguarded. Same as today.
- **No marker:** `undefined` → watcher skips. Same as today.
- **Re-dispatched card with only an old stale marker:** e.g. markers `['PLAN REVIEWED']`, current column `PLAN CODED` → no bare, no match → stale, don't clear. Correct — the guard still protects against this.
- **Markers on the same physical line** (e.g. `**Stage Complete:** A **Stage Complete:** B`): the regex `(.*)$` would capture `A **Stage Complete:** B` as the value of the first match, and there would be no second match. This is a degenerate case that doesn't occur in practice (agents append one marker per line). Not worth handling — if it ever appears, the value just won't match a column and falls through to the stale path, which is safe.

## Verification

1. `npm run compile` — typecheck passes (the interface change from `string` to `string[]` is the only type surface; the watcher is the sole consumer).
2. Manual test: take the broken plan file (`feature_plan_20260707_tickets-tab-markdown-editor.md`), confirm its card's `dispatched_at` is non-NULL in `kanban.db`, trigger a plan-file re-parse (touch the file or restart the watcher), confirm `dispatched_at` becomes NULL and the light turns off.
3. Grep for other consumers of `metadata.stageComplete` to confirm none exist outside the watcher: `grep -rn 'stageComplete' src/` — only `planMetadataUtils.ts` (definition) and `GlobalPlanWatcherService.ts` (consumer) should appear.

## Files touched

- `src/services/planMetadataUtils.ts` — interface field type + parser logic + JSDoc
- `src/services/GlobalPlanWatcherService.ts` — watcher clear-condition + comment
