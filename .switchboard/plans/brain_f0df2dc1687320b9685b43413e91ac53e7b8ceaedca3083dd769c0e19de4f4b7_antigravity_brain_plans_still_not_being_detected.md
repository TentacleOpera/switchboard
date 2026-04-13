# Antigravity brain plans still not being detected

## Goal
- Clarify expected outcome and scope.
Fix the Antigravity brain-plan detection heuristic so `implementation_plan.md(.resolved)` files that use `## Problem Description` and `## Proposed Solutions` are mirrored into `.switchboard/plans` and show up on the Kanban board instead of being filtered out as non-plan markdown.

## Metadata
**Tags:** backend, bugfix
**Complexity:** 6

## User Review Required
> [!NOTE]
> - Scope stays limited to the plan-file detection heuristic in `src/services/TaskViewerProvider.ts` and its regression coverage.
> - Do **not** bundle clipboard auto-promotion behavior, terminal reconnect work, ClickUp automation refactors, or completed-status repairs into this bugfix.
> - **Clarification:** The repository proves the Antigravity watcher root is `~/.gemini/antigravity/brain` (`src/services/TaskViewerProvider.ts:10703-10705`), but the exact external file `/Users/patrickvuleta/.gemini/antigravity/brain/aa859880-b1b7-4d9a-a3af-ef1db7e3882d/implementation_plan.md.resolved` is only proven by the investigation notes below, not by a repo-local file inspection.
> - **Recommended Agent:** Send to Coder

## Complexity Audit
### Routine
- Expand `_isLikelyPlanFile()` in `src/services/TaskViewerProvider.ts:7003-7025` to recognize `## Problem Description` and `## Proposed Solutions`.
- **Clarification:** Implement the filename bypass via `path.basename(this._getBaseBrainPath(filePath)).toLowerCase() === 'implementation_plan.md'` so `.resolved` sidecars inherit the same behavior as their base markdown file.
- Update the existing regression coverage in `src/test/brain-new-plan-visibility-regression.test.js` so the new headers and the canonical `implementation_plan.md` fast-path are locked in.
- Re-run `npm run compile-tests`; run `npm test` if the VS Code test environment is available. `npm run lint` currently fails at baseline because ESLint 9 cannot find an `eslint.config.*` file, so that tooling issue is out of scope for this plan.

### Complex / Risky
- `_isLikelyPlanFile()` is a shared gate used by both `_syncConfiguredPlanFolder()` (`src/services/TaskViewerProvider.ts:5323`) and `_mirrorBrainPlan()` (`src/services/TaskViewerProvider.ts:7505`), so an overly broad change can accidentally ingest unrelated markdown from two separate pipelines.
- The reported failure involves a `.resolved` sidecar, so the filename fast-path must normalize through `_getBaseBrainPath()` (`src/services/TaskViewerProvider.ts:6544-6545`) instead of checking `path.basename(filePath)` directly.
- Active work also touches `src/services/TaskViewerProvider.ts`, so the runtime fix is small but still exposed to same-file merge churn.

## Edge-Case & Dependency Audit
- **Race Conditions:** The Antigravity watcher can emit multiple create/change events for the same file, but this fix remains read-only and deterministic inside `_isLikelyPlanFile()`. It must not alter the existing dedupe, auto-claim, or runsheet registration timing in `_mirrorBrainPlan()`.
- **Security:** Keep the existing H1 gate, path-containment checks, and file-size checks exactly as-is. The fix should only broaden content recognition and the canonical `implementation_plan.md` basename; it must not bypass `_isBrainMirrorCandidate()` or any write-path guard.
- **Side Effects:** **Clarification:** Because `_isLikelyPlanFile()` is shared, the same heuristic improvement also applies to configured external plan-folder ingestion. That side effect is acceptable because it keeps plan classification consistent across both ingestion paths, but it is not a separate feature project.
- **Dependencies & Conflicts:** `switchboard-get_kanban_state` confirms no active **New** cards and shows `Fix Terminal Disconnect on Minimize`, `Fix: Disable Auto-Promotion of Clipboard Imports to Antigravity Brain`, `Antigravity brain plans still not being detected`, and `Restore Completed Column Visibility and Preserve Completed Status` as Planned. The user-provided active context also says to treat `Simplify ClickUp Automation` as active even though the live board currently reports it in Lead Coder, so keep that discrepancy documented. `Fix: Disable Auto-Promotion of Clipboard Imports to Antigravity Brain` shares the Antigravity/`TaskViewerProvider.ts` flow and should be regression-tested alongside this fix. `Restore Completed Column Visibility and Preserve Completed Status` and the user-flagged `Simplify ClickUp Automation` both touch `src/services/TaskViewerProvider.ts`, so expect merge-risk but no logical dependency. `Fix Terminal Disconnect on Minimize` targets `src/extension.ts` only and does not conflict.

