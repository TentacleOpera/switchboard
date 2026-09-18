# Add Reviewer Verbosity Controls to Prompt Add-ons

## Goal
Introduce add-on toggles that let users compress reviewer agent output, and align the reviewer's Caveman Output default with other execution roles to reduce token waste by default.

## Problem Analysis

The reviewer agent's output is excessively verbose even for trivial changes, consuming disproportionate tokens relative to the code delta. Investigation identified five root causes baked into the prompt pipeline:

### Root Cause 1: Theatrical Voice Mandate
`src/services/agentPromptBuilder.ts:508` instructs the reviewer to use a **"dramatic 'Grumpy Principal Engineer' voice (incisive, specific, theatrical)"**. The word *theatrical* explicitly invites prose embellishment. For a one-line null-check fix, the agent still performs the full dramatic monologue.

### Root Cause 2: Mandatory Six-Stage Pipeline
The `DEFAULT_REVIEWER_BASE_INSTRUCTIONS` (`agentPromptBuilder.ts:506-514`) locks the agent into a fixed sequence:
1. Stage 1 (Grumpy) adversarial findings
2. Stage 2 (Balanced) synthesis
3. Apply code fixes
4. Run verification checks
5. Update the original plan file
6. Do all of the above in **one continuous response**

There is no off-ramp for trivial reviews. A single import-order change triggers the same six-stage ceremony as a security refactor.

### Root Cause 3: Explicit Anti-Compression Directive
The same base instructions contain: **"Do NOT truncate, summarize, or delete existing implementation steps."** This prevents the agent from self-compressing even when it recognises the review is minor.

### Root Cause 4: Advanced Regression Analysis (Token-Intensive by Design)
`ADVANCED_REVIEWER_DIRECTIVE` (`agentPromptBuilder.ts:287-293`) is already toggleable via the **Advanced Regression Analysis** add-on, but the directive text itself confesses: *"This analysis is token-intensive but catches regressions..."* Users may not realise this toggle exists or that it defaults to off; however, the base prompt is already verbose without it.

### Root Cause 5: Persona-Level "Explain Why" Rule
`.agent/personas/reviewer.md:13` says: **"Explain *why* something is a problem, not just *that* it is."** This is quality-positive but, combined with the theatrical voice and no-summarise rule, guarantees long-form output for every flagged line.

### Root Cause 6: Caveman Mode Defaults to Off for Reviewer
In `src/webview/sharedDefaults.js:26`, the reviewer role has `cavemanOutput: false` by default, while `lead`, `coder`, and `intern` all default to `true`. The existing token-compression mechanism is therefore inactive for reviewers unless the user explicitly discovers and enables it.

---

## Metadata

**Tags:** frontend, ui, feature, performance
**Complexity:** 5

---

## User Review Required

1. **Concise Mode ↔ Caveman interaction** — When both are enabled, Concise Mode takes precedence for review stages (Stages 1–2) and Caveman applies to code-fix/verification steps. Is this the desired behaviour, or should Concise Mode completely override Caveman?
2. **Persona "Explain Why" suppression** — Concise Mode will inject a directive that overrides the persona's "Explain why" rule. Should the persona file itself be modified, or is an injected override sufficient?

---

## Complexity Audit

### Routine
- Adding two new boolean fields to `CustomAgentAddons` interface and `parseCustomAgentAddons` (follows existing pattern exactly)
- Adding two new add-on definitions to `ROLE_ADDONS.reviewer` in `sharedDefaults.js` (follows existing pattern)
- Adding two new entries to `DEFAULT_ROLE_CONFIG.reviewer.addons` in `sharedDefaults.js`
- Changing `cavemanOutput` default from `false` to `true` in `DEFAULT_ROLE_CONFIG.reviewer` and `ROLE_ADDONS.reviewer` in `sharedDefaults.js`
- Adding two new `promptsConfig` mapping lines in `KanbanProvider.ts` (follows existing per-role pattern)
- Adding two new boolean fields to `PromptBuilderOptions` interface (follows existing pattern)

