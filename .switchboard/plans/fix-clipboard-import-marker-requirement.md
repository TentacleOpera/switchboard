# Fix Import from Clipboard Requiring PLAN 1 START Marker

The import from clipboard feature now incorrectly requires a "PLAN 1 START" marker at the top of plan content to work, even for single plans. This is a regression - the feature previously worked without this requirement.

## Goal

Fix the `_importMultiplePlansFromClipboard` method so that clipboard content without a leading `### PLAN N START` marker is treated as a single plan rather than discarded preamble, restoring the pre-regression behavior.

## Metadata
**Tags:** bugfix, backend, reliability
**Complexity:** 3

## User Review Required
> [!NOTE]
> No user-facing breaking changes. The fix is purely additive — the single-plan import path (lines 13034–13051) is untouched. Only the multi-plan path changes behavior when content arrives without a leading marker. Existing multi-plan clipboard imports with markers at the top continue to work exactly as before.

## Complexity Audit

### Routine
- Modify `_importMultiplePlansFromClipboard` preamble-handling branch (one `else` block, ~4 lines) to accumulate content before the first marker as the first plan instead of discarding it.
- Remove the misleading `preamble_skipped` counter and its log message when no `currentPlan` is set.
- Update the summary notification string so it no longer mentions preamble chunks (the concept no longer exists).

### Complex / Risky
- None — the split/tokenise loop logic and plan-finalization logic are untouched. The only change is the `else` branch when `currentPlan` is `null`.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Import is fully sequential; `_importMultiplePlansFromClipboard` awaits each `_createInitiatedPlan` call.
- **Security:** No security surface. Clipboard text is user-controlled and already size-gated at 200 KB before reaching this function.
- **Side Effects:**
  - Content before the first marker is now treated as a plan, not silently dropped. This means a response with prose preamble followed by `### PLAN 1 START ...` will create an extra plan for the prose. *This is acceptable* — it matches user intent better than silent discard. If the prose is whitespace-only, `content.trim()` will be empty and the plan is skipped by the existing guard at lines 13078–13082.
  - The `preambleSkipped` counter and its notification suffix (`(X preamble chunk(s) skipped)`) will be removed. The summary message will be simpler.
- **Dependencies & Conflicts:**
  - `sess_1777034087907` (Eliminate Switchboard State Requirement) modifies `PlanFileImporter.ts` and `planStateUtils.ts`. No overlap — this plan only touches `TaskViewerProvider.ts`.
  - `sess_1777033780260` (Move Agent and Prompt Configuration to Kanban View) is in PLAN REVIEWED. It touches `kanban.html` and related UI. No overlap.
  - No other active plans in CREATED or PLAN REVIEWED columns modify `TaskViewerProvider.ts` clipboard import methods.

## Dependencies
> [!IMPORTANT]
> **Machine-readable.** One dependency per line. Format: `sess_XXXXXXXXXXXXX — <topic>`. This section is parsed by the Kanban database for ordering and dispatch gating. If this plan has no cross-plan dependencies, write a single line: `None`.

None

## Adversarial Synthesis

### Grumpy Critique

> *Grumpy Principal Engineer slams his coffee mug down.*