## Adversarial Synthesis
### Grumpy Critique
> Oh, fantastic — a "tiny regex tweak" in a shared ingestion gate. That's exactly how you accidentally turn random markdown into Kanban cards and then spend Friday night explaining why the board is haunted. If you just stuff `Problem Description` and `Proposed Solutions` into the header list without thinking about `implementation_plan.md.resolved`, you will still miss the actual sidecar the user reported. If you add the filename bypass without keeping the H1 guard, any stray `implementation_plan.md` becomes gospel. And if you forget that `_isLikelyPlanFile()` is used by both `_mirrorBrainPlan()` and `_syncConfiguredPlanFolder()`, you'll ship an Antigravity fix that quietly changes managed-folder ingestion with no regression lock. Small diff, sharp blast radius.

### Balanced Response
> Fair. The implementation stays intentionally narrow: keep the existing H1 requirement, add only the two missing headings named by the investigation, and special-case only the canonical basename `implementation_plan.md` after normalizing sidecars through `_getBaseBrainPath(filePath)`. That fixes the reported Antigravity failure without relaxing the surrounding path, size, or auto-claim safeguards. Because the helper is shared, the plan also updates `src/test/brain-new-plan-visibility-regression.test.js` so both the new headings and the filename fast-path are explicitly locked in. Cross-plan notes call out the shared `TaskViewerProvider.ts` merge surface up front so this lands as a deliberate bugfix, not a surprise behavioral drift.

## Preserved Investigation Notes
### Root Cause Analysis: Why the plan was missing
The plan file `/Users/patrickvuleta/.gemini/antigravity/brain/aa859880-b1b7-4d9a-a3af-ef1db7e3882d/implementation_plan.md.resolved` was being ignored by the mirroring service due to a strict heuristic check.

- **Strict Heuristic:** In `src/services/TaskViewerProvider.ts`, the method `_isLikelyPlanFile` (currently at line 7003) acts as a gatekeeper. It reads the first few lines of a file and uses a regular expression to verify it contains standard plan headers.
- **Header Mismatch:** Your plan uses `## Problem Description` and `## Proposed Solutions`. These specific headers were missing from the allowed list in the regex, causing the file to be classified as "not a plan" and excluded from the Kanban board.
- **Filenaming:** While the file is named `implementation_plan.md`, the current logic doesn't trust the filename alone; it insists on the content check, which was failing.

### What was changed (and now reverted)
I attempted to apply a two-part fix:

- **Updated Regex:** Added `Problem Description` and `Proposed Solutions` to the list of recognized headers.
- **Filename Trust:** Added a short-circuit rule so that any file starting with `implementation_plan.md` is automatically treated as a plan, bypassing the heuristic content check entirely.

### Original Proposed Plan (Seeking Approval)
- Modify `TaskViewerProvider.ts`: Update `_isLikelyPlanFile` to include the missing headers and add an explicit bypass for `implementation_plan.md` files.
- Verification: Trigger a rescan of the Antigravity brain directory to ensure the plan `aa859880...` is immediately picked up and registered in the CREATED column.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** The fix belongs in the shared plan-classification helper, not in downstream import or DB layers. `src/services/PlanFileImporter.ts` already imports mirrored files from `.switchboard/plans` after they exist; the bug happens earlier when `_isLikelyPlanFile()` rejects the source file, so no importer or database code should change here.

