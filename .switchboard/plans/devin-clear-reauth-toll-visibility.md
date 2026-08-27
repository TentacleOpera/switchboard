# Explain the seat-clear session-restart toll where seat CLIs are configured

## Goal

Add a short, permanent explanatory note in the AGENTS tab — where an operator
configures which CLI a seat runs — stating that clearing a seat restarts that
seat's CLI session, that a restarted session re-initialises its MCP servers, and
that OAuth-backed MCP servers therefore prompt for authorisation again.

This is **static informational copy**. It adds no runtime detection, no event
surface, and no interruption of any kind.

### Root cause analysis

The browser-spam symptom is **not** a bug in the clear logic, a broken token, or a
misconfigured MCP server. It is an unpriced, invisible cost of correct behaviour:

1. **Switchboard clears a seat when its work context changes.**
   `src/services/TaskViewerProvider.ts:816-826` gates the clear on
   `lastWorkKey !== workContextKey` (`featureId ?? planId`). The comment at :819 is
   explicit that two subtasks of one feature are one work context and deliberately
   do *not* clear between them. **This gating is already correct and already
   minimal — it is not the defect and must not be touched by this plan.**

2. **For Devin, a clear is a full session restart, not a buffer wipe.**
   `src/standalone/clearReadiness.ts:146-180` documents the observed state machine:
   old-session bracketed-paste teardown (`\x1b[?2004l`), then re-enable
   (`\x1b[?2004h`), then cursor/sync re-establishment — a session transition, not a
   screen clear. `src/standalone/ptyHost.ts:182` corroborates: the CLI emits
   "Devin is resetting context."

3. **A new session re-initialises MCP servers**, so every OAuth-backed MCP re-runs
   its auth flow and opens a browser.

4. **The toll is linear in useful work** — roughly (context switches) × (seats).
   Devin's own one-auth-per-set guard collapses only prompts that *collide in
   time*; it does nothing about prompts spread across a batch. This is why
   re-authenticating never "sticks": the operator is not repairing a broken
   credential, they are paying a toll per context switch.

5. **Nothing in Switchboard says any of this.** No note, no docs. The reported cost
   of that silence was several weeks of unattributed confusion.

The defect being fixed is **(5)**, and only (5). Points 1-4 work as designed.

### Why static copy rather than a runtime notice

An earlier draft of this plan proposed detecting each cost-bearing clear and
surfacing it — a webview banner, a first-run explainer, a session-log line. That
was rejected, correctly:

- The event is **constant and expected**. A notice on every occurrence — even
  rate-limited — is spam in a new medium, and trains the operator to ignore the
  surface that was supposed to inform them.
- The operator does not need a per-event record. They need to **know the rule
  once**. After that, no individual clear needs attributing.

Discarding runtime detection also removes this change's entire risk surface. Two
composition-root divergence traps were found during analysis, and **both become
moot** once nothing is wired at runtime. They are recorded here so a future
implementer does not rediscover them the hard way:

- `src/services/hostSeams.ts:299` — `onData: () => ({ dispose: () => {} })`. VS
  Code's terminal API exposes no output stream, so detecting an OAuth prompt by
  scraping terminal output is standalone-only and can never reach parity.
- `src/standalone/vscodeShim.ts:189` — `showInformationMessage` returns
  `undefined` and displays nothing on standalone, while `hostSeams.ts:369` is real
  on the extension host. Any notification-based surface ships to one host and
  silently vanishes on the other.

**Neither applies to this plan.** The webview is rendered by both hosts from the
same source (`src/services/headlessPanelHtml.ts`), so static copy reaches both
roots with no seam, no wiring, and no parity audit required.

### Non-goals (do not implement any of these)

- **No banner, toast, notification, modal, or first-run explainer.** Explicitly
  rejected. The whole point of this revision is that the surface is passive.
- **No session-log line and no runtime detection.** No new code at the clear
  decision point. No `deriveCliFamily` call, no cost model, no new module.
- **No change to clear behaviour.** Do not suppress, defer, batch, or gate the
  clear. The `:816-826` decision is out of scope entirely.
- **No confirmation dialog.** See the repo-wide prohibition in `CLAUDE.md`.
- **No browser suppression** (e.g. `BROWSER=/bin/true`) and **no stripping of MCP
  servers from seat profiles** — both considered and rejected by the operator.

## Implementation

### 1. The note in the AGENTS tab

Add a short static note to the AGENTS tab in `src/webview/kanban.html`, placed
next to the startup-command configuration — the custom-agent command field
(`agents-tab-custom-agent-command`, ~:4493-4520) is the control that determines
which CLI a seat runs, and therefore whether the operator pays this toll. Place
the note where that decision is made, not in a general help section.

Content requirements — keep it to roughly two sentences:

- Clearing a seat restarts that seat's CLI session.
- A restarted session re-initialises its MCP servers, so OAuth-backed MCP servers
  prompt for authorisation again.
- State plainly that this is expected and recurs per work-context switch — this is
  the sentence that ends the "my token must be broken" misdiagnosis, and it is the
  most load-bearing line in the change.

Style: match the existing informational-note styling already used in the tab. Do
not introduce a new visual treatment, an icon, or a warning colour — this is
neutral information, not a problem.

**Do not name specific CLIs.** The note describes seat behaviour, so it stays
correct as agents are added or change, and needs no maintenance.

**State it flatly — do not hedge.** Write "clearing a seat restarts its CLI
session", not "some agents may restart". Vague phrasing is what made this
invisible in the first place, and a reader cannot act on a maybe. Describing the
behaviour in the general case is not the same as softening it.

### 2. Documentation

Add a short paragraph to the docs covering the same explanation, so it is findable
by search as well as in the panel. Keep it factual: this change delivers
visibility, not a reduction in prompts.

## Verification Plan

This is a copy-only change, so verification is correspondingly small — but the
both-hosts check still applies, because "the webview is shared" is an assumption
worth confirming once rather than trusting.

1. **Extension host.** Open the AGENTS tab. The note renders, is legible in both
   light and dark themes, and does not disrupt the tab's existing layout.

2. **Standalone host.** Open the same tab under the standalone/npx host and
   confirm the identical note renders. This confirms the shared-webview assumption
   that lets this plan skip a composition-root audit.

3. **Copy accuracy.** A reader who has never seen this problem can answer, from
   the note alone: *why does my agent keep asking me to log in?* If they cannot,
   the copy has failed its only job — rewrite it.

4. **No runtime code added.** `git diff` touches only `src/webview/kanban.html`
   and the docs file. Any change to `TaskViewerProvider.ts`, `hostSeams.ts`,
   `cliIdentity.ts`, or either composition root means the implementation drifted
   back toward the rejected runtime design and must be reverted.

5. **Anti-regression — no confirm gate.** Grep the diff for `confirm(`,
   `window.confirm`, and modal `showWarningMessage`. Any hit is a defect per
   `CLAUDE.md`.

## Metadata

**Complexity:** 2
**Tags:** ux, docs, authentication, cli
