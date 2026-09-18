# Replace Inline ADVISE_RESEARCH_DIRECTIVE with a Skill File Link

## Goal

The "Advise Research If Unsure" planner add-on currently injects a ~400-word inline directive (`ADVISE_RESEARCH_DIRECTIVE`) directly into the planner prompt. This bloats every planner dispatch that has the toggle enabled, consuming premium-model tokens with structural instructions the agent could just as easily read from a skill file on demand. The directive should be replaced with a short reference to a skill file, so the agent reads the full research-prompt structure only when it actually needs to emit a research recommendation.

### Problem Analysis & Root Cause

**Root cause:** `ADVISE_RESEARCH_DIRECTIVE` (defined at `src/services/agentPromptBuilder.ts:308-321`) is a ~400-word constant that spells out the full research-prompt template (ROLE, CONTEXT, CENTRAL QUESTION, SUB-QUESTIONS, SOURCE GUIDANCE, SCOPE, OUTPUT format, CITATIONS, DEPTH). When `adviseResearchIfUnsure` is true (default-on per `kanban.html:3251`), the entire constant is appended to `plannerBase` at line 549. This means every single planner dispatch pays the token cost of this template, even though most plans have zero uncertainties and the agent will omit the research section entirely.

The directive also has a mirror copy in `src/webview/planning.js` (`generateResearchPrompt()`, ~line 5037) that must be kept in sync manually (noted in the code comment at line 306-307). This dual-maintenance burden is a direct consequence of inlining the template rather than referencing a shared skill file.

**Token-savings estimate (Clarification, not a new requirement):** The current constant is ~400 words (~550 tokens); the replacement reference is ~70 words (~100 tokens). Net saving ≈ 450 tokens per planner dispatch when the toggle is enabled. Because the UI loads the toggle as `config.addons?.adviseResearch !== false` (default-on), the saving applies to most UI-driven planner dispatches. The builder itself defaults `adviseResearchIfUnsure` to `false` (`agentPromptBuilder.ts:450`), so programmatic callers without the flag pay nothing either way.

## Metadata

