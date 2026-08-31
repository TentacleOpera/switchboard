# One markdown renderer for both hosts — retire the `markdown.api.render` seam

## Goal

Replace the 11 `executeCommand('markdown.api.render', …)` call sites with a single shared `renderMarkdownToHtml()` service used by both composition roots, so the extension host and the standalone host emit **identical** sanitized HTML for the same markdown. Retire the `markdown.api.render` command seam, including the standalone registration added by `fix-kanban-plan-preview-dead-in-standalone`.

### Problem Analysis

**Core problem.** `fix-kanban-plan-preview-dead-in-standalone` fixes the blank preview pane by registering `markdown.api.render` in the standalone host, backed by `marked` + DOMPurify. That is the right fix for the blank pane, but it leaves the two hosts rendering the same content through **different engines**:

| Host | Engine | Sanitizer |
| :--- | :--- | :--- |
| Extension | VS Code's built-in markdown renderer (`markdown.api.render`) | VS Code's internal sanitizer |
| Standalone | `marked` v16 | DOMPurify |

Both produce valid, sanitized HTML. Neither produces the *same* HTML. VS Code's renderer emits its own class names and block structure; `marked` emits standard GFM. The consumer CSS is shared between the panels, so the same stylesheet is now styling two different DOM shapes depending on which host the user is in.

This is the exact failure class `CLAUDE.md` names as non-negotiable: a capability wired differently in the two composition roots, where both paths are green and the divergence is only visible on sight. The preview plan knowingly accepts it — its Verification step 7 asks only that both hosts be "not pixel-identical, but both legible". This plan closes it.

**Why the seam itself is the problem.** `markdown.api.render` is a VS Code built-in. Depending on it means the extension host's output is defined by whatever VS Code ships, which:

- cannot be pinned, tested against, or reproduced in a unit test — it only exists inside a running VS Code;
- changes with the user's VS Code version, across an install base of ~4,000 on many different versions;
- forces the standalone host to *imitate* an implementation it cannot see, which is why the divergence exists at all.

Rendering markdown is not a host capability. It is a pure function of a string, and it belongs in the shared service layer that both roots already import.

**Measured scope.** 11 call sites, 5 provider files, all with the same shape (`await this._seams().commands.executeCommand<string>('markdown.api.render', content)`):

| File | Lines |
| :--- | :--- |
| `PlanningPanelProvider.ts` | 1771, 3755, 4367, 4497, 5441 |
| `TaskViewerProvider.ts` | 13990, 14396 |
| `TicketsPanelProvider.ts` | 2511, 2577 |
| `DesignPanelProvider.ts` | 2501 |
| `sharedUtilityVerbs.ts` | 104 |

Line numbers are HEAD-relative and will drift; match on the `executeCommand` call, not the line.

**Explicitly out of scope: the 24 client-side sinks.** `sharedUtils.js:122`'s hand-rolled `renderMarkdown` is called 24 times in the browser (`planning.js` ×10, `tickets.js` ×10, `design.js` ×4). Those paths never touch this seam and are not host-divergent — they run the same code in both hosts. They are a *client/server* consistency question, not a *host parity* one, and folding them in would require shipping `marked` and DOMPurify as webview assets through webpack's copy step, a `/static` route, and script tags in four panel HTML files. That is a separate, independently-shippable change and is not planned here. This plan does not delete, modify, or deprecate `renderMarkdown`.

### Root Cause

`markdown.api.render` was used because it was free inside the extension host — no dependency, no code. The cost was deferred to the day a second host appeared, at which point the capability had to be re-implemented rather than shared, because the original was never ours to share.

## Metadata

**Complexity:** 5
**Tags:** backend, refactor, standalone, extension, parity

## User Review Required

None.

## Approach

1. **Add `src/services/markdownRenderer.ts`** exporting `renderMarkdownToHtml(markdown: string): string` — `marked.parse` wrapped in `DOMPurify.sanitize`, with one module-scope JSDOM window, and a try/catch returning `''`.
2. **Replace all 11 `executeCommand` call sites** with a direct call to it. The call sites become synchronous; keep their enclosing functions `async` where they already are so no signature changes ripple outward.
3. **Delete the `markdown.api.render` registration** from `src/standalone/bootstrap.ts` and its module-scope purifier, both added by the preview plan. Nothing calls the command afterward.
4. **Assert byte-identical output across hosts** with a contract test, so the parity this plan buys cannot silently rot.

**Sequencing.** This plan **supersedes** part of `fix-kanban-plan-preview-dead-in-standalone`. Let that plan ship first — it is already coded and fixes a user-visible blank pane. This one then moves its renderer from the bootstrap registration into the shared service and deletes the seam. Do not merge them: the preview fix is a bug fix with a short path to users, this is a refactor across 5 provider files.

## Complexity Audit

### Routine

- The renderer module is ~10 lines and is lifted almost verbatim from the handler the preview plan puts in `bootstrap.ts`.
- 11 mechanical call-site replacements of one known expression.

