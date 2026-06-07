# Add Inline Source Ban to Google AI Studio Research Prompt

## Goal

Add an explicit instruction to the generated research prompt that forbids inline source citations, ensuring the final report is clean and readable when produced by Google AI Studio.

**Problem & Root Cause:** The Research tab in `planning.html` generates a structured research prompt that users copy and paste into Google AI Studio. AI Studio does not render inline hyperlinks well — when sources are cited inline (e.g., `[text](url)` or plain URLs embedded in prose), the resulting markdown report becomes unreadable and cluttered. The prompt template currently has no rule forbidding this practice, even though the OUTPUT section already requests a "Full source list with direct links" as a separate section.

## Metadata

**Tags:** frontend, ui, ux
**Complexity:** 1

## User Review Required

- Confirm the exact wording of the inline-source ban sentence (see Proposed Changes). The current draft is: "Do not insert sources inline among the text; place all citations and links in the 'Full source list' section only."
- Confirm that the structured-prompt bypass (no auto-injection for user-supplied structured prompts) is acceptable.

## Complexity Audit

### Routine
- Single-line string append to an existing template literal in `generateResearchPrompt()`
- No logic, UI, or dependency changes

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None — this is a static template string, not async logic.
- **Security:** No impact — the prompt is client-side text generation with no external input handling.
- **Side Effects:** The generated prompt will be ~20 words longer. No character-limit or context-window risk for AI Studio.
- **Dependencies & Conflicts:** None. The `agentPromptBuilder.ts` `DEEP_RESEARCH_DIRECTIVE` is a separate prompt used by IDE agents, not Google AI Studio. No parity change needed unless requested later.

## Dependencies

None

## Adversarial Synthesis

Key risks: wording may be over-broad for non-URL inline citations (e.g., footnote-style `[1]` refs); structured-prompt users won't receive the ban automatically. Mitigations: the OUTPUT section already provides the alternative destination ("Full source list") for sources; structured-prompt bypass is intentional by design — users who write custom prompts control their own formatting.

## Proposed Changes

### `src/webview/planning.js` — `generateResearchPrompt()` (lines 3147–3193)

- **Context:** The function builds a structured research prompt as a template literal. Line 3176 contains the `SOURCE GUIDANCE` paragraph as a single continuous line of text.
- **Logic:** Append the inline-source ban sentence at the end of the SOURCE GUIDANCE paragraph (line 3176), after the existing text: `"…rather than assuming applicability."`. The new text continues the same paragraph.
- **Implementation:** At `@src/webview/planning.js:3176`, append the following to the SOURCE GUIDANCE string:

  ```
  Do not insert sources inline among the text; place all citations and links in the "Full source list" section only.
  ```

  The full modified line becomes:
  ```
  SOURCE GUIDANCE: Prefer official documentation, standards bodies, and peer-reviewed sources; distrust vendor marketing claims. Date-check all sources — flag anything older than 2 years. Separate "required" from "recommended" from "opinion" in every finding. Where law or standards are silent or ambiguous, say so rather than assuming applicability. Do not insert sources inline among the text; place all citations and links in the "Full source list" section only.
  ```

- **Edge Cases:**
  - Structured prompts (`STRUCTURED_PROMPT_RE` match at line 3156) are returned verbatim — the ban is not injected. This is by design.
  - The "Draft with Analyst Agent" flow (`btn-draft-with-analyst`) is out of scope; the analyst's prompt generation is independent.
  - `agentPromptBuilder.ts` `DEEP_RESEARCH_DIRECTIVE` is a separate system — no change needed.

## Verification Plan

### Automated Tests
- N/A — this is a static string change with no testable logic. Manual verification only.

### Manual Verification
1. Open the Planning panel → Research tab.
2. Enter a topic in the research prompt input and generate the prompt.
3. Confirm the SOURCE GUIDANCE section includes the sentence: "Do not insert sources inline among the text; place all citations and links in the 'Full source list' section only."
4. Click "COPY PROMPT TEMPLATE" and paste into a text editor — confirm the new sentence is present.
5. Test the structured-prompt bypass: paste a prompt starting with `ROLE:` or `CONTEXT:` and confirm the output is returned verbatim without the ban appended.

---

**Recommendation:** Complexity 1 → **Send to Intern**
