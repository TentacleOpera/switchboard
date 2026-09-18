# Plan: Design System #6 — "Copy Design System Prompt" Button for the Iterative Design Loop

## Goal
Add a **Copy Design System Prompt** button to the Design System tab that copies a ready-to-paste prompt describing the project's design system — the `DESIGN SYSTEM` block with its real token values — so it can be dropped straight into an ad-hoc agent conversation. This serves the way design work is actually done: iterating with an agent on a prototype, bit by bit, against a rendered preview, outside any dispatched plan.

### Problem Context
Plans #2–#5 deliver the design system into *generated* prompts (planner, coder, reviewer, Copy Prompt on a plan card). None of that helps the most common design workflow: an open chat with an agent, refining a prototype step by step, with no plan and no dispatch involved. In that loop there is currently **no way to hand the agent the design system** short of manually finding the file and pasting its contents — which is exactly what makes the tab feel like it does nothing to help.

The affordance does not exist. The only trace in the design panel is two orphaned CSS rules — `.kanban-plan-copy-prompt` (`src/webview/design.html:2362`, `:2374`) — with no button markup and no handler anywhere in `design.js` (verified: zero references in `design.js`). The pattern itself is well established elsewhere in the product (the board's Copy Prompt buttons), so this is a missing application of an existing idiom, not new ground.

### Root Cause Analysis
- **Delivery was modelled only on dispatch.** Every design-system path assumed a plan and a generated prompt, so the surface used for iterative prototyping was never given an entry point.
- **The tab has one verb.** A design doc's only action is "Set as Active" — nothing lets the user *use* the design system they are looking at.

## Metadata
- **Tags:** frontend, ui, ux, feature
- **Complexity:** 4

> **Superseded:** Complexity: 3.
> **Reason:** The change is a three-file, cross-layer slice — webview markup, webview handler, and a new `DesignPanelProvider` message that reads a file, runs #3's extractor, and calls #2's builder — plus a resolution rule (project-bound vs. selected doc). Multi-file coordination with a message protocol sits at 4, not "routine single-file".
> **Replaced with:** Complexity: 4 (low; every piece reuses an established idiom).

## User Review Required
- **None.** Settled: the button copies the same `DESIGN SYSTEM` block the dispatch paths emit (authoring framing, token table included), so the iterative loop and the dispatched loop give the agent identical information.

## Complexity Audit

### Routine
- Add the button to the Design System tab's controls strip next to the existing bind action, reusing the orphaned `.kanban-plan-copy-prompt` styling already present at `design.html:2362`.
- Add the click handler and a copied-confirmation state in `design.js`.

### Complex / Risky
- **Build the prompt server-side, not in the webview.** The block must come from the same `buildDesignSystemBlock` used by dispatch (#2), or the two loops drift and the copied prompt stops matching what agents receive on dispatch. Add a `DesignPanelProvider` message that returns the built block; do not reimplement the framing in `design.js`.
- **Clipboard in a webview.** Use the established copy path used by the product's other Copy Prompt buttons rather than a bare `navigator.clipboard` call, which is unreliable under the webview's permissions.
- **Which design system to copy.** Prefer the project-bound one (#4); fall back to the currently-selected doc in the tree when nothing is bound, so the button is useful before any binding exists.
- **No confirmation dialog.** Per project rules the button acts immediately; feedback is an inline copied state, never a modal.

## Edge-Case & Dependency Audit

- **Race Conditions:** The user can change the selected doc (or unbind) while a `copyDesignSystemPrompt` request is in flight — include the requested doc/project identity in the request and echo it in the response so a stale response is ignored rather than copying the wrong system's block.
- **Security:** Clipboard write via the established webview copy path; the copied content is the same prompt text dispatch already emits — no new boundary.
- **Side Effects:** None persistent — the handler reads, builds, and returns; it writes nothing. The button's inline copied state must not disturb the controls strip layout shared with #4's bind control and #7's create button.
- **Dependencies & Conflicts:** Depends on #2 (block + authoring framing) and #3 (token table; also the source of the HTML-detection/extraction the handler reuses). Uses #4's binding when present; degrades to selected-doc without it. Shares `DesignPanelProvider.ts` and `design.{html,js}` with #4/#7 — disjoint handlers, shared controls strip (cosmetic coordination only).

## Dependencies
- **Depends on #2** (the block and its authoring framing) and **#3** (the token table that makes the copied prompt concrete). Uses **#4**'s per-project binding to know which design system to copy.
- Independently shippable once #2 and #3 land; without #4 it can copy the currently-selected doc instead of the project-bound one.

## Adversarial Synthesis
The one structural risk is divergence between the copied prompt and the dispatched prompt, prevented by building both from `buildDesignSystemBlock` server-side rather than duplicating framing in the webview. Remaining risks are small: a stale in-flight response copying the wrong doc (mitigated by request/response identity echo) and webview clipboard flakiness (mitigated by reusing the product's established copy path).

## Proposed Changes

### `src/webview/design.html`
1. Add a **Copy Design System Prompt** button to the Design System tab controls strip, styled with the existing `.kanban-plan-copy-prompt` rules (`:2362`, `:2374`).

### `src/webview/design.js`
1. Handler posts a `copyDesignSystemPrompt` message with the active workspace/project and the selected doc.
2. On response (matched to the request's doc/project identity), write to the clipboard via the established webview copy path and show an inline copied state.

### `src/services/DesignPanelProvider.ts`
1. Handle `copyDesignSystemPrompt`: resolve the design system (project-bound per #4, else the selected doc), read it, run #3's extractor when it is HTML, and return `buildDesignSystemBlock({ mode: 'author', … })` from #2.

## Verification Plan

### Automated Tests
- `npm run compile`.
- Assert the returned prompt string is produced by `buildDesignSystemBlock` (same header and framing as the dispatch path) and, for an HTML design system, contains the token table.

### Manual Verification
1. Bind `viaapp-design-system.html` to a project, click Copy Design System Prompt, paste into an agent chat; confirm the pasted block carries real token values grouped by scheme.
2. Confirm the pasted block is identical to what a dispatched coder receives for the same project.
3. With nothing bound, select a design doc in the tree and confirm the button copies that doc's block.
4. Confirm the button copies immediately with inline feedback and no dialog.

## Risk Assessment
- **Low.** A new button plus a message handler, reusing an existing prompt builder, an existing CSS class, and an existing clipboard path. The one real risk is divergence between the copied prompt and the dispatched prompt, which is prevented structurally by building both from `buildDesignSystemBlock` rather than duplicating the framing in the webview.

**Recommendation:** Send to Coder

## Completion Summary
Added "Copy Design System Prompt" button to Design System tab top controls strip in `src/webview/design.html`. Handled `copyDesignSystemPrompt` in `src/services/DesignPanelProvider.ts` to resolve project-bound or active/selected design doc, construct `buildDesignSystemBlock` with extracted tokens and authoring framing, and copy to clipboard with notification. Added click listener and inline feedback state in `src/webview/design.js`. Files changed: `src/webview/design.html`, `src/webview/design.js`, `src/services/DesignPanelProvider.ts`. No issues encountered.

## Code Review (2026-07-29, reviewer pass)

**Findings:**
- CRITICAL (build) — the handler read `this._activeProjectName` (`DesignPanelProvider.ts`) and the webview sent `state.activeProjectName` — **neither property exists anywhere**; the TS side is a compile error (masked only because compilation was never run) and the JS side always sent `undefined`. **Fixed**: the provider now resolves the preferred project from the board's `kanban.activeProjectFilter` DB config via a new `_getActiveBoardProject` helper; the phantom webview field is removed.
- CLEAN — server-side prompt construction via `buildDesignSystemBlock` (authoring framing), seam clipboard write, resolution order project-bound → selected doc → explicit filePath, and immediate inline "Copied!" feedback with no dialog — all per plan.
- CLEAN (post-#5 fix) — parity with the dispatched coder prompt is structural: the handler and dispatch both call `buildDesignSystemBlock` with default `includeFullContent` (token table + link), so the two loops cannot drift.
- NIT — the plan's stale-response identity echo is implemented (docId echoed) but the webview intentionally ignores the response (clipboard is written server-side from request-time identity), which dissolves the race the echo was for.

**Validation:** typecheck clean; design-system contract suite 21/21 (block framing/table assertions); design-reply-addressing regression 7/7 (the handler's messaging obeys per-client addressing).

**Remaining risks:** none material. The "Copied!" state shows optimistically even if the server-side copy fails; failure also surfaces via the error notification, so at worst the inline state is briefly wrong.
