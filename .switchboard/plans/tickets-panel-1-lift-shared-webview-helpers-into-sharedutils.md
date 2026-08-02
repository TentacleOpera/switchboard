# Lift the helpers Tickets shares with DOCS/HTML out of planning.js into sharedUtils.js

## Goal

Move the generic helper functions that the TICKETS tab shares with the other Artifacts tabs out of `src/webview/planning.js` and into `src/webview/sharedUtils.js`, so that a future Tickets panel can consume them without either duplicating them or dragging the rest of `planning.js` along. **No user-visible behaviour changes in this plan.**

### Problem and background

The TICKETS tab is being extracted into its own panel (see the sibling plans in this set). The blocker is not the ticket code itself — it is that ticket code calls a set of generic helpers that live in the middle of `planning.js` and are shared with the DOCS and HTML tabs.

A call-graph trace over `planning.js` (12,982 lines) found that ticket code occupies roughly 4,600 lines spread across **8 non-contiguous regions**, and that it reaches outward to a small set of non-ticket helpers. If the Tickets panel is cut without addressing these first, there are only two outcomes, both bad:

- **Copy the helpers** into `tickets.js` — now two divergent copies of escaping, overflow-menu and folder-picker logic. Escaping helpers in particular are a security-relevant thing to fork.
- **Import `planning.js` wholesale** into the new panel — defeats the entire point of the extraction and keeps the 13k-line file on the critical path of both panels.

### Root cause

`planning.js` grew as a single script for a single panel, so there was never a reason to distinguish "helper the whole panel uses" from "helper this tab uses". `sharedUtils.js` exists and already holds exactly this category of function (`escapeAttr`, `escapeHtml`-adjacent work, `renderMarkdown`, `sanitizeUrl`, `renderJsonTree`, the click-flash init) and is already injected into both the planning and design panels via a URI placeholder in `PlanningPanelProvider`, `DesignPanelProvider` and `headlessPanelHtml.ts`. The helpers below simply never got promoted into it.

### Candidate helpers

Confirmed shared (ticket code calls them; they are not ticket-specific):

- `escapeHtml` — note `escapeAttr` is **already** in `sharedUtils.js`; these two should end up co-located
- `htmlToMarkdown`
- `flashIconBtn`
- `initOverflowMenus`, `_closeAllOverflowPopovers`, `_recomputeAllOverflowTriggers`
- `persistTab` — tab-state persistence, used by every tab
- `populateWorkspaceDropdown` — the workspace picker shared by DOCS, HTML and TICKETS
- `getCurrentFolderPaths`, `renderFolderListModal`

Needs a judgement call during implementation — resolve each explicitly rather than guessing:

- **Comment helpers** (`commentAuthorName`, `commentBodyText`, `commentDateRaw`, `formatCommentDate`, `renderCommentManager`, `submitComment`, and the optimistic-insert trio `optimisticInsertComment` / `mergeOptimisticReplies` / `rollbackOptimisticComment`). The call trace shows these straddling the boundary. Determine whether the comment surface is genuinely shared with DOCS or is ticket-only. If ticket-only, they move to `tickets.js` in plan 2 instead of into `sharedUtils.js` here.
- **Mention autocomplete** (`handleMentionAutocomplete`, `handleMentionKeydown`, `closeMentionDropdown`, `extractMentionsFromText`). Same question — shared or ticket-only.
- **`renderHtmlFolderList` / `renderPlanningHtmlDocs`.** These are named for the HTML tab but appear in ticket call paths. If the coupling is incidental, leave them in `planning.js` and break the call instead of promoting HTML-tab rendering into a shared module.

The inventory above is a starting point derived from static call-graph analysis, not a contract. Verify each function's actual callers before moving it, and prefer leaving something in `planning.js` over promoting a tab-specific renderer into shared code.

## Approach

1. For each candidate, enumerate real callers across `planning.js`, `design.js`, `project.js` and the inline scripts. Classify as **shared**, **ticket-only**, or **tab-specific**.
2. Move the **shared** set into `sharedUtils.js`, preserving behaviour byte-for-byte. Do not "improve" them in this plan — a pure move keeps the diff reviewable and keeps blame useful.
3. Delete the originals from `planning.js` and let the existing `sharedUtils.js` injection satisfy the references. Confirm `planning.js` still resolves every name at load.
4. Leave **ticket-only** helpers where they are; plan 2 moves them into `tickets.js`. Leave **tab-specific** helpers in `planning.js` and note in plan 2 which ticket call sites need rewiring.
5. Record the final classification in the plan's completion notes so plan 2 does not have to re-derive it.

## Constraints

- `sharedUtils.js` is loaded by the planning **and** design panels in **both** hosts. Anything added here ships to design too — so no planning-specific globals, no assumptions about DOM ids that only exist in `planning.html`.
- Keep additions pure-function where possible. `initOverflowMenus` and `flashIconBtn` touch the DOM; follow the existing `window.__sbClickFlashInit` idempotency pattern already in the file so a double-load is harmless.
- Do not change any verb names, message shapes, or storage in this plan.

## Verification Plan

- `npm run lint` clean.
- `npm run test:contract:rendermarkdown` — guards the existing `sharedUtils.js` surface against regression from the additions.
- `npm run catalog:check` — must be unchanged; this plan touches no verbs, so any drift means something moved that should not have.
- `npm run icons:parity` — `sharedUtils.js` is reachable from panel CSS icon-class scanning; confirm no rule-coverage change.
- Load the Artifacts panel in the **VS Code host** from an installed VSIX and exercise every tab: DOCS (source filters, folder modal), HTML (previewer, inspect mode), TICKETS (list, detail, comments, overflow menus), RESEARCH, WEB AGENTS. All must behave exactly as before.
- Load `/planning` in the **standalone browser host** and repeat the same sweep. Both hosts inject `sharedUtils.js` through different code paths, so passing in one proves nothing about the other.
- Load `/design` in the browser host and confirm the design panel still functions — it shares `sharedUtils.js` and is the most likely collateral damage.
- Confirm no function was duplicated: grep each moved name and assert exactly one definition remains in the tree.

## Metadata

**Complexity:** 4
**Tags:** refactor, frontend
