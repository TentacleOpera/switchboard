# Tickets Diagram Prompt: Strip URL and Ticket ID from Prompt Header

## Goal

Remove the external URL and provider ticket ID from the diagram prompt header in the Tickets tab. The prompt is meant for agents that only edit local markdown files — including the external ClickUp/Linear URL and the API ticket ID as standalone metadata leaks external API context into a local-file-only workflow and risks misleading the agent into making API calls instead of simply editing the local `.md` file.

### Problem & Background

The "Diagram" button (`btn-diagram-prompt`) in the Tickets tab action bar copies a prompt to the user's clipboard for agent handoff. The prompt instructs the agent to generate a Mermaid diagram, render it to PNG, find the ticket's local markdown file, save the PNG alongside it, and insert an inline image reference into the markdown. The user then clicks "Push" to upload the image to the provider.

The prompt's header section currently includes five metadata fields:

```
Ticket: ${title}
URL: ${ticketUrl}
ID: ${id}
Provider: ${provider}
Workspace: ${workspaceRoot}
```

The `URL` and `ID` fields are problematic:
- **URL** — The agent never needs to browse to the external ClickUp/Linear URL. Its entire job is local file manipulation. Including the URL suggests the agent should interact with the external provider, which it should not.
- **ID** — The API ticket ID as standalone header metadata serves no purpose for a local-file-only agent. The ID *is* needed in step 4 of the instructions (the filename prefix pattern `${provider}_${id}_`), but presenting it as a top-level metadata field encourages the agent to use it for API calls rather than just file lookup.

### Root Cause

The diagram prompt was originally authored in the plan `tickets-diagram-prompt-button.md` with the URL and ID included as "ticket context" — a reasonable instinct at authoring time, but in practice these fields violate the Tickets tab's local-file-only contract. The prompt builder computes `ticketUrl` via `_ticketExternalUrl()` and interpolates both `ticketUrl` and `id` into the header. The `_ticketExternalUrl` call at that site is only needed for this prompt — removing it eliminates the URL from the prompt entirely.

> **Superseded:** the Root Cause's line citations — "the prompt builder at `tickets.js:4901-4929` … computes `ticketUrl` … (line 4910) and interpolates both `ticketUrl` and `id` into the header (lines 4916-4917)".
> **Reason:** stale by ~48 lines against HEAD; `tickets.js:4901-4929` is now the ticket
> **edit-save** handler and the Push/Delete/Comment action-bar handlers, not the diagram
> prompt. An implementer following those numbers would edit the wrong code.
> **Replaced with:** the diagram-prompt click handler is `tickets.js:4950-4978`;
> `ticketUrl` is computed at `tickets.js:4958`; the header template is
> `tickets.js:4961-4967`, with `URL:` at 4964 and `ID:` at 4965.

> **Superseded:** "The `_ticketExternalUrl` call is only needed for this prompt —
> removing it eliminates the URL dependency entirely."
> **Reason:** ambiguous and, read as written, wrong — it invites deleting the function.
> `_ticketExternalUrl` (`tickets.js:567-571`) has three call sites, two of which stay:
> the ClickUp sidebar card (`tickets.js:620`) and the Linear sidebar card
> (`tickets.js:657`).
> **Replaced with:** only the **call at `tickets.js:4958`** is removed. The function and
> its two card-rendering callers are untouched.

## Metadata

**Complexity:** 2
**Tags:** frontend, bugfix, ui
**Project:** Browser Switchboard

## User Review Required

- None.

## Complexity Audit

### Routine
- Removing two lines (`URL:` and `ID:`) from a template string in `tickets.js`
- Removing the now-unused `ticketUrl` variable and its `_ticketExternalUrl()` call (one line)
- No new logic, no new branches, no API changes, no data model changes
- No verb surface change: `copyDiagramPrompt` already exists in `TICKETS_VERBS` and
  `PLANNING_VERBS`, and the payload shape (`{ type, prompt }`) is unchanged, so
  `verbSchemas.ts`, `protocol-catalog.json`, and `src/generated/verbAllowlist.ts` are
  all untouched. No `npm run catalog:generate` needed.