### Complex / Risky

- **The extension host's rendering changes for ~4,000 installs.** Today they see VS Code's HTML; afterward they see `marked`'s. No data or settings are involved — this is presentation only, and CSP/sanitization posture improves rather than regresses — but it is the largest visible surface in this plan and needs the visual-delta review, not just a green build. Per the repo's migration rule this needs no migration: nothing shipped is persisted.
- **`await` removal is where a silent bug hides.** Each call site currently `await`s the seam. Replacing the expression but leaving a stray `await` is harmless; *removing* an `await` from a line that also awaited something else, or dropping the surrounding try/catch that existed because `executeCommand` could reject, is not. Change one call site at a time and keep each site's existing error handling exactly as-is.
- **Two of the 11 sites feed paths with a client-side fallback.** `TaskViewerProvider.ts:13990,14396` and `TicketsPanelProvider.ts:2511,2577` feed `tickets.js`'s `|| renderMarkdown(_linearSrc)` arm. Those fallbacks stop firing once the preview plan lands and must keep not firing here. A renderer that throws and returns `''` would silently re-arm them — which looks like it works, in one host, with different HTML. The try/catch returning `''` is therefore a *reporting* hazard, not just a safety net: log the failure.

## Edge-Case & Dependency Audit

**Race Conditions.** None introduced. The seam call was `await`ed but the registry lookup was synchronous; the shared function is synchronous. Removing an `await` cannot reorder anything that was not already ordered.

**Security.** Improves, and must not regress. Every one of the 11 outputs lands in an `innerHTML` sink. Today the extension relies on VS Code's sanitizer and (after the preview plan) standalone relies on DOMPurify; afterward both rely on DOMPurify, which is version-pinned in `package.json` and testable in CI — VS Code's sanitizer is neither. The hostile-payload assertions from the preview plan's contract test must be carried over to the new module's test verbatim, with their paired positive assertions, so a renderer that sanitizes by stripping everything still fails. `dompurify`, `jsdom` and (after the preview plan) `marked` are all already direct dependencies; this plan adds none.

**Side Effects.** (1) Extension-host previews, ticket descriptions, constitution/PRD/insight panes and the live edit preview all change HTML structure. (2) `markdown.api.render` stops being called anywhere in the codebase — if a future host lacks it, nothing breaks, because nothing asks. (3) Raw HTML embedded in a plan file is stripped in **both** hosts rather than passed through VS Code's allowlist in one and DOMPurify's in the other; the two allowlists are not identical, so a plan file with exotic embedded HTML may render differently in the extension than it did before. No persisted state changes.

**Dependencies & Conflicts.** Hard-depends on `fix-kanban-plan-preview-dead-in-standalone` for the `marked` direct dependency and for the renderer implementation this plan relocates. Conflicts with that plan's Goal Invariant "`switchboardCommandRegistry.has('markdown.api.render')` returns `true`" — that invariant is **intentionally inverted** here; update it rather than working around it. Independent of `harden-panel-csp-remove-script-src-attr-unsafe-inline`.

## Dependencies

- **Blocked by `fix-kanban-plan-preview-dead-in-standalone`** — ship that first. It adds `marked` as a direct dependency and establishes the `marked` + DOMPurify pipeline this plan relocates into a shared module.
- No dependency on the CSP hardening plan; the two can land in either order.

## Adversarial Synthesis

Key risks: (1) **the extension host's output changes for the whole install base**, and unlike the standalone paths there is no "it was blank before" baseline that makes any output an improvement — a regression here is a regression from something that worked; (2) **partial migration** — leaving 1 of 11 call sites on the old seam produces a build where one pane renders through VS Code and ten through `marked`, with no error anywhere; (3) **a throwing renderer silently re-arms the ticket fallbacks**, restoring the exact divergence this plan exists to remove, in a form that looks like working software.

Mitigations: visual-delta review in the **extension** host, not just standalone, across all five consumer surfaces; a contract test asserting zero remaining `markdown.api.render` references in `src/services/` — a count, not a spot check; log on the renderer's catch arm so a swallowed failure is visible, and assert in test that a hostile payload does not take the catch arm.

The honest residual risk is aesthetic: `marked`'s output may be worse than VS Code's somewhere no reviewer looked. That is bounded — it is presentation, in a preview pane, reversible by editing one module — and it is the price of having a renderer that can be tested at all.

## Proposed Changes

### `src/services/markdownRenderer.ts` (new)

**Context.** A shared, host-free module. Both composition roots already import from `src/services/`; neither needs new wiring.

**Logic.**

