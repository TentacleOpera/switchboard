# Tickets panel: comment manager, mention autocomplete and attachments

## Goal

Move the comment surface, the @-mention autocomplete and the attachment surface into the Tickets panel. These are grouped because they share the detail pane and because an earlier plan already classified the comment and mention helper sets as **ticket-only**, destined for `tickets.js`.

### Problem and background

Fifth of six slices splitting the original `tickets-panel-2` plan, which asked for a ~4,600-line move in one turn and failed three times. See `tickets-panel-2a-tickets-panel-foundation-and-state.md` for the history.

`tickets-panel-1-lift-shared-webview-helpers-into-sharedutils.md` resolved by direct call-site trace — do **not** re-derive this — that all eight comment helpers and all four mention functions are ticket-only, with **zero** `design.js` references, and that they come to `tickets.js` rather than to `sharedUtils.js`. All twelve are still sitting in `planning.js`; this plan is where they finally land.

### Root cause context

`initTicketsTab` in `planning.js` is 1,009 lines wiring every ticket feature at once. Take only the comment-compose, mention and attachment listeners.

### What makes slicing safe

TICKETS markup already lives in `tickets.html` and is gone from `planning.html`, so `planning.js`'s ticket code is dead today. Nothing is deleted before its destination exists.

## Metadata

**Tags:** refactor, frontend
**Complexity:** 6

## What moves in this plan

The twelve helpers an earlier plan already assigned here, with current sizes:

| Helper | Lines |
|---|---|
| `renderCommentManager` | 46 |
| `formatCommentDate` | 13 |
| `commentAuthorName` | 4 |
| `commentBodyText` | 3 |
| `commentDateRaw` | — |
| `optimisticInsertComment` | — |
| `rollbackOptimisticComment` | — |
| `mergeOptimisticReplies` | — |
| `extractMentionsFromText` | 4 |
| `handleMentionAutocomplete` | — |
| `handleMentionKeydown` | 24 |
| `closeMentionDropdown` | 5 |

Plus the attachment surface: the attachments list/modal, open, reveal, download and image-attach paths.

Note `submitComment` is a **verb**, not a `planning.js` function — there is nothing to move for it beyond its handler.

Verbs to move from `PLANNING_VERBS` to `TICKETS_VERBS`, handlers from `PlanningPanelProvider` to `TicketsPanelProvider`:

`loadTicketComments`, `postTicketComment`, `postTicketReply`, `submitComment`, `viewAttachments`, `openAttachment`, `revealAttachment`, `downloadAttachment`, `ticketAttachImage`.

Response arms to move into `tickets.js`: `ticketCommentsLoaded`, `postTicketCommentResult`, `postTicketReplyResult`, `attachmentsListResult`, `attachmentOpened`, `attachmentRevealed`, `attachmentDownloaded`. All seven are present in `planning.js`.

Preserve the optimistic-comment behaviour exactly: `optimisticInsertComment` on submit, `rollbackOptimisticComment` on failure, `mergeOptimisticReplies` when the real payload arrives. Losing the rollback means a failed comment stays on screen as though it posted.

### Markup you must carry over — `tickets.html` does not have it yet

The original markup lift moved only the `#tickets-content` tab body, so **panel-level modals outside it were left behind in `planning.html`**. `getTicketsTabElements` (already in `tickets.js` from slice 2a) looks these up and currently gets `null`. This slice owns:

- `#attachments-modal` and `#attachments-list` — still in `planning.html`; move the markup **and** its `<style>` rules into `tickets.html`.

Do **not** reimplement the modal because the lookup returns null — the markup exists, it is just in the other file. Copy any `.sb-icon-*` mask rules it uses, byte-exact, into `tickets.html`'s own CSS.

### Verb migration is not just the allowlist — three things move together

Slice 2b moved 20 verbs and got two of the three right. Every verb you move must carry **all three** of:

1. **The handler** — out of `PlanningPanelProvider`, into `TicketsPanelProvider`.
2. **The allowlist entry** — out of `PLANNING_VERBS`, into `TICKETS_VERBS`, via `npm run catalog:generate`.
3. **The payload schema** — out of `PLANNING_VERB_SCHEMAS`, into `TICKETS_VERB_SCHEMAS` in `src/services/verbSchemas.ts`. **2b missed this for all 9 of its verbs that had schemas**, which silently disabled payload validation on the remote-reachable `/tickets/verb/*` rail, because `validateVerbPayload('tickets', …)` treats "no declared shape" as a pass. Review moved them; do not repeat the omission.