- Single source of truth confirmed: repo-wide grep for `Generate an architectural
  diagram` and `copyDiagramPrompt` finds exactly one prompt builder
  (`tickets.js:4961`). `planning.js` has no copy, so there is no parallel string to
  keep in sync and no host divergence (`tickets.html`/`tickets.js` are served to both
  the extension host and the standalone `npx` host via `headlessPanelHtml.ts`).

### Complex / Risky
- None — the change is purely subtractive (removing fields from a string template and one variable assignment).

## Edge-Case & Dependency Audit

### Race Conditions
- None. The handler is a synchronous string build followed by one `postMessage`; no
  timers, no async ordering, no shared mutable state.

### Security
- Strictly reducing: the clipboard payload stops carrying an external URL. Nothing new
  is interpolated, no new input is trusted.

### Side Effects
- **Filename pattern still uses `id`:** the `id` variable must remain in scope because
  step 4 of the instructions references it in the filename prefix pattern
  `` `${provider}_${id}_` `` (`tickets.js:4973`). Only the header `ID:` line is
  removed; the `id` declaration (`tickets.js:4956`) stays.
- **`_ticketExternalUrl` must not be deleted:** it is still used by sidebar card
  rendering at `tickets.js:620` (ClickUp) and `tickets.js:657` (Linear). Only the call
  at `tickets.js:4958` is removed.
- **`providerName` in step 7:** step 7 says "I will click 'Push' … which will
  automatically upload the image to `${providerName}` and rewrite the URL"
  (`tickets.js:4976`). This is informational context telling the agent *not* to upload,
  not an instruction to use the URL. Keep it — and keep `providerName` in scope.
- **Clipboard handler:** `handleCopyDiagramPrompt` (`sharedUtilityVerbs.ts:66-84`)
  validates only that `prompt` is a non-empty string, then writes it to the clipboard
  via the seam. It never inspects the content. Unchanged.

### Dependencies & Conflicts
- **Stale reference in `planning.js`:** `planning.js:1522` still caches
  `btnDiagramPrompt` via `getElementById('btn-diagram-prompt')`, but the button now
  lives only in `tickets.html:4005` (it moved during the panel extraction). Pre-existing
  stale reference, not caused by this change. Optional cleanup — noted, out of scope.
- **Agent API modal capabilities:** the `AGENT_API_CAPABILITIES` object in `tickets.js`
  has its own "Generate an architecture diagram" entries referencing `{ticketId}` and
  `POST /diagram/generate`. Those are deliberately API-facing (Agent API modal, not the
  action bar) and are a different surface. Not affected.
- **Conflicts:** `tickets.js` is also edited by the source-nav-arrows plan
  (`feature_plan_20260806161531`) and the auto-refresh plan
  (`feature_plan_20260806153624`). Different regions, same file — per PRD orchestration
  discipline, serialise the streams.
- No external dependencies, no new packages.

## Dependencies

- None. No prior session work is required; no `sess_*` prerequisites.

## Adversarial Synthesis

**Risk Summary.** The mechanical risk is near zero — two template lines and one
variable assignment, in a handler with a single call site and no async behaviour; the
only way to break it is to delete `_ticketExternalUrl` (still used by two sidebar
renderers) or the `id`/`providerName` variables (still used by steps 4 and 7). The real
risk is one of efficacy rather than correctness: the prompt still names the provider and
still embeds the raw ticket id inside step 4's filename pattern, so removing the header
fields lowers the salience of the API path without closing it. Mitigation: implement the
subtraction exactly as specified, and consider the labelled Clarification below — a
single explicit "edit local files only, do not call the provider API" line — which turns
an implicit signal into an explicit constraint.

## Proposed Changes

### `src/webview/tickets.js` — Remove URL and ID from prompt header

**Context:** the diagram prompt click handler is `tickets.js:4950-4978`. It builds a
template string with a header section (Ticket, URL, ID, Provider, Workspace) and an
instructions section (steps 1-7).

