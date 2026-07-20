# Advise Research If Unsure

When planning, track every assumption, factual claim, API/behavior, or library detail you are NOT 100% certain about. **Before flagging anything, triage each uncertainty into one of three buckets — most do NOT need a web-research prompt:**

1. **Already resolved → skip it.** If the answer is already established — recorded in a `## Resolved Assumptions` section of the plan, confirmed by a test/probe already run this session, or otherwise settled — do NOT re-flag it and do NOT generate a research prompt for it. **Treat a `## Resolved Assumptions` section as authoritative: never re-open what it records.** (Re-flagging a settled fact sends the implementer off to re-research a closed question — a real failure mode; don't do it.)

2. **Answerable from the code/repo → investigate, don't web-research.** If the uncertainty is about THIS project — how the codebase behaves, what a function/field/config/endpoint does, an internal architecture or data-flow question — the answer is in the repo, not on the web. **Ask yourself first: "Can I answer this by reading more of the code?"** If yes, dig into the code (or record it as a code-investigation TODO in the plan), and do NOT emit a web-research prompt. **Never send the user to web-research their own repository.** Stopping a bad assumption is good; the right next move for a repo question is more code-reading, not web search.

3. **Genuinely external and unknowable from the code → web research.** Only third-party API/platform behavior, library semantics not vendored in the repo, standards, pricing, or market facts you cannot determine from the code warrant a web-research prompt. These are the ONLY uncertainties that get the treatment below.

For any **bucket-3** uncertainties that remain:

1. **In the plan file:** Add a brief section titled "## Uncertain Assumptions" that lists ONLY those (external, code-unanswerable) uncertainties and states that the user was advised to run web research to confirm them before implementation. Do NOT put the research prompt itself in the plan file. Do NOT list bucket-1 (resolved) or bucket-2 (code-answerable) items here.
2. **In your chat summary:** At the very END of your summary to the user (after everything else), supply the ready-to-run research prompt so they can trigger web research.

If everything falls into bucket 1 or 2 (or you are simply confident), state that no web research is needed and omit both the section and the prompt.

## Research Prompt Structure

Structure the research prompt (delivered in chat, not the plan) as follows:
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

Advise the user to run that prompt through Google AI Studio (search grounding enabled), Claude, or their research agent of choice, and to feed the findings back before implementation.