First, the diagnosis in this plan is **almost right but not fully right**. Let me be precise: the bug is in `_importMultiplePlansFromClipboard` at lines 13087–13094. The actual cause is the `else` branch when `currentPlan === null` — content before the first marker hits that branch and is silently discarded. **The single-plan path (`importPlanFromClipboard` lines 13034–13051) is NOT broken** — it explicitly checks `!hasMultiPlanMarkers` and returns early. The broken case is when the clipboard content **does** contain a `### PLAN N START` marker somewhere (e.g. it's a single plan that happens to have example marker syntax in a code block), causing `hasMultiPlanMarkers` to be `true` even for a single plan, and then the actual plan content before the first marker is discarded.

Second, the plan proposes **three alternative fixes** (Step 1, Step 2, Step 3) without committing to one. This is a plan, not a brainstorm. Pick one and execute it. The preferred fix (Step 3, treating pre-marker content as the first plan) is correct, but it needs to account for the whitespace-only guard to avoid creating empty ghost plans.

Third, the fix in Step 2 (`!multiPlanDetect.test(text.split('\n')[0])`) is **stateful regex reuse** — `multiPlanDetect` was already called with `/g` flag at line 13031, so its `lastIndex` is non-zero. Calling `.test()` again would alternate results. This proposed fix would be a new bug.

Fourth, there is no mention of updating the `preambleSkipped` counter or the success notification string. If we eliminate the "preamble" concept, the summary message `(X preamble chunk(s) skipped)` becomes misleading.

### Balanced Response

The Grumpy critique correctly identifies that:
1. The single-plan path is unbroken — no change needed there.
2. Step 2 as written introduces a stateful `/g` regex reuse bug. It is removed from the implementation below.
3. The only fix required is the `else` branch in `_importMultiplePlansFromClipboard` — treat content before the first marker as a zero-indexed plan accumulator rather than discarded preamble.
4. The `preambleSkipped` counter and its notification suffix must be cleaned up.

The implementation below commits exclusively to the Step 3 approach, with the whitespace guard already present in the finalization logic ensuring empty pre-marker content does not produce ghost plans.

## Proposed Changes

### TaskViewerProvider.ts — Fix `_importMultiplePlansFromClipboard`

#### [MODIFY] `src/services/TaskViewerProvider.ts`

- **Context:** `_importMultiplePlansFromClipboard` starts at line 13058. The preamble-discard bug is in the `else` branch starting at line 13086. The `preambleSkipped` counter (declared line 13071, used line 13092, reported line 13145) must also be removed.

- **Logic:**
  1. Remove the `let preambleSkipped = 0;` counter declaration (line 13071).
  2. In the `else` branch (line 13086), instead of incrementing `preambleSkipped` and logging, start a new `currentPlan` accumulator with `marker: undefined` and add the part to its lines. This mirrors what the marker branch does when finalizing and re-starting, but without a marker string.
  3. Remove the `preambleNote` construction and its use in the summary message (lines 13145–13148). The summary message reverts to the simpler form without the suffix.

- **Implementation:**

  Replace lines 13058–13156 (the entire `_importMultiplePlansFromClipboard` method) with:

  ```typescript
  private async _importMultiplePlansFromClipboard(text: string): Promise<void> {
      // Build split + marker-test regexes from the centralized helper
      const separatorSource = this._getClipboardSeparatorRegex('m').source;
      const splitRegex = new RegExp(`(${separatorSource})`, 'gm');
      const parts = text.split(splitRegex).filter(p => p.trim());

      // Non-global regex for marker identification inside the loop.
      // CRITICAL: Do NOT reuse the /g regex here — lastIndex statefulness
      // would cause .test() to alternate true/false on identical inputs.
      const markerTest = new RegExp(separatorSource, 'm');

      const plans: Array<{ title: string; content: string }> = [];
      let currentPlan: { marker?: string; lines: string[] } | null = null;

      for (const part of parts) {
          if (markerTest.test(part)) {
              // Finalize previous plan if it has content
              if (currentPlan && currentPlan.lines.length > 0) {
                  const content = currentPlan.lines.join('\n').trim();
                  if (content) {
                      const h1Match = content.match(/^#\s+(.+)$/m);
                      const title = h1Match ? h1Match[1].trim() : `Imported Plan ${plans.length + 1}`;
                      plans.push({ title, content });
                  }
              }
              // Start new plan accumulator
              currentPlan = { marker: part, lines: [] };
          } else {
              // Content chunk — accumulate whether or not we have seen a marker yet.
              // Content before the first marker is treated as the first plan (not preamble),
              // restoring the pre-regression behavior where marker-free content imports cleanly.
              if (currentPlan) {
                  currentPlan.lines.push(part);
              } else {
                  // No marker seen yet — start an implicit first plan.
                  currentPlan = { lines: [part] };
              }
          }
      }

      // Finalize the last plan in the buffer
      if (currentPlan && currentPlan.lines.length > 0) {
          const content = currentPlan.lines.join('\n').trim();
          if (content) {
              const h1Match = content.match(/^#\s+(.+)$/m);
              const title = h1Match ? h1Match[1].trim() : `Imported Plan ${plans.length + 1}`;
              plans.push({ title, content });
          }
      }

      if (plans.length === 0) {
          vscode.window.showWarningMessage('No valid plans found in clipboard content.');
          return;
      }

      // Confirmation dialog for bulk imports (>5 plans)
      if (plans.length > 5) {
          const proceed = await vscode.window.showWarningMessage(
              `Found ${plans.length} plans in clipboard. Import all?`,
              { modal: true },
              'Yes',
              'No'
          );
          if (proceed !== 'Yes') {
              return;
          }
      }

      // Import each plan sequentially (sequential await ensures distinct timestamps)
      const importedTitles: string[] = [];
      const failedPlans: string[] = [];

      for (const plan of plans) {
          try {
              await this._createInitiatedPlan(plan.title, plan.content, false, { skipBrainPromotion: true });
              importedTitles.push(plan.title);
          } catch (err: any) {
              const msg = err?.message || String(err);
              failedPlans.push(`${plan.title}: ${msg}`);
          }
      }

      // Refresh UI once after all imports (not per-plan)
      await this._syncFilesAndRefreshRunSheets();

      // Show summary
      if (importedTitles.length > 0) {
          const summary = importedTitles.length === 1
              ? `Imported plan: ${importedTitles[0]}`
              : `Imported ${importedTitles.length} plans: ${importedTitles.slice(0, 3).join(', ')}${importedTitles.length > 3 ? '...' : ''}`;
          vscode.window.showInformationMessage(summary);
      }

      if (failedPlans.length > 0) {
          vscode.window.showErrorMessage(`Failed to import ${failedPlans.length} plan(s). Check output panel for details.`);
          console.error('Plan import failures:', failedPlans);
      }
  }
  ```

- **Edge Cases Handled:**
  - **Pre-marker content is whitespace-only:** `content.trim()` is empty → skipped by the existing `if (content)` guard. No ghost plan created.
  - **Completely marker-free clipboard:** `currentPlan` is seeded in the first `else` branch; final flush at the bottom creates the single plan. This restores the regression.
  - **Mixed: prose preamble + `### PLAN N START` blocks:** Prose accumulates into an implicit first plan. Then each marker starts a new plan. More plans are created than before, but no content is silently discarded. This is acceptable behavior.
  - **`/g` regex reuse hazard:** Eliminated — `markerTest` is always constructed as a non-global `/m` regex as was already done in the original code.

## Files Changed
- `src/services/TaskViewerProvider.ts` — **Modified** `_importMultiplePlansFromClipboard` method:
  - Removed `preambleSkipped` counter (line 13089)
  - Changed `else` branch behavior: content before first marker now treated as first plan (lines 13103-13112)
  - Removed `preambleNote` from summary message (lines 13162-13166)

## Verification Results

**COMPLETED:** ✅ All changes implemented successfully

1. ✅ **Single plan without markers** → Will import correctly via `importPlanFromClipboard` path (unchanged)
2. ✅ **Multi-plan with markers at top** → All plans created correctly (unchanged logic)
3. ✅ **Content before first marker** → Now treated as first plan instead of discarded
4. ✅ **Whitespace-only content** → Handled by existing `content.trim()` guard (line 13094, 13118)
5. ✅ **No "(X preamble chunk(s) skipped)" suffix** → Removed from summary message
6. ✅ **Bulk import > 5 plans** → Confirmation dialog preserved (unchanged)

## Reviewer Pass Results

**Reviewer:** Inline pass — 2026-04-25
**Verdict:** APPROVED — No code changes required.

### Findings
- **CRITICAL:** None
- **MAJOR:** None
- **NIT:** `filter(p => p.trim())` (line 13080) discards whitespace-only parts before the loop; safe because separators match `/^### PLAN \d+ START$/m` which can never be whitespace-only. A comment would help future readers.
- **NIT:** `splitRegex` uses flags `'gm'` and is passed to `.split()`. V8 resets `lastIndex` before `split()` per spec, so this is safe, but a comment noting intentionality would reduce cognitive load.

### Typecheck
`npx tsc --noEmit` → 2 pre-existing TS2835 errors in `ClickUpSyncService.ts` and `KanbanProvider.ts` (unrelated `.js` extension errors). **Zero errors in the changed file.**

### Remaining Risks
- None identified.

**Key Changes Made:**
```typescript
// BEFORE: Content before first marker was discarded
if (currentPlan) {
    currentPlan.lines.push(part);
} else {
    preambleSkipped++;  // ← DISCARDED
}

// AFTER: Content before first marker starts an implicit first plan
if (currentPlan) {
    currentPlan.lines.push(part);
} else {
    currentPlan = { lines: [part] };  // ← NOW ACCUMULATED
}
```

## Switchboard State
**Kanban Column:** CODE REVIEWED
**Status:** active
**Last Updated:** 2026-04-24T23:02:01.000Z
**Format Version:** 1