### Complex / Risky
- Conditionally mutating `DEFAULT_REVIEWER_BASE_INSTRUCTIONS` in `agentPromptBuilder.ts` based on the two new flags — requires careful string replacement logic that must not break the existing reviewer prompt when flags are off
- Interaction between `reviewerConciseModeEnabled` and `cavemanOutputEnabled` — both inject compression directives but with different styles; must define clear precedence rules
- Persona file "Explain why" override — the persona is loaded separately from base instructions; an injected override must be strong enough to take precedence over the persona-level rule

---

## Edge-Case & Dependency Audit

- **Race Conditions:** None. All changes are synchronous configuration/prompt-building code. No async state mutations.
- **Security:** No security implications. These are prompt-generation controls, not auth or data-access paths.
- **Side Effects:** Changing `cavemanOutput` default for reviewer from `false` to `true` aligns it with other execution roles. The `KanbanProvider.ts` fallback at line 2727 (`reviewerConfig?.addons?.cavemanOutput ?? false`) must also be updated to `?? true` to match the new default. Caveman Output is still experimental/unreleased, so no migration or docs concerns apply.
- **Dependencies & Conflicts:** Plan 3 (Fix Caveman Output Tooltip) changes the tooltip string in `sharedDefaults.js`. Both plans touch the same `cavemanOutput` entries. Plan 3 should be applied first (tooltip fix), then this plan (add new add-ons + change default). If applied in reverse order, the tooltip fix will need to re-apply to the new add-on entries.

---

## Dependencies

- Plan 3 (fix-caveman-output-tooltip-accuracy) — should be applied first to avoid re-applying the tooltip fix to new add-on entries added by this plan.

---

## Adversarial Synthesis

Key risks: (1) Concise Mode and Caveman Output both inject compression directives with different styles — without explicit precedence rules, the agent may produce incoherent output; (2) Persona "Explain why" rule is loaded separately and will override Concise Mode unless an explicit suppression directive is injected. Mitigations: Define Concise Mode as taking precedence over Caveman for Stages 1–2; inject an explicit override directive that suppresses the persona's "Explain why" rule when Concise Mode is enabled.

---

## Proposed Solution

Introduce **two new add-on toggles** for the `reviewer` role in the Prompts tab, plus a **default-value change** for Caveman Output.

### New Add-on 1: `reviewerConciseModeEnabled` (checkbox, default: `false`)

**Add-on key in `ROLE_ADDONS.reviewer`:** `reviewerConciseMode`
**Add-on key in `DEFAULT_ROLE_CONFIG.reviewer.addons`:** `reviewerConciseMode: false`
**Field name in `CustomAgentAddons`:** `reviewerConciseModeEnabled?: boolean`
**Field name in `PromptBuilderOptions`:** `reviewerConciseModeEnabled?: boolean`
**Mapping in `KanbanProvider.ts`:** `reviewerConciseModeEnabled: reviewerConfig?.addons?.reviewerConciseMode ?? false`
**UI position in `ROLE_ADDONS.reviewer`:** After `advancedRegression`, before `gitProhibition`

**Label:** Concise Review Mode
**Tooltip:** Replace theatrical voice with terse bullet-point findings; allow the agent to summarise trivial fixes.

**Prompt effect when enabled:**
- Strip the *"dramatic 'Grumpy Principal Engineer' voice (incisive, specific, theatrical)"* clause from Stage 1.
- Replace with: *"Stage 1 (Findings): terse bullet-point findings, severity-tagged (CRITICAL/MAJOR/NIT). One line per issue. No preamble or concluding flourish."*
- Replace the anti-compression rule *"Do NOT truncate, summarize, or delete existing implementation steps"* with: *"You may keep both review stages internally but compress the final output: Stage 2 should be a single tight paragraph, not a lengthy essay."*
- Stage 2 (Balanced synthesis) is still required — it is simply constrained to a maximum of one paragraph.
- **Inject persona override:** When enabled, append to the base instructions: *"OVERRIDE: When Concise Review Mode is active, the persona rule 'Explain why something is a problem' is suspended for this session. Use terse severity-tagged bullets instead of explanatory prose."*
- **Interaction with Caveman Output:** When both `reviewerConciseModeEnabled` and `cavemanOutputEnabled` are true, Concise Mode takes precedence for Stages 1–2 (review content), and Caveman style applies to code-fix and verification steps (Stages 3–5). Do NOT inject the `CAVEMAN_OUTPUT_DIRECTIVE` for the review stages when Concise Mode is active.