```ts
import { marked } from 'marked';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

// One window, reused for every render. Building a JSDOM per call is ~100x
// slower and is the mistake this comment exists to prevent.
const purifier = createDOMPurify(new JSDOM('').window as unknown as Window);

/**
 * The single markdown renderer for both hosts. Replaces the VS Code
 * `markdown.api.render` seam, which produced different HTML in each host and
 * could not be tested outside a running VS Code.
 *
 * DOMPurify is not optional: every consumer assigns the result to innerHTML,
 * and `marked` does not sanitize (its `sanitize` option was removed in v0.8 —
 * do not try to set it).
 */
export function renderMarkdownToHtml(markdown: string): string {
    try {
        return purifier.sanitize(marked.parse(markdown || '') as string);
    } catch (err) {
        console.error('[markdownRenderer] render failed:', err);
        return '';
    }
}
```

**Edge Cases.** Must never throw — several callers do not wrap the call. The catch arm logs rather than returning silently, because an empty string re-arms the webview fallbacks in `tickets.js` and would otherwise present as "it renders, just differently".

### The 11 call sites (5 provider files)

**Logic.** Replace

```ts
const renderedHtml = await this._seams().commands.executeCommand<string>('markdown.api.render', content);
```

with

```ts
const renderedHtml = renderMarkdownToHtml(content);
```

at `PlanningPanelProvider.ts` (1771, 3755, 4367, 4497, 5441), `TaskViewerProvider.ts` (13990, 14396), `TicketsPanelProvider.ts` (2511, 2577), `DesignPanelProvider.ts` (2501), `sharedUtilityVerbs.ts` (104).

**Edge Cases.** Preserve each site's existing `|| ''` / `?? ''` and try/catch verbatim — they are now redundant but harmless, and removing them is a second change riding along inside a mechanical one. Do not change any enclosing function's signature: a function that is `async` for other reasons stays `async`.

### `src/standalone/bootstrap.ts` (delete the seam registration)

**Logic.** Remove the `switchboardCommandRegistry.register('markdown.api.render', …)` block and the module-scope `markdownPurifier` / `JSDOM` / `createDOMPurify` / `marked` imports that the preview plan added, now that the shared module owns them. Leave every other registration untouched.

**Edge Cases.** Confirm by grep that nothing else in either root references the command before deleting — the registry is string-keyed, so an orphaned caller fails at runtime with `undefined`, not at compile time.

### `src/test/markdown-renderer-contract.test.js` (new)

**Logic.** Carries over the preview plan's hostile-payload assertions and adds the cross-host parity assertion.

## Verification Plan

### Automated Tests

1. **Sanitization contract (carried over, required).** Render the hostile payload from `fix-kanban-plan-preview-dead-in-standalone` Verification step 8 through `renderMarkdownToHtml`. Negative: output contains none of `onerror`, `onload`, `javascript:`, `<script`, `<iframe`. Paired positive, same render: `<h1>`, `<table`, `<code`, `<li>`, `<strong>`, `href="https://example.com"` all survive. Without the positive half, a renderer returning `''` passes.
2. **The catch arm was not taken.** Spy on `console.error` during test 1 and assert it was not called — a renderer that throws and returns `''` otherwise passes every negative assertion in test 1.
3. **Seam is gone.** Assert `grep -rn "markdown.api.render" src/services/ src/standalone/` returns zero call sites. Pin to zero, not "fewer than before" — a partial migration is the failure mode this catches.
4. **One window, not one per render.** Assert by code reading or a `JSDOM` constructor spy that the window is built once at module scope.
5. **Host parity (the point of the plan).** Render the same fixture markdown — headings, GFM table with alignment, fenced code with a language, nested list, link, inline HTML — through the extension host and the standalone host, and assert the two HTML strings are **byte-identical**. This is the only test that fails if the divergence returns.
6. **Extension-host visual-delta review across all five surfaces.** In VS Code: kanban plan preview, constitution pane, PRD pane, archived-plan detail, insight pane, ticket description, and the edit-mode live preview. Compare against the pre-change build. Headings, code blocks, tables, lists and links must be legible and correctly styled. This is the review that matters most — extension users are moving off something that already worked.
7. **Standalone visual-delta review, same seven surfaces**, in `npx switchboard`.
8. **Both hosts, side by side.** Open the same plan in each and confirm the previews now look the same — not merely "both legible", which was the preview plan's weaker bar.
9. `npm run compile` and `tsc` clean; `npm run test:contract:verb-engine` green — `verb-engine-planning-headless.test.js:283` mocks `markdown.api.render` and **will need updating**, since the mock is now never consulted. Update it to assert the shared renderer's output rather than deleting the assertion.

### Goal Invariants

- **Positive:** `renderMarkdownToHtml('# Hello')` returns a string containing `<h1>` in a plain Node process, with no VS Code and no standalone host running. The old seam could not be tested this way at all.
- **Positive:** the same markdown fixture renders byte-identically in both hosts (Verification step 5).
- **Negative (paired):** zero references to `markdown.api.render` remain in `src/services/` or `src/standalone/`. Paired positive: all five consumer surfaces still render in both hosts — a change that removes the references by deleting the render calls fails this pair.
- **Negative:** `sharedUtils.js`'s `renderMarkdown` and its 24 client-side call sites are unmodified. They are out of scope; a diff touching them has exceeded this plan.