### Plan-file heuristic update
#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** `_isLikelyPlanFile()` is the single shared classifier for both configured external-folder ingestion and Antigravity brain mirroring. The failing Antigravity file is a `.resolved` sidecar, and the current section regex does not recognize `## Problem Description` or `## Proposed Solutions`.
- **Logic:**
  1. Keep the existing byte-limit read, H1 requirement, and metadata fallback intact.
  2. **Clarification:** Normalize the basename with `this._getBaseBrainPath(filePath)` before checking for `implementation_plan.md` so `implementation_plan.md.resolved` and `implementation_plan.md.resolved.N` behave the same as the base file.
  3. Return `true` immediately for the canonical `implementation_plan.md` basename after the H1 gate; this preserves the filename-trust behavior described in the original proposal without bypassing the H1 safety check.
  4. Expand the allowed `##` section list to include exactly `Problem Description` and `Proposed Solutions`.
  5. Leave all watcher timing, dedupe, and registration code untouched.
- **Implementation:**
  ```typescript
  private async _isLikelyPlanFile(filePath: string): Promise<boolean> {
      const MAX_HEADER_BYTES = 16 * 1024;
      const MAX_HEADER_LINES = 80;
      let handle: fs.promises.FileHandle | undefined;
      try {
          handle = await fs.promises.open(filePath, 'r');
          const buffer = Buffer.alloc(MAX_HEADER_BYTES);
          const { bytesRead } = await handle.read(buffer, 0, MAX_HEADER_BYTES, 0);
          if (bytesRead <= 0) return false;
          const snippet = buffer.toString('utf8', 0, bytesRead);
          const firstLines = snippet.split(/\r?\n/).slice(0, MAX_HEADER_LINES).join('\n');
          const hasH1 = /^#\s+.+/m.test(firstLines);
          if (!hasH1) return false;
          const baseFilename = path.basename(this._getBaseBrainPath(filePath)).toLowerCase();
          if (baseFilename === 'implementation_plan.md') {
              return true;
          }
          const planSections = firstLines.match(
              /^##\s+(Goal|Goals|Metadata|User Review Required|User Requirements Captured|Complexity Audit|Problem Description|Proposed Solutions|Proposed Changes(?:\s*\(.*\))?|Verification Plan|Task Split|Edge-Case & Dependency Audit|Adversarial Synthesis|Open Questions|Implementation Review|Post-Implementation Review|Recommendation|Agent Recommendation|The Targeted Rule Set|Clarification.+)$/gim
          ) || [];
          const hasPlanMetadata = /\*\*(?:Complexity|Tags):\*\*/i.test(firstLines);
          return planSections.length >= 2 || (planSections.length >= 1 && hasPlanMetadata);
      } catch {
          return false;
      } finally {
          if (handle) await handle.close();
      }
  }
  ```
- **Edge Cases Handled:** The H1 gate still rejects arbitrary markdown. The fast-path works for `.resolved` sidecars because it normalizes through `_getBaseBrainPath()`. The change does not touch `_isBrainMirrorCandidate()`, `_mirrorBrainPlan()` dedupe, or any write-path code, so the risk stays limited to classification.

### Regression coverage for the shared heuristic
#### [MODIFY] `src/test/brain-new-plan-visibility-regression.test.js`
- **Context:** This repo already protects Antigravity-plan visibility with source-level regression tests that read `TaskViewerProvider.ts` directly. Extending that existing file is the narrowest way to lock in the exact heuristic contract without introducing a new test harness for a private method.
- **Logic:**
  1. Update the existing header-regression assertion so it explicitly expects `Problem Description` and `Proposed Solutions` in the `_isLikelyPlanFile()` regex.
  2. Add a second assertion proving the `implementation_plan.md` basename fast-path exists after the H1 check.
  3. Keep the fresh-brain auto-claim assertions unchanged, because this bugfix must not regress follow-up change-event recovery.
