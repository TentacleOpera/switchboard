# Replace Inline ADVISE_RESEARCH_DIRECTIVE with a Skill File Link

## Goal

The "Advise Research If Unsure" planner add-on currently injects a ~400-word inline directive (`ADVISE_RESEARCH_DIRECTIVE`) directly into the planner prompt. This bloats every planner dispatch that has the toggle enabled, consuming premium-model tokens with structural instructions the agent could just as easily read from a skill file on demand. The directive should be replaced with a short one-line reference to a skill file, so the agent reads the full research-prompt structure only when it actually needs to emit a research recommendation.

### Problem Analysis & Root Cause

**Root cause:** `ADVISE_RESEARCH_DIRECTIVE` (defined at `src/services/agentPromptBuilder.ts:308-321`) is a ~400-word constant that spells out the full research-prompt template (ROLE, CONTEXT, CENTRAL QUESTION, SUB-QUESTIONS, SOURCE GUIDANCE, SCOPE, OUTPUT format, CITATIONS, DEPTH). When `adviseResearchIfUnsure` is true (default-on per `kanban.html:3251`), the entire constant is appended to `plannerBase` at line 549. This means every single planner dispatch pays the token cost of this template, even though most plans have zero uncertainties and the agent will omit the research section entirely.

The directive also has a mirror copy in `src/webview/planning.js` (`generateResearchPrompt()`, ~line 5037) that must be kept in sync manually (noted in the code comment at line 306-307). This dual-maintenance burden is a direct consequence of inlining the template rather than referencing a shared skill file.

## Metadata

- **Tags:** planner, prompt-optimization, token-savings, research, skill-file
- **Complexity:** 4/10
- **Files affected:** `src/services/agentPromptBuilder.ts`, `.agents/skills/advise_research/SKILL.md` (new)
- **Shipped state:** The `adviseResearchIfUnsure` option and `ADVISE_RESEARCH_DIRECTIVE` have shipped in released versions. The config key `addons.adviseResearch` must be preserved; only the inline text changes.

## Complexity Audit

### Routine
- Creating a new skill file at `.agents/skills/advise_research/SKILL.md` containing the research-prompt template.
- Replacing the inline `ADVISE_RESEARCH_DIRECTIVE` constant with a short reference string.
- Updating the code comment that references the `planning.js` mirror.

### Complex / Risky
- The `generateResearchPrompt()` function in `planning.js` is used by the Research tab UI (copy prompt / draft with analyst buttons) and is a separate code path — it generates a user-facing research prompt from the UI input, not an agent directive. This function should NOT be changed; it serves a different purpose (interactive research prompt generation, not the planner add-on). The skill file should contain the same template structure so both stay aligned, but the JS function remains as-is.
- Existing user configs with `addons.adviseResearch: true` must continue to work — the option name and default behavior don't change, only the injected text shrinks.

## Edge-Case & Dependency Audit

1. **Config compatibility:** The `adviseResearchIfUnsure` option is read from `options?.adviseResearchIfUnsure` (line 450) and defaults to `false` in the builder, but the UI (`kanban.html:3251`) loads it as `config.addons?.adviseResearch !== false` (default-on). No config key changes — the toggle still works identically.
2. **Skill file discovery:** Agents in Antigravity autoload `.agents/` skills. Claude Code and Gemini CLI read skills when referenced by name. The short directive text must instruct the agent to read the skill file, not assume auto-loading.
3. **Test impact:** `src/services/__tests__/agentPromptBuilder.test.ts` has matches for "research" at lines 159, 161, 192, 193. These tests may assert on the presence of `ADVISE_RESEARCH_DIRECTIVE` text in the built prompt. They must be updated to assert on the new short reference string instead.
4. **planning.js mirror:** The `generateResearchPrompt()` function in `planning.js` is a separate UI-driven code path and should remain unchanged. The code comment at line 306-307 about keeping both in sync should be updated to note that the skill file is now the single source of truth for the template structure.

## Proposed Changes

### 1. Create `.agents/skills/advise_research/SKILL.md`

New skill file containing the full research-prompt template (migrated from the current `ADVISE_RESEARCH_DIRECTIVE` text):

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

Replace the ~400-word constant (lines 308-321) with a short reference:

```typescript
// References the skill file .agents/skills/advise_research/SKILL.md so the full
// research-prompt template is read on demand rather than inlined into every prompt.
export const ADVISE_RESEARCH_DIRECTIVE = `RESEARCH WHEN UNSURE: As you plan, track every assumption, factual claim, API/behavior, or library detail you are NOT 100% certain about. If any exist, read the skill file .agents/skills/advise_research/SKILL.md and follow its template to append a "## Recommended Research" section to your output. If you are confident about everything, state that no research is needed and omit the section.`;
```

### 3. Update the code comment at line 306-307

```typescript
// The full research-prompt template now lives in .agents/skills/advise_research/SKILL.md.
// The generateResearchPrompt() function in src/webview/planning.js is a separate UI-driven
// code path (Research tab) and remains independent — both share the same template structure
// via the skill file as the canonical source.
```

### 4. Update tests in `src/services/__tests__/agentPromptBuilder.test.ts`

Update any assertions that check for the full `ADVISE_RESEARCH_DIRECTIVE` text to instead check for the short reference string (e.g., assert the prompt contains "RESEARCH WHEN UNSURE" and "advise_research/SKILL.md" rather than the full template).

## Verification Plan

1. **Unit tests:** Run `npm test` (or the specific agent prompt builder test) and verify all tests pass after updating assertions.
2. **Prompt inspection:** Enable "Advise Research If Unsure" in the Kanban PROMPTS tab, copy a planner prompt, and verify the output contains the short reference line (not the full 400-word template).
3. **Skill file readability:** Confirm `.agents/skills/advise_research/SKILL.md` is readable by agents (check that the file exists at the workspace root under `.agents/skills/`).
4. **Config preservation:** Verify that toggling the checkbox off and on still correctly controls whether the directive appears in the prompt.
5. **No regression in planning.js:** Verify the Research tab "Copy Research Prompt" and "Draft with Analyst" buttons still work (they use `generateResearchPrompt()` which is unchanged).