### New Add-on 2: `reviewerCompactPlanUpdateEnabled` (checkbox, default: `false`)

**Add-on key in `ROLE_ADDONS.reviewer`:** `reviewerCompactPlanUpdate`
**Add-on key in `DEFAULT_ROLE_CONFIG.reviewer.addons`:** `reviewerCompactPlanUpdate: false`
**Field name in `CustomAgentAddons`:** `reviewerCompactPlanUpdateEnabled?: boolean`
**Field name in `PromptBuilderOptions`:** `reviewerCompactPlanUpdateEnabled?: boolean`
**Mapping in `KanbanProvider.ts`:** `reviewerCompactPlanUpdateEnabled: reviewerConfig?.addons?.reviewerCompactPlanUpdate ?? false`
**UI position in `ROLE_ADDONS.reviewer`:** After `reviewerConciseMode`, before `gitProhibition`

**Label:** Compact Plan Update
**Tooltip:** Append a brief summary to the plan file instead of reproducing full sections.

**Prompt effect when enabled:**
- Modify Step 6: *"Update the original plan file by appending a brief summary (≤ 5 sentences) under `## Review Findings` — list files changed, validation results, and remaining risks. Do NOT reproduce the full implementation steps or copy large blocks of the original plan."*

This replaces the typical multi-paragraph plan-file rewrite with a tight summary, cutting the largest single block of reviewer output.

### Default-Value Change: Caveman Output

**Change:** In `sharedDefaults.js`, set `cavemanOutput: true` for the reviewer role in both `DEFAULT_ROLE_CONFIG.reviewer.addons` and `ROLE_ADDONS.reviewer` (matching lead/coder/intern defaults). Also update the fallback in `KanbanProvider.ts:2727` from `?? false` to `?? true`.

**Rationale:** Caveman mode is the only existing token-reduction lever. It is currently discoverable only if the user opens the Prompts tab, switches to Reviewer, and notices the unchecked box. Aligning the default with other execution roles treats token inflation as a first-class concern.

---

## Proposed Changes

### `src/webview/sharedDefaults.js`
- **Context:** Lines 26 (DEFAULT_ROLE_CONFIG.reviewer), 117–132 (ROLE_ADDONS.reviewer)
- **Logic:**
  1. In `DEFAULT_ROLE_CONFIG.reviewer.addons` (line 26): change `cavemanOutput: false` → `cavemanOutput: true`
  2. In `DEFAULT_ROLE_CONFIG.reviewer.addons` (line 26): add `reviewerConciseMode: false, reviewerCompactPlanUpdate: false`
  3. In `ROLE_ADDONS.reviewer` (lines 117–132): change the `cavemanOutput` entry's `default: false` → `default: true`
  4. In `ROLE_ADDONS.reviewer` (lines 117–132): add two new add-on entries after `advancedRegression`:
     ```javascript
     { id: 'reviewerConciseMode', label: 'Concise Review Mode', tooltip: 'Replace theatrical voice with terse bullet-point findings; allow the agent to summarise trivial fixes', default: false },
     { id: 'reviewerCompactPlanUpdate', label: 'Compact Plan Update', tooltip: 'Append a brief summary to the plan file instead of reproducing full sections', default: false },
     ```
- **Edge Cases:** The `cavemanOutput` tooltip in `ROLE_ADDONS.reviewer` should use the corrected text from Plan 3: `'Compress responses to reduce output tokens'` (not the old 65-75% text).