- **Implementation:**
  ```javascript
  'use strict';

  const assert = require('assert');
  const fs = require('fs');
  const path = require('path');

  const providerPath = path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts');
  const source = fs.readFileSync(providerPath, 'utf8');

  describe('brain new-plan visibility regressions', () => {
      it('recognizes the current Antigravity plan markdown shape as a plan file', () => {
          assert.match(
              source,
              /const planSections = firstLines\.match\([\s\S]*Goal\|Goals\|Metadata\|User Review Required\|User Requirements Captured\|Complexity Audit\|Problem Description\|Proposed Solutions\|Proposed Changes[\s\S]*Verification Plan[\s\S]*Adversarial Synthesis[\s\S]*\) \|\| \[\];[\s\S]*const hasPlanMetadata = \/\\\*\\\*\(\?:Complexity\|Tags\):\\\*\\\*\/i\.test\(firstLines\);[\s\S]*return planSections\.length >= 2 \|\| \(planSections\.length >= 1 && hasPlanMetadata\);/,
              'Expected _isLikelyPlanFile to accept the repo\'s current Antigravity plan sections instead of only a narrow legacy subset.'
          );
      });

      it('trusts canonical implementation_plan basenames after the H1 gate', () => {
          assert.match(
              source,
              /const hasH1 = \/\^#\\s\+\.\+\/m\.test\(firstLines\);[\s\S]*if \(!hasH1\) return false;[\s\S]*const baseFilename = path\.basename\(this\._getBaseBrainPath\(filePath\)\)\.toLowerCase\(\);[\s\S]*if \(baseFilename === 'implementation_plan\.md'\) \{[\s\S]*return true;/,
              'Expected _isLikelyPlanFile to treat implementation_plan.md and implementation_plan.md.resolved variants as plan files after the H1 gate.'
          );
      });

      it('auto-claims fresh unregistered brain plans on follow-up change events', () => {
          assert.match(
              source,
              /const isFreshUnregisteredCandidate =[\s\S]*!existingEntry[\s\S]*!runSheetKnown[\s\S]*!fs\.existsSync\(mirrorPath\)[\s\S]*NEW_BRAIN_PLAN_AUTOCLAIM_WINDOW_MS;/,
              'Expected _mirrorBrainPlan to treat fresh unseen brain files as auto-claim candidates.'
          );
          assert.match(
              source,
              /const shouldAutoClaim = !eligibility\.eligible && \(allowAutoClaim \|\| isFreshUnregisteredCandidate\) && !existingEntry;/,
              'Expected _mirrorBrainPlan to keep auto-claim enabled for fresh follow-up change events after the initial create event.'
          );
      });
  });
  ```
- **Edge Cases Handled:** The test continues to guard the shared heuristic instead of just the brain watcher call site. It also ensures the fast-path is anchored after the H1 check, so the implementation cannot silently degrade into unconditional filename trust.

## Verification Plan
### Automated Tests
- Run `npm run compile-tests`.
- Run `npm test` so the existing extension/mocha suite exercises `src/test/brain-new-plan-visibility-regression.test.js` under the standard harness.
- Record that `npm run lint` currently fails at baseline because ESLint 9 cannot find `eslint.config.*`; do not expand this bugfix to repair repo-wide lint tooling.

### Manual Verification
- Save or touch an Antigravity file at `~/.gemini/antigravity/brain/<session>/implementation_plan.md.resolved` whose top sections include an H1, `## Problem Description`, and `## Proposed Solutions`.
- Trigger a rescan by saving the file (watcher change event) or by reloading the workspace/extension so the existing Antigravity startup scan runs again.
- Confirm the corresponding mirror is written under `.switchboard/plans/brain_<sha256>.md` and that the plan is registered in the CREATED column instead of being filtered out.
- Confirm unrelated markdown without an H1 is still ignored.

## Recommendation
- Send to Coder

## Open Questions
- None.

## Reviewer Findings
- No CRITICAL or MAJOR issues found in the plan-specific change set.
- NIT: the regression test is source-text based, so it is still somewhat formatting-sensitive.

## Fixes Applied
- None.

## Files Changed
- `src/services/TaskViewerProvider.ts`
- `src/test/brain-new-plan-visibility-regression.test.js`

## Validation Results
- `npm run compile-tests` ✅
- `npm run compile` ✅

## Remaining Risks
- `_isLikelyPlanFile()` is still a shared gate for both configured plan-folder ingestion and Antigravity brain mirroring, so any future broadening will affect both paths.
- The regression coverage validates source text rather than runtime behavior, so later refactors may require updating the assertion.