- **Tags:** feature, refactor, performance
- **Complexity:** 5/10
- **Files affected:** `src/services/agentPromptBuilder.ts`, `.agents/skills/advise_research/SKILL.md` (new), `src/extension.ts` (activation-time skill seed), `src/webview/planning.js` (comment update only)
- **Shipped state:** The `adviseResearchIfUnsure` option and `ADVISE_RESEARCH_DIRECTIVE` have shipped in released versions. The config key `addons.adviseResearch` must be preserved; only the inline text changes. The new skill file is a net-new artifact that must be distributed to existing users (see Edge-Case #5).

## User Review Required

Yes — review the activation-time skill-seeding approach in Proposed Change #5 before implementation. It touches the extension activation path (`extension.ts`) and must be copy-if-missing only (never overwrite existing user skill files). Confirm this matches the project's migration policy (CLAUDE.md: preserve user customizations, never assume a prior migration ran).

## Complexity Audit

### Routine
- Creating a new skill file at `.agents/skills/advise_research/SKILL.md` containing the research-prompt template (migrated verbatim from the current `ADVISE_RESEARCH_DIRECTIVE` text).
- Replacing the inline `ADVISE_RESEARCH_DIRECTIVE` constant (lines 308-321) with a short reference string.
- Updating the cross-reference code comment at `agentPromptBuilder.ts:306-307`.
- Updating the now-stale mirror comment at `planning.js:5035-5036` to point at the skill file as the canonical source.

### Complex / Risky
- **Activation-time skill seeding for existing users** (`extension.ts`): the new skill file will NOT reach the ~4,000 existing installs via the current activation path, because `performSetup` (the only routine that copies `.agents/skills/`) runs solely via the explicit `switchboard.setup` command (`extension.ts:3391`), not on activation. On activation only `ensureAgentsProtocol` runs, which refreshes `AGENTS.md` alone. The version-gated refresh at `extension.ts:3297` overwrites workflow files only; skills use "skip if exists" (line 3306). A new, non-destructive copy-if-missing seed must be added to the activation path so existing users receive the file without manually re-running Setup.
- The `generateResearchPrompt()` function in `planning.js` is used by the Research tab UI (copy prompt / draft with analyst buttons) and is a separate code path — it generates a user-facing research prompt from the UI input, not an agent directive. This function should NOT be changed; it serves a different purpose (interactive research prompt generation, not the planner add-on). The skill file should contain the same template structure so both stay aligned, but the JS function remains as-is.
- Existing user configs with `addons.adviseResearch: true` must continue to work — the option name and default behavior don't change, only the injected text shrinks.

## Edge-Case & Dependency Audit

1. **Config compatibility:** The `adviseResearchIfUnsure` option is read from `options?.adviseResearchIfUnsure` (line 450) and defaults to `false` in the builder, but the UI (`kanban.html:3251`) loads it as `config.addons?.adviseResearch !== false` (default-on). No config key changes — the toggle still works identically.
2. **Skill file discovery / reference convention:** The codebase uses two conventions for referencing skills from directives: skill-name invocation (`skill: "complexity_scoring"` at `agentPromptBuilder.ts:338`) and file-path reference (`Follow instructions in .agents/skills/constitution_builder.md` at `PlanningPanelProvider.ts:3186`). This plan uses the file-path form because it is more portable across heterogeneous agent hosts (Cursor, Claude Code, Gemini CLI, Devin all have file-read tools; `skill:` invocation only works if the host implements a skill-loading layer). The short directive text must instruct the agent to read the skill file, not assume auto-loading. The core instruction ("emit a ## Recommended Research section") is kept inline so that if the skill file is absent the agent still emits the section (graceful degradation — just without the exact template structure).
3. **Test impact (CORRECTED):** `src/services/__tests__/agentPromptBuilder.test.ts` has matches for "research" at lines 159, 161, 192, 193, but these cover the `code_researcher` role (PHASE 5) and `columnToPromptRole('RESEARCHER')` — they are UNRELATED to `ADVISE_RESEARCH_DIRECTIVE`. A grep of the entire test directory for `ADVISE_RESEARCH`, `adviseResearch`, `RESEARCH WHEN UNSURE`, and `Recommended Research` returns ZERO matches. There are no existing tests asserting on this directive. No tests need updating. Optionally ADD a test asserting the short reference string appears when `adviseResearchIfUnsure: true` and is absent when `false`/`undefined` (there is currently no coverage for this toggle at all).
4. **planning.js mirror comment:** The `generateResearchPrompt()` function in `planning.js` is a separate UI-driven code path and remains unchanged. The code comment at `planning.js:5035-5036` currently says "The structure below is mirrored by ADVISE_RESEARCH_DIRECTIVE in src/services/agentPromptBuilder.ts. Keep both in sync." After this change `ADVISE_RESEARCH_DIRECTIVE` will be a 70-word stub, so that comment becomes stale and misleading. Update it to note that the skill file `.agents/skills/advise_research/SKILL.md` is now the canonical source for the template structure, and that `generateResearchPrompt()` embeds the same structure independently for the webview (it cannot read the extension-side skill file at runtime).
5. **Skill-file distribution to existing users (CRITICAL):** `.agents/skills/` is copied from the bundled extension into the workspace only by `performSetup` (`extension.ts:3267`), invoked exclusively via the `switchboard.setup` command (`extension.ts:3391`). It does NOT run on activation. The activation path (`extension.ts:428-447`) calls only `ensureAgentsProtocol`, which refreshes `AGENTS.md`. The version-gated workflow refresh (`extension.ts:3297`) overwrites `workflows/*.md` only; skills use "skip if exists" (`extension.ts:3306`). Consequently, existing users will NOT receive the new `advise_research/SKILL.md` until they manually re-run Setup. Until then the directive references a non-existent file and the research-advisory feature silently degrades. Per CLAUDE.md migration policy ("assume it shipped and migrate"), an activation-time copy-if-missing seed for new skill files must be added (see Proposed Change #5).
6. **Race Conditions:** None. The directive is a static string concatenated into a prompt; the skill file is read-only at runtime.
7. **Security:** None. No secrets, no user input flows into the directive or skill file.
8. **Side Effects:** The only behavioral change is a shorter injected prompt when the toggle is on. No kanban state, plan files, or DB schema are touched.

## Dependencies

- `feature_plan_20260623141100_planner-addon-advise-research-if-unsure.md` — the predecessor plan that introduced `ADVISE_RESEARCH_DIRECTIVE` and the `adviseResearchIfUnsure` toggle. This plan refactors that shipped feature; it does not change the toggle semantics.

## Adversarial Synthesis

Key risks: (1) the new skill file will not reach ~4,000 existing users because `performSetup` (the only skill-copying routine) runs on explicit Setup only, not on activation — causing a silent regression of the default-on research-advisory feature; (2) the plan's test-impact claim was factually wrong (no tests reference the directive), so no tests need updating and the optional step is to ADD coverage rather than modify it; (3) leaving the `planning.js` mirror comment untouched creates a new stale comment. Mitigations: add a non-destructive activation-time copy-if-missing seed for `.agents/skills/**` in `extension.ts`; correct the test step; update the `planning.js` comment to point at the skill file as canonical. Complexity rises to 5 (now touches activation logic with migration sensitivity). Send to Coder.

## Proposed Changes

### 1. Create `.agents/skills/advise_research/SKILL.md`

New skill file containing the full research-prompt template (migrated from the current `ADVISE_RESEARCH_DIRECTIVE` text). This becomes the canonical source for the template structure.

```markdown
# Advise Research If Unsure

When planning, track every assumption, factual claim, API/behavior, or library detail you are NOT 100% certain about. If any exist, append a section titled "## Recommended Research" to your output containing a ready-to-run research prompt that covers ONLY those uncertainties.

## Research Prompt Structure

Structure the research prompt as follows:
- ROLE definition for the research analyst
- CONTEXT describing the domain and audience
- CENTRAL QUESTION
- 4-6 targeted SUB-QUESTIONS derived from your specific uncertainties
- SOURCE GUIDANCE (authoritative sources, date-checking, separate required/recommended/opinion)
- SCOPE boundaries
- OUTPUT format:
  - A short H1 document title (fewer than 10 words, no colons or extra statements) — this is the title of the research document, not "Executive Summary"
  - "Executive Summary" as an H2 section heading beneath the title
  - Tiered findings, trade-off evaluation, glossary, and source list as subsequent sections
- CITATIONS: Do NOT include inline source URLs or citations in the body of the report. Attach all references as a single consolidated list at the END of the report only
- DEPTH level with a source count target of at least 50 authoritative sources

## After Generating

Advise the user to run that prompt through Google AI Studio (search grounding enabled), Claude, or their research agent of choice, and to feed the findings back before implementation. If you are confident about everything, state that no research is needed and omit the section.
```

### 2. Replace `ADVISE_RESEARCH_DIRECTIVE` in `src/services/agentPromptBuilder.ts`

Replace the ~400-word constant (lines 308-321) with a short reference. The core instruction ("emit a ## Recommended Research section") is kept inline for graceful degradation when the skill file is absent; the template structure is outsourced to the skill file.

```typescript
// The full research-prompt template now lives in .agents/skills/advise_research/SKILL.md (the
// canonical source). The generateResearchPrompt() function in src/webview/planning.js is a separate
// UI-driven code path (Research tab) and remains independent — it embeds the same structure for the
// webview and cannot read the extension-side skill file at runtime. Both share the template structure
// via the skill file as canonical source.
export const ADVISE_RESEARCH_DIRECTIVE = `RESEARCH WHEN UNSURE: As you plan, track every assumption, factual claim, API/behavior, or library detail you are NOT 100% certain about. If any exist, read the skill file .agents/skills/advise_research/SKILL.md and follow its template to append a "## Recommended Research" section to your output. If you are confident about everything, state that no research is needed and omit the section.`;
```

### 3. Update the code comment at `agentPromptBuilder.ts:306-307`

Replaced inline above as part of Proposed Change #2 (the comment now precedes the new constant). The old two-line comment about mirroring `planning.js` is superseded by the expanded comment noting the skill file is canonical.

### 4. Update the stale mirror comment in `src/webview/planning.js:5034-5036`

The current comment says the structure is "mirrored by ADVISE_RESEARCH_DIRECTIVE." After Proposed Change #2, `ADVISE_RESEARCH_DIRECTIVE` is a 70-word stub, so this comment would be misleading. Update to:

```javascript
// Research Tab: Prompt Generation Functions
// The canonical research-prompt template now lives in .agents/skills/advise_research/SKILL.md.
// This webview function embeds the same structure independently (it cannot read the extension-side
// skill file at runtime). Keep the field list below in sync with the skill file.
```

`generateResearchPrompt()` itself is unchanged.

### 5. Add activation-time copy-if-missing seed for new skill files in `src/extension.ts`

**Context:** `performSetup` (`extension.ts:3267`) is the only routine that copies `.agents/skills/` from the bundled extension into the workspace, and it runs only via the explicit `switchboard.setup` command (`extension.ts:3391`), not on activation. The activation path (`extension.ts:428-447`) calls only `ensureAgentsProtocol` (AGENTS.md). The version-gated refresh (`extension.ts:3297`) overwrites `workflows/*.md` only. As a result, existing users will not receive new skill files (like `advise_research/SKILL.md`) until they manually re-run Setup.

**Logic:** Add a small, non-destructive seed step to the activation path (alongside the existing `ensureAgentsProtocol` block around `extension.ts:428-447`) that crawls the bundled `.agents/skills/` tree and copies any file that does NOT already exist at the destination. Never overwrite existing files (preserves user customizations, consistent with the `performSetup` skip-if-exists behavior at line 3306). This is copy-if-missing only.

**Implementation sketch:**
```typescript
// After the existing ensureAgentsProtocol block (~line 447), inside the `if (workspaceRoot)` guard:
try {
    const bundledSkillsUri = vscode.Uri.joinPath(context.extensionUri, '.agents', 'skills');
    const skillFiles = await crawlDirectory(bundledSkillsUri); // reuse existing helper (extension.ts:3242)
    for (const relativePath of skillFiles) {
        const destUri = vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), '.agents', 'skills', relativePath);
        try {
            await vscode.workspace.fs.stat(destUri); // exists → skip (preserve user customization)
        } catch {
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(destUri.fsPath)));
            await vscode.workspace.fs.copy(
                vscode.Uri.joinPath(bundledSkillsUri, relativePath),
                destUri,
                { overwrite: false }
            );
        }
    }
} catch (err) {
    console.error('[Switchboard] Skill-file seed failed, continuing activation:', err);
}
```

**Edge cases:**
- Multi-root workspaces: run for each workspace root (the existing activation block already iterates per-root via `workspaceRoot`).
- User-deleted skill files: a deleted file is "missing" and will be re-seeded. This is acceptable — skills are extension-managed assets, not user data. If a user intentionally deleted a skill, re-seeding restores it; this matches the existing `performSetup` behavior which also re-creates missing files.
- Performance: `crawlDirectory` is depth-limited (max 5) and the skills tree is small (~30 files). Negligible cost.

### 6. (Optional) Add test coverage for the `adviseResearchIfUnsure` toggle

There is currently NO test coverage for this toggle. Optionally add tests in `src/services/__tests__/agentPromptBuilder.test.ts`:
- `adviseResearchIfUnsure: true` → built planner prompt contains `RESEARCH WHEN UNSURE` and `advise_research/SKILL.md`.
- `adviseResearchIfUnsure: false` / `undefined` → built planner prompt does NOT contain `RESEARCH WHEN UNSURE`.

This is optional because the toggle is a simple string-concatenation branch with no logic, but adding coverage prevents future regressions.

## Verification Plan

### Automated Tests
- (Per session directive, the full test suite is run separately by the user — do NOT run automated tests as part of this plan.)
- If Proposed Change #6 is implemented, the new toggle tests should pass alongside the existing suite.
- No existing tests reference `ADVISE_RESEARCH_DIRECTIVE`, so no existing assertions will break from the text change.

### Manual Verification
1. **Prompt inspection:** Enable "Advise Research If Unsure" in the Kanban PROMPTS tab, copy a planner prompt, and verify the output contains the short reference line ("RESEARCH WHEN UNSURE" + "advise_research/SKILL.md") and NOT the full 400-word template (no "ROLE definition for the research analyst" inline block).
2. **Toggle off:** Disable the toggle, copy a planner prompt, and verify the reference line is absent.
3. **Skill file readability:** Confirm `.agents/skills/advise_research/SKILL.md` exists at the workspace root under `.agents/skills/` and contains the full template structure.
4. **Config preservation:** Verify that toggling the checkbox off and on still correctly controls whether the directive appears in the prompt (no config-key change).
5. **No regression in planning.js:** Verify the Research tab "Copy Research Prompt" and "Draft with Analyst" buttons still work (they use `generateResearchPrompt()` which is unchanged).
6. **Existing-user migration:** Simulate an existing install by deleting `.agents/skills/advise_research/` from the workspace, then reloading the extension (activation). Confirm the skill file is re-seeded automatically (copy-if-missing) without re-running the Setup command. Confirm existing skill files (e.g. `complexity_scoring.md`) are NOT overwritten.
7. **Stale comment check:** Open `planning.js:5034` and confirm the comment now references the skill file as canonical (no lingering "mirrored by ADVISE_RESEARCH_DIRECTIVE" wording).

## Recommendation

Complexity 5/10 → **Send to Coder.**

---

## Reviewer Pass (2026-06-24)

**Reviewer mode:** Direct in-place reviewer-executor (no auxiliary workflow). Adversarial review + balanced synthesis + verification, executed in one continuous pass.

### Implementation Verification (all six Proposed Changes)

| # | Change | Status | Evidence |
|---|---|---|---|
| 1 | Create `.agents/skills/advise_research/SKILL.md` | DONE | File exists (1549 bytes); contains full template (ROLE/CONTEXT/CENTRAL QUESTION/SUB-QUESTIONS/SOURCE GUIDANCE/SCOPE/OUTPUT/CITATIONS/DEPTH/After Generating) verbatim from the plan. |
| 2 | Replace `ADVISE_RESEARCH_DIRECTIVE` with short reference | DONE | `src/services/agentPromptBuilder.ts:311` — ~70-word stub containing `RESEARCH WHEN UNSURE:` + skill-file path + graceful-degradation clause. |
| 3 | Update code comment at `agentPromptBuilder.ts:306-310` | DONE | Expanded comment notes skill file is canonical; notes `generateResearchPrompt()` is a separate webview path. |
| 4 | Update stale mirror comment in `planning.js:5034-5037` | DONE | Comment now references the skill file as canonical; `generateResearchPrompt()` itself unchanged. |
| 5 | Activation-time copy-if-missing skill seeding in `extension.ts` | DONE | `src/extension.ts:448-468`, inside the `if (workspaceRoot)` guard (line 428). Reuses existing `crawlDirectory` helper (line 3264). `stat`-then-`copy({overwrite:false})`; wrapped in try/catch that logs and continues. |
| 6 | (Optional) Add test coverage for the toggle | DONE | `src/services/__tests__/agentPromptBuilder.test.ts:159-175` — three tests (true/false/undefined). Uses existing `buildKanbanBatchPrompt` + `makePlans` helpers and the `'planner'` role, which routes through the `if (role === 'planner')` block (line 494) containing the `adviseResearchIfUnsure` branch (line 538). |

### Stage 1 — Adversarial Findings (Grumpy Principal Engineer)

- **CRITICAL:** None.
- **MAJOR:** None.
- **NIT-1 (pre-existing, NOT introduced by this plan):** `crawlDirectory` (`extension.ts:3279`) joins relative paths with `path.sep`. On Windows this yields `advise_research\SKILL.md`, which `vscode.Uri.joinPath` *may* treat as a single literal segment. However, `performSetup` (`extension.ts:3307-3314`) uses the identical pattern and has shipped to ~4,000 installs, so this is a shared latent concern, not a regression from this plan. **Defer.**
- **NIT-2 (documented design tradeoff):** The activation seeding is unconditional (not version-gated), so a user who intentionally deletes a skill file gets it re-seeded on every activation. The plan explicitly accepted this ("skills are extension-managed assets... matches performSetup behavior"). Defensible; an optional one-line code comment stating the re-seed-on-delete intent would help future maintainers. **Defer.**

### Stage 2 — Balanced Synthesis

No CRITICAL or MAJOR findings → **no code fixes applied.** All six proposed changes (including the optional test) are implemented correctly and match the plan. The two NITs are pre-existing or documented tradeoffs and do not warrant changes under this plan's scope.

### Verification Results

- **Compilation:** Skipped per session directive (project assumed pre-compiled).
- **Automated tests:** Skipped per session directive (run separately by the user). Static inspection confirms the new tests are wired correctly: `buildKanbanBatchPrompt` and `makePlans` are imported/defined at the top of the test file; the `'planner'` role exercises the `adviseResearchIfUnsure` branch.
- **Static checks performed:**
  - `path` is imported at `extension.ts:3` (used by the seeding block at line 458).
  - `ADVISE_RESEARCH_DIRECTIVE` is referenced at `agentPromptBuilder.ts:539` (the only runtime use).
  - `git status` → working tree clean; all changes committed.
  - No lingering `mirrored by ADVISE_RESEARCH_DIRECTIVE` wording in `planning.js`.

### Files Changed (final state)

- `.agents/skills/advise_research/SKILL.md` (new, 1549 bytes)
- `src/services/agentPromptBuilder.ts` (lines 306-311: comment + constant replaced)
- `src/webview/planning.js` (lines 5034-5037: mirror comment updated)
- `src/extension.ts` (lines 448-468: activation-time skill seeding added)
- `src/services/__tests__/agentPromptBuilder.test.ts` (lines 159-175: three new tests)

### Remaining Risks

1. **NIT-1 (path.sep on Windows):** pre-existing latent concern shared with `performSetup`. Not addressed here; track separately if Windows skill-copy failures are ever reported.
2. **NIT-2 (re-seed-on-delete):** intentional per plan. A user who deletes a bundled skill will see it restored on next activation. Acceptable for extension-managed assets; revisit only if user-customized skills are ever introduced.
3. **No runtime verification of the activation seed path** was performed in this session (would require reloading the extension in a VS Code host). Manual verification step #6 in the plan's Verification Plan covers this and should be executed by the user.

### Reviewer Summary

| Severity | Count | File:Line | Fix Applied |
|---|---|---|---|
| CRITICAL | 0 | — | — |
| MAJOR | 0 | — | — |
| NIT | 2 | `extension.ts:3279` (pre-existing); `extension.ts:448` (documented tradeoff) | None (deferred) |

**Outcome:** Implementation complete and correct. No fixes required. Plan ready to close.