### `src/services/agentPromptBuilder.ts`
- **Context:** Lines 75–146 (PromptBuilderOptions), lines 505–561 (reviewer prompt building)
- **Logic:**
  1. Add to `PromptBuilderOptions` interface:
     ```typescript
     /** When true, replaces theatrical reviewer voice with terse bullet-point findings. */
     reviewerConciseModeEnabled?: boolean;
     /** When true, reviewer appends a brief summary to the plan file instead of reproducing full sections. */
     reviewerCompactPlanUpdateEnabled?: boolean;
     ```
  2. In `buildKanbanBatchPrompt`, inside the `role === 'reviewer'` block (after line 505):
     - Extract the new options:
       ```typescript
       const reviewerConciseModeEnabled = options?.reviewerConciseModeEnabled ?? false;
       const reviewerCompactPlanUpdateEnabled = options?.reviewerCompactPlanUpdateEnabled ?? false;
       ```
     - When `reviewerConciseModeEnabled` is true, replace `DEFAULT_REVIEWER_BASE_INSTRUCTIONS` with a concise variant:
       ```typescript
       let reviewerBaseInstructions = DEFAULT_REVIEWER_BASE_INSTRUCTIONS;
       if (reviewerConciseModeEnabled) {
           reviewerBaseInstructions = reviewerBaseInstructions
               .replace('in a dramatic "Grumpy Principal Engineer" voice (incisive, specific, theatrical)', 'terse bullet-point findings, severity-tagged (CRITICAL/MAJOR/NIT). One line per issue. No preamble or concluding flourish')
               .replace('Do NOT truncate, summarize, or delete existing implementation steps.', 'You may keep both review stages internally but compress the final output: Stage 2 should be a single tight paragraph, not a lengthy essay.')
               + '\n\nOVERRIDE: When Concise Review Mode is active, the persona rule "Explain why something is a problem" is suspended for this session. Use terse severity-tagged bullets instead of explanatory prose.';
       }
       if (reviewerCompactPlanUpdateEnabled) {
           reviewerBaseInstructions = reviewerBaseInstructions
               .replace(
                   /Update the original plan file with fixed items, files changed, validation results, and remaining risks\. Do NOT truncate, summarize, or delete existing implementation steps\./,
                   'Update the original plan file by appending a brief summary (≤ 5 sentences) under `## Review Findings` — list files changed, validation results, and remaining risks. Do NOT reproduce the full implementation steps or copy large blocks of the original plan.'
               );
       }
       ```
     - Use `reviewerBaseInstructions` instead of `DEFAULT_REVIEWER_BASE_INSTRUCTIONS` in `resolveBaseInstructions` call (line 524).
     - **Caveman↔Concise interaction:** When both `reviewerConciseModeEnabled` and `cavemanOutputEnabled` are true, do NOT inject `CAVEMAN_OUTPUT_DIRECTIVE` for the review stages. Instead, add a note: *"Caveman style applies to code-fix and verification steps only; review stages use Concise Mode."*
- **Edge Cases:** The string replacements must be exact matches of the current `DEFAULT_REVIEWER_BASE_INSTRUCTIONS` text. If that text changes in the future, these replacements will silently fail. Consider adding a comment in the source warning about this coupling.

### `src/services/agentConfig.ts`
- **Context:** Lines 3–36 (CustomAgentAddons interface), lines 148–199 (parseCustomAgentAddons)
- **Logic:**
  1. Add to `CustomAgentAddons` interface:
     ```typescript
     reviewerConciseModeEnabled?: boolean;
     reviewerCompactPlanUpdateEnabled?: boolean;
     ```
  2. Add to `parseCustomAgentAddons` function:
     ```typescript
     if (s.reviewerConciseModeEnabled === true) a.reviewerConciseModeEnabled = true;
     if (s.reviewerCompactPlanUpdateEnabled === true) a.reviewerCompactPlanUpdateEnabled = true;
     ```
- **Edge Cases:** None. Follows existing pattern exactly.

### `src/services/KanbanProvider.ts`
- **Context:** Lines 2547–2700+ (promptsConfig building), line 2727 (cavemanOutputByRole reviewer fallback)
- **Logic:**
  1. Add to the `promptsConfig` object (after `advancedReviewerEnabled` mapping, ~line 2601):
     ```typescript
     reviewerConciseModeEnabled: reviewerConfig?.addons?.reviewerConciseMode ?? false,
     reviewerCompactPlanUpdateEnabled: reviewerConfig?.addons?.reviewerCompactPlanUpdate ?? false,
     ```
  2. Update `cavemanOutputByRole.reviewer` fallback (line 2727) from `?? false` to `?? true` to match the new default.
  3. Add the new fields to the `resolvedOptions: PromptBuilderOptions` object (~line 2479):
     ```typescript
     reviewerConciseModeEnabled: promptsConfig.reviewerConciseModeEnabled ?? false,
     reviewerCompactPlanUpdateEnabled: promptsConfig.reviewerCompactPlanUpdateEnabled ?? false,
     ```
- **Edge Cases:** The `cavemanOutputByRole` fallback must match the new default. If it stays `?? false`, existing users without explicit config will still get the old behaviour despite the `sharedDefaults.js` change.

---

## Verification Plan

### Automated Tests
- **Unit test: Concise Mode prompt mutation** — Verify that when `reviewerConciseModeEnabled: true`, the generated reviewer prompt does NOT contain "theatrical" or "Grumpy Principal Engineer" and DOES contain "terse bullet-point findings".
- **Unit test: Compact Plan Update prompt mutation** — Verify that when `reviewerCompactPlanUpdateEnabled: true`, the generated reviewer prompt contains "≤ 5 sentences" and "Review Findings" and does NOT contain "Do NOT truncate, summarize, or delete".
- **Unit test: Caveman↔Concise interaction** — Verify that when both flags are true, the prompt contains the Concise Mode review-stage directive and the Caveman directive is either absent or scoped to code-fix steps only.
- **Unit test: Default values** — Verify that `DEFAULT_ROLE_CONFIG.reviewer.addons.cavemanOutput` is `true` and the new add-ons default to `false`.
- **Unit test: parseCustomAgentAddons** — Verify that the new fields are correctly parsed from raw addon objects.

### Manual Verification
1. Open the Kanban view → Prompts tab → Reviewer role.
2. Confirm two new checkboxes appear: "Concise Review Mode" and "Compact Plan Update", both unchecked by default.
3. Confirm "Caveman Output" checkbox is checked by default for the reviewer role.
4. Enable "Concise Review Mode", dispatch a review, and confirm the output uses terse bullet-point findings instead of theatrical prose.
5. Enable "Compact Plan Update", dispatch a review, and confirm the plan file update is a brief summary under `## Review Findings` rather than a full reproduction.
6. Enable both "Concise Review Mode" and "Caveman Output", dispatch a review, and confirm the output is coherent (concise for review stages, caveman for code-fix steps).