**Change 1: Remove the `ticketUrl` variable (`tickets.js:4958`)**

`ticketUrl` is computed via `_ticketExternalUrl()` and used only in the prompt header.
After removing the `URL:` line it becomes dead code.

```javascript
// BEFORE (tickets.js:4956-4960):
const id = isLinear ? issue.issue.id : issue.task.id;
const title = isLinear ? (issue.issue.title || issue.issue.identifier || id) : (issue.task.name || issue.task.title || id);
const ticketUrl = _ticketExternalUrl(provider, isLinear ? (issue.issue.identifier || id) : id, isLinear ? issue.issue.url : issue.task.url);
const workspaceRoot = ticketsWorkspaceRoot;
const providerName = isLinear ? 'Linear' : 'ClickUp';

// AFTER:
const id = isLinear ? issue.issue.id : issue.task.id;
const title = isLinear ? (issue.issue.title || issue.issue.identifier || id) : (issue.task.name || issue.task.title || id);
const workspaceRoot = ticketsWorkspaceRoot;
const providerName = isLinear ? 'Linear' : 'ClickUp';
```

**Change 2: Remove `URL:` and `ID:` from the prompt template (`tickets.js:4964-4965`)**

```javascript
// BEFORE (tickets.js:4961-4967):
const prompt = `Generate an architectural diagram for this ticket and attach it inline.

Ticket: ${title}
URL: ${ticketUrl}
ID: ${id}
Provider: ${provider}
Workspace: ${workspaceRoot}

// AFTER:
const prompt = `Generate an architectural diagram for this ticket and attach it inline.

Ticket: ${title}
Provider: ${provider}
Workspace: ${workspaceRoot}
```

Everything from `Instructions:` (`tickets.js:4969`) onward is unchanged. `id` remains in
scope and is still interpolated by step 4's filename pattern at `tickets.js:4973`;
`providerName` remains in scope for step 7 at `tickets.js:4976`.

**Edge cases:**
- ClickUp tickets with no `task.url`: previously `_ticketExternalUrl` synthesised
  `https://app.clickup.com/t/<id>`; now nothing is emitted. Intended.
- Linear tickets with no `issue.url`: previously the `URL:` line rendered empty
  (`_ticketExternalUrl` returns `''` for non-ClickUp with no url); the blank line goes
  away with it. A small readability improvement, not a behaviour change.
- Local-only tickets (never synced): same as above — no more empty `URL:` line.

**Clarification (optional, recommended — not a new requirement).** The Goal states the
prompt "risks misleading the agent into making API calls". Subtracting the header fields
reduces that risk but does not eliminate it: the prompt still names the provider, and
step 4 still contains the literal ticket id. If the intent is to *close* the API path
rather than merely de-emphasise it, add one explicit line under `Instructions:`:

```
0. Work entirely on local files. Do not call the ClickUp or Linear API — the ticket id below is for locating the local markdown file only.
```

This is a one-line addition strictly implied by the existing Goal; it is called out
separately so the implementer can take it or leave it without ambiguity about scope.

**No other files need changes.** `handleCopyDiagramPrompt` (`sharedUtilityVerbs.ts:66-84`)
and the `copyDiagramPrompt` arms in `TicketsPanelProvider.ts:3536-3537` and
`PlanningPanelProvider.ts:4841-4842` are pass-through — they write whatever prompt
string they receive to the clipboard without inspecting it.

## Verification Plan

### Manual Verification
1. Open the Switchboard tickets panel and load tickets from ClickUp or Linear
2. Select a ticket — verify the "Diagram" button appears in the overflow menu
3. Click "Diagram" — verify the "Diagram prompt copied to clipboard" notification appears
4. Paste into a text editor — verify the prompt header contains only `Ticket:`, `Provider:`, and `Workspace:` — NO `URL:` or `ID:` lines, and no stray blank line where they were
5. Verify step 4 of the instructions still contains the filename prefix pattern with the ticket ID (e.g., `clickup_abc123_`)
6. Verify step 7 still mentions the provider name and the Push flow
7. Switch to the other provider (Linear ↔ ClickUp) and repeat steps 2-6
8. Repeat step 3-4 for a **local-only** ticket (never synced) — confirm the prompt is well-formed with no empty metadata line
9. Repeat once in the browser host over `npx switchboard` — the panel assets are shared, so this confirms the shared-HTML assumption rather than a second code path

