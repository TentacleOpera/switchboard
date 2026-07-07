# Fix Stage Complete Marker Parser to Handle Multiple Accumulated Markers

## Goal

Fix the activity-light OFF-switch so a plan file that has accumulated multiple `**Stage Complete:**` markers (one per stage it passed through) correctly clears the card's working state. Today only the first marker is parsed; if it doesn't match the card's current column, the stale-marker guard blocks the clear and the light stays on forever.

**Framing note (added in review):** the parser is not "wrong" — it correctly implements the single-marker contract in `agentPromptBuilder.ts:516-518` ("append a single line... one marker per file"). The agents are accumulating multiple markers in practice, violating that contract. This fix makes the watcher **tolerate accumulated markers** rather than enforcing the single-marker contract. That is a deliberate, valid choice (the board cannot punish agent misbehavior without losing the OFF-switch signal); it should be named honestly.

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

## User Review Required

Yes — confirm the framing decision (tolerate accumulated markers vs. enforce single-marker contract by stripping duplicates on import). The plan proceeds on the tolerance approach; a reviewer who prefers enforcement should redirect before coding. No product-scope change; no migration concern (parser is in-memory, no persisted shape change).

## Complexity Audit

### Routine
- Single-file parser change (`planMetadataUtils.ts`) — swap `String.match` for `String.matchAll` with a `g` flag, widen one interface field from `string` to `string[]`.
- Single-file watcher change (`GlobalPlanWatcherService.ts`) — replace a single-value equality check with an `Array.some` check. Same try/catch boundary, same log channel.
- Doc-comment updates (two files).
- No DB schema change, no migration, no new dependency. The `dispatched_at` column and `clearWorkingState` API are untouched.

### Complex / Risky
- None for the runtime fix. The only moderate risk is the **type-change ripple**: `stageComplete?: string` → `string[]` is a breaking change to any literal constructor of `PlanMetadata`. A grep of `src/` and `src/test/` confirmed only two runtime consumers (the parser definition and the watcher) and **zero test-literal references** (`grep -rn 'stageComplete\s*:' **/*.test.ts` → no matches), so the type surface is contained at review time. Re-run that grep before merge as a guard.

## Edge-Case & Dependency Audit

**Race Conditions:** None introduced. The watcher's mtime gate self-advances (`updatedAt := fileMtime`) so the marker is observed on exactly one handler pass regardless of how many markers are present. Multiple markers do not change the single-pass semantics; the array is built and consumed atomically within the same handler invocation.

**Security:** None. Marker values originate from plan `.md` files already trusted by the parser. No new input source, no eval, no injection surface. Values are compared as strings against `kanbanColumn`.

**Side Effects:** The stale-marker log message format changes (it now lists all echoed values, not one). Any downstream log parser keyed on the exact old string `"Stage Complete marker column 'X' != current 'Y'"` will break — but no such parser exists in-repo (grep confirmed). The output channel is human-read.

**Dependencies & Conflicts:**
- `STAGE_COMPLETE_LABEL` (from `agentPromptBuilder.ts:505`) is the shared constant; the fix reuses it, no drift.
- `extractEmbeddedMetadata` (`planMetadataUtils.ts:28-32`) uses the SAME non-global pattern but for single-value fields (ClickUp/Linear IDs). **This fix is scoped to `stageComplete` only — do NOT apply the `matchAll` pattern to `extractEmbeddedMetadata`.** Those fields are single-value by contract; widening them would break ClickUp/Linear ID parsing. A future maintainer reading this plan should respect that boundary.
- The regex object built with `new RegExp(..., 'gim')` is single-use (consumed by `matchAll`, which resets `lastIndex`). Do not hoist it to module scope or reuse it with `.exec()` in a loop — the `g`-flag `lastIndex` statefulness trap would bite.

## Dependencies

- None. No `sess_` dependencies — this is a standalone parser/watcher fix with no prerequisite plans.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the `string`→`string[]` interface change is a breaking change to literal constructors — mitigated by a grep guard (confirmed zero test-literal references at review time); (2) reframing the fix as "tolerate accumulation" rather than "fix broken parser" — the parser was correct for its contract, the agents violated it, and tolerance is a deliberate product decision the reviewer should confirm. Mitigations: run the `stageComplete:` literal grep before merge; document the `extractEmbeddedMetadata` boundary so the matchAll pattern is not propagated; note the regex single-use constraint in code comments.

## Proposed Changes

### `src/services/planMetadataUtils.ts`
**Context:** The `PlanMetadata` interface (line 48-64) declares `stageComplete?: string` and `parsePlanMetadata` (line 84-147) populates it with a single match.

**Logic:** Widen the field to `string[]` and capture every marker via `matchAll`. `undefined` still means "no marker present" (watcher does nothing). An empty array is impossible (length > 0 guard). A bare `**Stage Complete:**` with no column yields `['']` — same semantics as the old empty-string case, now in array form.

**Implementation:** Change `stageComplete: string | undefined` to `stageComplete: string[] | undefined` in the `PlanMetadata` interface (line 63). Replace the single-match logic (lines 128-136) with a global match that collects every marker's column value:

```ts
let stageComplete: string[] | undefined;
const stageRegex = new RegExp(
    `^(?:>\\s+)?\\*\\*${STAGE_COMPLETE_LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\*\\*\\s*(.*)$`,
    'gim'   // add 'g' flag — single-use regex; do not hoist or reuse with .exec()
);
const stageMatches = [...content.matchAll(stageRegex)];
if (stageMatches.length > 0) {
    stageComplete = stageMatches.map(m => m[1].trim());
}
```

**Edge Cases:** See "Edge cases" section below. The `extractEmbeddedMetadata` sibling (lines 28-32) is intentionally NOT changed — it serves single-value fields.

### `src/services/GlobalPlanWatcherService.ts`
**Context:** Lines 836-863 handle the activity-light OFF-switch. The current single-value compare (lines 844-862) blocks the clear when the lone captured marker doesn't match the current column.

**Logic:** Clear if ANY marker matches the current column OR any marker is bare. This preserves the stale-marker guard's intent (an old marker from a *different* stage must not clear a re-dispatched light) while fixing the accumulation case: if the current stage's marker is present anywhere in the file, the light clears.

**Implementation:** Replace the single-value comparison (lines 844-862) with an array-aware check:

```ts
if (metadata.stageComplete !== undefined && metadata.stageComplete.length > 0) {
    const currentCol = updatedRecord.kanbanColumn || '';
    const hasBare = metadata.stageComplete.some(v => v.trim() === '');
    const hasMatch = metadata.stageComplete.some(v => v.trim() === currentCol);
    if (hasBare || hasMatch) {
        try {
            await db.clearWorkingState(relativePath, workspaceId);
            this._outputChannel?.appendLine(
                `[GlobalPlanWatcher] Stage Complete marker cleared working state for: ${relativePath}`
            );
        } catch (clearErr) {
            this._outputChannel?.appendLine(
                `[GlobalPlanWatcher] clearWorkingState failed for ${relativePath}: ${clearErr}`
            );
        }
    } else {
        this._outputChannel?.appendLine(
            `[GlobalPlanWatcher] Stage Complete markers [${metadata.stageComplete.join(', ')}] none match current '${currentCol}' — stale markers, not clearing: ${relativePath}`
        );
    }
}
```

**Edge Cases:** The stale-marker log now joins all echoed values with `, ` for the human-readable output channel. No in-repo parser depends on the old single-value log string.

### Doc-comment updates
- `planMetadataUtils.ts:57-63` — update the `stageComplete` JSDoc to say it's now `string[]` (all markers, oldest-first) and that the watcher clears if any entry matches the current column or any entry is bare.
- `GlobalPlanWatcherService.ts:836-843` — update the comment to reflect "any marker matches" semantics.

## Edge cases

- **Single marker (the common case):** array has one element; behavior identical to today.
- **Bare marker (`**Stage Complete:**` with no column):** `['']` → `hasBare` true → clears unguarded. Same as today.
- **No marker:** `undefined` → watcher skips. Same as today.
- **Re-dispatched card with only an old stale marker:** e.g. markers `['PLAN REVIEWED']`, current column `PLAN CODED` → no bare, no match → stale, don't clear. Correct — the guard still protects against this.
- **Duplicate marker for the same stage (agent re-runs):** `['PLAN CODED', 'PLAN CODED']` → `hasMatch` true → clears. Correct.
- **Markers on the same physical line** (e.g. `**Stage Complete:** A **Stage Complete:** B`): the regex `(.*)$` would capture `A **Stage Complete:** B` as the value of the first match, and there would be no second match. This is a degenerate case that doesn't occur in practice (agents append one marker per line). Not worth handling — if it ever appears, the value just won't match a column and falls through to the stale path, which is safe.

## Verification Plan

### Automated Tests
*(Skipped per session directive — do not run automated tests.)*

### Manual verification (no compile, no test run)
1. **Type-consumer grep guard:** `grep -rn 'stageComplete' src/` — confirm only `planMetadataUtils.ts` (definition) and `GlobalPlanWatcherService.ts` (consumer) appear. Additionally `grep -rn 'stageComplete\s*:' src/test/ **/*.test.ts` — confirm zero literal constructors (the `string`→`string[]` widening must not break a test fixture). At review time both greps returned the expected results; re-run before merge.
2. **Typecheck (skipped per session directive):** `npm run compile` would confirm the interface change typechecks, but compilation is skipped this session. The single type surface is the watcher's `.trim()` / equality calls, which become `.some(v => v.trim() ...)` — type-safe by construction.
3. **Manual runtime test:** take the broken plan file (`feature_plan_20260707_tickets-tab-markdown-editor.md`), confirm its card's `dispatched_at` is non-NULL in `kanban.db`, trigger a plan-file re-parse (touch the file or restart the watcher), confirm `dispatched_at` becomes NULL and the light turns off.

## Files touched

- `src/services/planMetadataUtils.ts` — interface field type + parser logic + JSDoc
- `src/services/GlobalPlanWatcherService.ts` — watcher clear-condition + comment

## Recommendation

**Send to Intern** — complexity 2/10: two-file change, no new pattern, no migration, no DB schema touch. The type widening is contained (zero test-literal consumers confirmed). The only thing the intern must not do is propagate the `matchAll` pattern to `extractEmbeddedMetadata` — that boundary is documented above.

**Stage Complete:** PLAN REVIEWED
**Stage Complete:** PLAN CODED