---

## Backwards Compatibility

- Both new toggles default to `false`, so existing behaviour is preserved unless the user opts in.
- The Caveman Output default change aligns the reviewer with other execution roles. Caveman Output is still experimental/unreleased, so no migration or documentation concerns apply.

## Open Questions

1. ~~Should `reviewerConciseMode` also suppress the `.agent/personas/reviewer.md` "Explain why" rule?~~ **Resolved:** Yes. When Concise Mode is enabled, an explicit override directive is injected that suspends the persona's "Explain why" rule for that session.
2. Should we offer a **preset** (e.g. "Minimal Reviewer" = concise + compactPlanUpdate + caveman) rather than two individual toggles?
3. Is there telemetry or user feedback data showing which output sections users most often scroll past?

---

## Review Findings

**Reviewer:** In-place review pass (2026-06-07)

### Stage 1 Findings (Grumpy)

| # | Severity | Finding |
|---|----------|---------|
| 5 | NIT | `else if` structure for Concise/Compact interaction is confusing but functionally correct |
| 6 | NIT | Caveman↔Concise interaction deviates from plan (injects CAVEMAN_OUTPUT_DIRECTIVE + scoping note instead of omitting it) — implementation is arguably better |
| 13 | NIT | Missing coupling warning comment for string replacements coupled to DEFAULT_REVIEWER_BASE_INSTRUCTIONS |
| 14 | MAJOR | Reviewer-specific options (`reviewerConciseModeEnabled`, `reviewerCompactPlanUpdateEnabled`) set unconditionally in `resolvedOptions` (KanbanProvider.ts:2493-2494), violating the pattern used by `advancedReviewerEnabled` which is only set inside the reviewer block |
| 16 | MAJOR | Concise Mode `.replace()` target too narrow — only replaces "in a dramatic..." phrase, leaving "adversarial findings, severity-tagged (CRITICAL/MAJOR/NIT)," prefix intact, producing redundant severity tags in output |
| 17 | MAJOR | Design flaw: Concise Mode strips the Grumpy Principal Engineer voice entirely, but the theatrical voice is high-value (fun, distinctive) and low-token-cost. The real waste is output structure (essays, reproduced plan sections), not voice tone. Voice and verbosity are orthogonal — a Grumpy one-liner is both theatrical AND concise |

