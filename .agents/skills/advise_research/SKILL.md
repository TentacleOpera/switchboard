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
