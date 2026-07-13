# Advise Research If Unsure

When planning, track every assumption, factual claim, API/behavior, or library detail you are NOT 100% certain about. If any exist:

1. **In the plan file:** Add a brief section titled "## Uncertain Assumptions" that lists ONLY those uncertainties and states that the user was advised to run web research to confirm them before implementation. Do NOT put the research prompt itself in the plan file.
2. **Build the research prompt** using the structure below.
3. **Try to hand it to an active Researcher agent** (see "Researcher Hand-Off") — but ONLY if your directive includes the hand-off instructions. When no Researcher agent is configured, your directive will tell you to skip this step and go straight to step 4.
4. **Otherwise, in your chat summary:** At the very END of your summary to the user (after everything else), supply the ready-to-run research prompt so they can trigger web research themselves.

If you are confident about everything, state that no research is needed and omit the section, the hand-off, and the prompt.

## Researcher Hand-Off

> **Only applies when a Researcher agent is configured.** The prompt builder checks at prompt-build time whether a researcher-role agent is configured and includes the hand-off instructions only when one is. If your directive does not mention the hand-off, skip this section entirely and go to the chat-summary fallback.

Before showing the research prompt to the user, try to hand it directly to an active Researcher agent via the Switchboard HTTP server. This delegates the actual research instead of making the user run it manually.

1. Read the port from `.switchboard/api-server-port.txt` (relative to the workspace root). If the file is missing, skip the hand-off and fall back to the chat-summary prompt.
2. POST the prompt to `http://127.0.0.1:<port>/research/dispatch` with a JSON body `{"workspaceRoot":"<absolute workspace root>","prompt":"<the full research prompt>"}`. Build the JSON safely — write the prompt to a temp file and pipe it through `jq -Rs` or `python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'`. Never hand-escape newlines. If neither tool is available the POST will fail and you fall back to chat-paste.
3. The server signals the outcome with the HTTP status code AND the `dispatched` field — there is NO `success` field, so do NOT key on one:
   - HTTP 200 + `{"dispatched":true,"researcher":"...","savePath":"..."}` → the prompt was forwarded to the Researcher agent, which was told to save its findings to `savePath` (the configured or default research-docs folder). Tell the user you handed the research to the Researcher agent and that it will attempt to save its findings to `savePath`. Do NOT paste the full prompt into your summary.
   - HTTP 200 + `{"dispatched":false,"reason":"..."}` → a researcher is configured but not live (soft failure). Fall back: supply the ready-to-run research prompt at the very end of your chat summary.
   - Any other non-200 status, a request failure, or a missing port file → fall back to the chat-summary prompt. (A 404 means no researcher is configured — rare since the directive only includes the hand-off when one is, but possible if config changed between prompt-build and execution.)
   - Only announce a hand-off if the HTTP status is 200 AND the body contains `"dispatched": true`. Do NOT key on a `success` field.

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

## After Generating (fallback path only)

If the Researcher hand-off did not dispatch and you supplied the prompt in chat, advise the user to run it through Google AI Studio (search grounding enabled), Claude, or their research agent of choice, and to feed the findings back before implementation.