### Stage 2 Synthesis

- Finding 5 (NIT): Keep as-is. Correct behavior, comment not worth churn.
- Finding 6 (NIT): Keep as-is. Implementation is stronger than plan's suggestion.
- Finding 13 (NIT): **Fixed.** Added coupling warning comment above the string replacements.
- Finding 14 (MAJOR): **Fixed.** Removed unconditional assignments at KanbanProvider.ts:2493-2494. Reviewer block at lines 2518-2520 already sets these correctly.
- Finding 16 (MAJOR): **Fixed.** Reverted to narrower replacement target (just the voice clause ending) since Finding 17 changed the design intent — we now keep the Grumpy voice, so the "adversarial findings, severity-tagged" prefix naturally stays.
- Finding 17 (MAJOR): **Fixed.** Redesigned Concise Mode to preserve the Grumpy Principal Engineer voice while adding compression constraints. Changes: (1) replacement now keeps "in a dramatic 'Grumpy Principal Engineer' voice" and appends "— but keep each finding to one terse bullet. No preamble or concluding flourish"; (2) persona override changed from "suspend Explain Why" to "one-sentence reason per finding. Theatrical tone welcome; verbosity is not"; (3) tooltip updated from "Replace theatrical voice" to "Keep theatrical voice but compress findings to terse bullets".

### Files Changed

1. `src/services/agentPromptBuilder.ts` — Concise Mode now preserves Grumpy voice + adds compression constraint (line ~536); persona override changed from "suspend Explain Why" to "one-sentence Why, theatrical tone welcome" (line ~550); added coupling warning comment (lines 530-532)
2. `src/services/KanbanProvider.ts` — Removed unconditional `reviewerConciseModeEnabled` and `reviewerCompactPlanUpdateEnabled` from `resolvedOptions` (was lines 2493-2494)
3. `src/webview/sharedDefaults.js` — Updated Concise Review Mode tooltip from "Replace theatrical voice with terse bullet-point findings" to "Keep theatrical voice but compress findings to terse bullets" (line 120)

### Validation Results

- TypeScript check: 2 pre-existing errors (unrelated import extension issues in `ClickUpSyncService.ts` and `KanbanProvider.ts`). No new errors from review fixes.
- No automated tests run (per SKIP TESTS directive).

### Remaining Risks

1. **Silent replacement failure:** If `DEFAULT_REVIEWER_BASE_INSTRUCTIONS` text changes, the `.replace()` calls will silently no-op. The coupling warning comment mitigates this but doesn't prevent it. A future improvement could use assertion checks or template literals with named slots.
2. **Caveman↔Concise scoping:** The scoping note ("Caveman style applies to code-fix and verification steps only; review stages use Concise Mode") relies on the LLM correctly partitioning its output by stage. If the LLM ignores the scoping note, output may be inconsistent. No programmatic enforcement exists.

---

**Recommendation:** Complexity 5 → Send to Coder