### Regression Check
- Confirm `_ticketExternalUrl` is **not** deleted — still used by sidebar card rendering at `tickets.js:620` and `tickets.js:657`. Spot-check that ticket cards still render their "Open" affordance for both providers.
- Confirm the `id` variable is still declared (`tickets.js:4956`) — needed for step 4's filename pattern
- Confirm `providerName` is still declared — needed for step 7

### Automated Tests

Not run in this pass (SKIP TESTS / SKIP COMPILATION session directives). For the
implementer:

- `tsc --noEmit` is a no-op for this change (`tickets.js` is plain JS, not typechecked),
  but confirms nothing else broke. Do **not** run `npm run compile` as verification —
  per the repo build rule, `dist/` is not used in development or testing.
- No gate is affected: no verb, schema, catalog, push-routing, or return-contract
  surface changes. `npm run verb-returns:check` / `parity:check` / `catalog:check`
  should be unchanged, and re-running them is optional reassurance only.
- No existing test asserts the diagram prompt's text (repo-wide grep for
  `copyDiagramPrompt` finds no test file), so there is no test to update. If one is
  added, the highest-value assertion is that the generated prompt contains
  `` `${provider}_${id}_` `` in step 4 while containing neither `URL:` nor a standalone
  `ID:` header line.

## Recommendation

**Send to Intern** (Complexity 2).

## Completion Report

Implemented the subtractive change in `src/webview/tickets.js` (diagram-prompt click handler, now lines 5100-5126): removed the `ticketUrl` variable and its `_ticketExternalUrl()` call, and removed the `URL:` and `ID:` lines from the prompt header so it now carries only `Ticket:`, `Provider:`, and `Workspace:`. Also added the recommended clarification as instruction step 0 ("Work entirely on local files. Do not call the ClickUp or Linear API…") to explicitly close the API path per the Goal. The `id` variable (step 4 filename pattern) and `providerName` (step 7 Push flow) remain in scope; `_ticketExternalUrl` is untouched and still serves its two sidebar card-rendering callers. No other files changed. No issues encountered. Line citations in the plan were stale by ~160 lines (handler is at 5100, not 4950) — corrected against the live file before editing.

## Review Findings

Reviewed `src/webview/tickets.js` (only file changed; handler now at 5120-5147) — no CRITICAL or MAJOR findings, no code fixes applied. All three plan-named regression guards hold: `_ticketExternalUrl` retained with its two live sidebar callers (`tickets.js:623`, `660`), `id` still declared and interpolated by step 4's `${provider}_${id}_` prefix, `providerName` still used by step 7; zero residual `ticketUrl` references, single prompt builder repo-wide, and step 4's filename pattern independently confirmed correct against `TaskViewerProvider.ts:21878`. Verification (run independently — the plan's SKIP-TESTS note is a record, not a directive): eslint clean, `node --check` OK, `compile-tests` (tsc) clean, `catalog:check` no drift, `parity:check` pass, `verb-returns:check` pass, `verb-engine-tickets` 31/31, `panel-runtime-surface` pass; all three plan-named gates confirmed CI-invoked at `.github/workflows/integration-tests.yml:26/35/41`. Remaining risks are NIT-only and pre-existing panel-extraction litter explicitly scoped out by the plan: `planning.js:1522/8299/8683` still cache and toggle a `btn-diagram-prompt` that exists only in `tickets.html`, and `PlanningPanelProvider.ts:4841`'s `copyDiagramPrompt` arm is now unreachable (removing it would require catalog regeneration). The added step 0 is the plan's sanctioned optional clarification, taken verbatim.