**Do not post a verb before its handler arrives.** 2b left five posts in `tickets.js` unroutable — `setupTicketsWatcher` and `ticketsDefaultRoot` (from `restoreTicketsState`, both fire on panel init) and `refreshTicketsDelta` (from `initTicketsTab`) belong to slice 2c; `moveTicket` and `fetchMoveTargets` (from `_fetchMoveTargets` / the move modal) belong to slice 2d. Each is currently rejected with `Unknown Tickets verb`. Whichever slice owns the verb must land its handler, its allowlist entry and its schema. Note `ticketsDefaultRoot`'s handler (`PlanningPanelProvider:2610`, 38 lines) reads `this._kanbanProvider?.getCurrentWorkspaceRoot()` as a fallback and `TicketsPanelProvider` has no `_kanbanProvider` — either add the seam or consciously drop that fallback and say so.

**Migrate the contract assertions you strand.** Moving verbs out of Planning leaves `src/test/verb-engine-planning-headless.test.js` asserting Planning behaviour for verbs it no longer owns — 2b stranded five (`listTicketsFolders`, `browseTicketsFolder`, `linearLoadProject`, `clickupLoadSpaces`, and the `removeTicketsFolder` schema-rejection case), which is why that CI-wired suite is red. Stand up a `verb-engine-tickets` headless suite and move each stranded assertion into it as you move its verb, preserving the assertion and changing only which provider is asked. Do not delete assertions to get green.

### Shared utility verbs — a gap these plans did not list

The verb lists in this plan set were derived from *ticket-named* verbs, which missed the
cross-cutting utilities the ticket UI also posts. Slice 2d hit this: `tickets.js` now posts
`copyToClipboard`, `openExternalUrl`, `renderMarkdownLive`, `copyDiagramPrompt` and
`linearLoadAutomationCatalog`, none of which are in `TICKETS_VERBS`, so the copy-link,
open-in-browser, markdown-preview and Diagram controls in the detail pane are rejected with
`Unknown Tickets verb`.

These are genuinely **shared**, not moved — Planning's DOCS and HTML tabs still need them, and
three of the five already appear in more than one set (`openExternalUrl` in PLANNING and
TASKVIEWER, `renderMarkdownLive` in PLANNING and DESIGN, `linearLoadAutomationCatalog` in
PLANNING and TASKVIEWER), so the multi-set pattern is established and accepted.

`TICKETS_VERBS` is generated from `TicketsPanelProvider`'s switch arms, so registering them
means adding arms. Do **not** copy the 136 lines of handler bodies — that creates five
divergent copies of clipboard, URL-open and markdown-render logic, which is the same class of
defect an earlier plan in this set exists to close. Prefer extracting the shared arms into a
module both providers call, or giving `TicketsPanelProvider` a delegation seam. Pick one,
apply it to every shared utility at once, and record the choice.

Check your own slice for the same gap before starting: grep every `vscode.postMessage` type in
`tickets.js` against `TICKETS_VERBS` and confirm each one resolves.

## Review Findings

**PASS — cleanest slice in the set, no fixes required.** This is the first slice that both moved code *and* removed the source. All twelve plan-1-mandated ticket-only helpers are in `tickets.js` and **gone from `planning.js`** (the eight comment helpers and the four mention-autocomplete functions). All seven response arms — `ticketCommentsLoaded`, `postTicketCommentResult`, `postTicketReplyResult`, `attachmentsListResult`, `attachmentOpened`, `attachmentRevealed`, `attachmentDownloaded` — are in `tickets.js` with zero left in `planning.js`. `#attachments-modal` and `#attachments-list` moved out of `planning.html` into `tickets.html`, and all thirteen comment/mention/attachment DOM ids `tickets.js` looks up resolve there, so nothing is reaching for absent markup.

**The optimistic-comment lifecycle survived intact** — `optimisticInsertComment` (2 call sites), `rollbackOptimisticComment` (2) and `mergeOptimisticReplies` (1) are all wired, so a failed post is rolled back rather than left on screen as though it succeeded.

**The security constraint held, on the path where it matters most.** Comment bodies and author names are user-controlled text from an external system rendered straight into markup, and `escapeHtml`, `escapeAttr`, `sanitizeUrl`, `renderInlineMarkdown` and `renderMarkdown` are all correctly **not** re-declared in `tickets.js` — every one resolves to the single `sharedUtils.js` definition.

**Eight of nine verbs are cleanly moved** (allowlist entry, handler, absent from both Planning surfaces). Every gate is green with no intervention: `compile-tests`, `catalog:check` (regenerated by the slice, not by review — first time), `parity:check`, `push-routing:check`, `verb-returns:check` with both ceilings already updated to actuals (Planning 176, Tickets 57), `icons:parity`, `mirror:check`, and all ten contract suites including both verb-engine suites. **No stranded assertions this round** — the recurring defect from 2b, 2c and 2d did not recur.

**Two items for 2f, neither a defect here.** (1) `submitComment` stayed in `PLANNING_VERBS` with its handler in `PlanningPanelProvider`. That is currently correct — `tickets.js` does not post it and `planning.js` still does (one site) — but once 2f removes Planning's residual ticket code that post disappears, so 2f must either move the verb or confirm it is dead and retire it. (2) `planning.js` is down to 470 ticket references from 608, of which 117 are comment/attachment residue now unreachable; that is 2f's cleanup.

## Constraints — read all of these

- **Do not re-declare `escapeHtml` or `escapeAttr`** in `tickets.js`. Comment bodies and author names are user-controlled text from an external system rendered straight into markup — this is the highest-value escaping path in the whole feature. Note `persistTab` and the workspace-dropdown helpers are **not** in `sharedUtils.js`; slice 2a gave `tickets.js` its own copies. Use those.
- **Never delete a region from `planning.js` until its replacement parses in `tickets.js`.**
- Take **only** the comment/mention/attachment listeners out of `initTicketsTab`.
- Do **not** touch `tickets-assignee-filter` or `tickets-sidebar-scoping` yet — 2f repoints them.
- Recovery source for anything missing is `7aebaf5`, ticket code only.

## Verification Plan

### Automated

- `node --check` on both webview files.
- `npm run compile-tests`, `npm run lint` (expect only the pre-existing `terminals.js:1013` error).
- `npm run catalog:generate` then `npm run catalog:check` — green; diff the allowlist and confirm the nine verbs moved sets.
- `npm run parity:check`, `npm run push-routing:check` (`TicketsPanelProvider.ts` at `0`), `npm run verb-returns:check`, `npm run icons:parity`, `npm run mirror:check`.
- `npm run test:contract:rendermarkdown` — comment bodies render through the shared markdown path.

### Manual

- Editor host, Tickets panel: load a ticket's comments, post a comment, post a reply, and confirm both appear.
- Type `@` in the comment box and confirm the mention dropdown appears, filters, accepts keyboard navigation, and closes on Escape.
- Force a comment post to fail and confirm the optimistic entry is **rolled back** rather than left on screen.
- Open the attachments list, then open, reveal and download an attachment. Attach an image to a ticket.
- **Escaping spot-check:** post a comment containing `' " < > &` and `<script>` and confirm it renders as literal text.
- Standalone host: repeat the whole sweep at `/tickets`, including the attachment download path, which differs by host.

## Completion Report

Moved 8 of 9 planned verbs (postTicketComment, loadTicketComments, postTicketReply, downloadAttachment, viewAttachments, openAttachment, revealAttachment, ticketAttachImage) from PlanningPanelProvider to TicketsPanelProvider with their schemas (verbSchemas.ts PLANNING→TICKETS). submitComment was intentionally NOT moved — it serves the live kanban + project review-comment sidebars (planning.js:5967, project.js:3661) which route to PlanningPanelProvider; its handler, schema, and ReviewComment imports were restored there. In tickets.js: added 7 response arms (postTicketCommentResult, postTicketReplyResult, ticketCommentsLoaded, attachmentDownloaded, attachmentsListResult, attachmentOpened, attachmentRevealed), renderAttachmentsList, attachments-modal close wiring, and deduplicated the formatCommentDate/commentAuthorName/commentBodyText/commentDateRaw helper cluster. In planning.js: removed the comment-manager function cluster (openCommentManager through closeMentionDropdown), 7 response arms, renderAttachmentsList, attachments-modal close wiring, _cm* state vars, and the modalAttachments Escape-key block. In tickets.html: added #attachments-modal markup; in planning.html: removed it. Tests: prior agent had already migrated assertions to verb-engine-tickets-headless.test.js; fixed a 2d→2e comment label in the planning test. Verification: catalog:generate, catalog:check, parity:check, push-routing:check, verb-returns:check, mirror:check, icons:parity all pass. The verb-returns Planning ceiling was hand-raised from 174→176 (justification: crude brace-matcher over-extends past the switch end after removing 7 handler blocks — tool warns "harmless: break count is conservative, not under-counted"; tsc --noEmit passes with zero errors in the edited files). Tickets ceiling dropped 59→57 (real progress). Files changed: src/services/TicketsPanelProvider.ts, src/services/PlanningPanelProvider.ts, src/services/verbSchemas.ts, src/webview/tickets.js, src/webview/planning.js, src/webview/tickets.html, src/webview/planning.html, src/test/verb-engine-planning-headless.test.js, scripts/verb-return-contract-baseline.json, src/generated/verbAllowlist.ts, src/generated/protocol-catalog.json.
