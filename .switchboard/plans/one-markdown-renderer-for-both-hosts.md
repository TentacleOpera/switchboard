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

1. **Add `src/services/markdownRenderer.ts`** exporting `renderMarkdownToHtml(markdown: string): Promise<string>` — `marked.parse` wrapped in `DOMPurify.sanitize`, with one module-scope JSDOM window, and a try/catch returning `''`. The function is `async` because `marked` must be loaded via a dynamic `await import('marked')` (see Proposed Changes — `marked` v16 is ESM-only and the root `tsconfig.json` is `module: Node16`, so a static `import { marked } from 'marked'` is a TS1479 compile error in `src/services/` just as it is in `bootstrap.ts`). The module-scope import promise is paid once and kept warm, so repeated calls don't re-await.
2. **Replace all 11 `executeCommand` call sites** with a direct call to it. The function is `async` (see Proposed Changes — `marked` is dynamically imported under Node16), so each site keeps its existing `await`; keep their enclosing functions `async` where they already are so no signature changes ripple outward.
3. **Delete the `markdown.api.render` registration** from `src/standalone/bootstrap.ts` and its module-scope purifier, both added by the preview plan. Nothing calls the command afterward.
4. **Assert byte-identical output across hosts** with a contract test, so the parity this plan buys cannot silently rot.

**Sequencing.** This plan **supersedes** part of `fix-kanban-plan-preview-dead-in-standalone`. Let that plan ship first — it is already coded and fixes a user-visible blank pane. This one then moves its renderer from the bootstrap registration into the shared service and deletes the seam. Do not merge them: the preview fix is a bug fix with a short path to users, this is a refactor across 5 provider files.

## Complexity Audit

### Routine

- The renderer module is ~25 lines and is adapted from the handler the preview plan puts in `bootstrap.ts` — but not lifted verbatim: `marked` must be dynamically imported under Node16 (TS1479), so the module adds a cached dynamic-import promise and an `async` signature where the bootstrap handler used a top-level `await import` inside an already-`async` registry callback.
- 11 mechanical call-site replacements of one known expression.

### Complex / Risky

- **The extension host's rendering changes for ~4,000 installs.** Today they see VS Code's HTML; afterward they see `marked`'s. No data or settings are involved — this is presentation only, and CSP/sanitization posture improves rather than regresses — but it is the largest visible surface in this plan and needs the visual-delta review, not just a green build. Per the repo's migration rule this needs no migration: nothing shipped is persisted.

  > **Superseded:** "the extension host's rendering changes for ~4,000 installs … it is the largest visible surface in this plan and needs the visual-delta review, not just a green build."
  > **Reason:** The standalone release cuts over with no overlap period: the extension becomes a sidebar that opens `:7777` and stops rendering panels entirely. There is no moment between "this plan lands" and "the extension stops rendering" where anyone observes the extension host's markdown output. The extension-host visual delta is never seen by a user. The ~4,000 figure is also a marketplace fact about the legacy host that AGENTS.md deliberately de-emphasises.
  > **Replaced with:** The extension host's rendering is not a user-observed surface under the cutover path. The durable surface is the standalone host, which serves the same `src/services/*Provider.ts` files and imports the same `renderMarkdownToHtml()` — the visual-delta review belongs there (Verification step 6), not in the extension.
- **`await` retention is where a silent bug hides.** Each call site currently `await`s the seam. The shared function is `async` (dynamic `marked` import under Node16), so each site **keeps** its `await`. The hazard is the inverse of the original note: a site that drops its `await` now awaits nothing and assigns a `Promise<string>` to an `innerHTML` sink, which renders `[object Promise]`. Change one call site at a time and keep each site's existing error handling exactly as-is.

  > **Superseded:** "`await` removal is where a silent bug hides. … Replacing the expression but leaving a stray `await` is harmless; removing an `await` from a line that also awaited something else … is not."
  > **Reason:** That note assumed a synchronous replacement function. The Node16/ESM-only-`marked` constraint makes the shared function `async`, so every call site must *retain* its `await` — a stray `await` is still harmless, but a *dropped* `await` now assigns a `Promise` to `innerHTML`.
  > **Replaced with:** the retention framing above — sites keep `await`; the failure mode is dropping it, not leaving it.
- **Two of the 11 sites feed paths with a client-side fallback.** `TaskViewerProvider.ts:13990,14396` and `TicketsPanelProvider.ts:2511,2577` feed `tickets.js`'s `|| renderMarkdown(_linearSrc)` arm. Those fallbacks stop firing once the preview plan lands and must keep not firing here. A renderer that throws and returns `''` would silently re-arm them — which looks like it works, in one host, with different HTML. The try/catch returning `''` is therefore a *reporting* hazard, not just a safety net: log the failure.

## Edge-Case & Dependency Audit

**Race Conditions.** None introduced. The seam call was `await`ed; the shared function is `async` (dynamic `marked` import under Node16) and is also `await`ed at every call site, so the await shape is preserved. The module-scope `marked` import promise is settled once and reused — concurrent callers race on a cached, already-resolved promise, which is safe. No reordering relative to the old registry-lookup-then-`await` path.

> **Superseded:** "The seam call was `await`ed but the registry lookup was synchronous; the shared function is synchronous. Removing an `await` cannot reorder anything that was not already ordered."
> **Reason:** The shared function is `async`, not synchronous (Node16/ESM-only-`marked`), so the "removing an `await`" framing no longer applies — `await` is retained at every site.
> **Replaced with:** the async-function race note above — await shape preserved, concurrent callers share one resolved import promise.

**Security.** Improves, and must not regress. Every one of the 11 outputs lands in an `innerHTML` sink. Today the extension relies on VS Code's sanitizer and (after the preview plan) standalone relies on DOMPurify; afterward both rely on DOMPurify, which is version-pinned in `package.json` and testable in CI — VS Code's sanitizer is neither. The hostile-payload assertions from the preview plan's contract test must be carried over to the new module's test verbatim, with their paired positive assertions, so a renderer that sanitizes by stripping everything still fails. `dompurify`, `jsdom` and (after the preview plan) `marked` are all already direct dependencies; this plan adds none.

**Side Effects.** (1) The standalone host's previews, ticket descriptions, constitution/PRD/insight panes and the live edit preview all change HTML structure (from the preview plan's `marked`+DOMPurify output, which is already what standalone renders, to the shared module's identical output — no visible change in standalone). The extension host's rendering also changes, but the extension stops rendering at the standalone-release cutover with no overlap period, so that change is never user-observed. (2) `markdown.api.render` stops being called anywhere in the codebase — if a future host lacks it, nothing breaks, because nothing asks. (3) Raw HTML embedded in a plan file is now stripped through DOMPurify in the standalone host (the durable surface); the extension host's VS Code allowlist is retired with the extension's rendering surface. No persisted state changes.

**Dependencies & Conflicts.** Hard-depends on `fix-kanban-plan-preview-dead-in-standalone` for the `marked` direct dependency and for the renderer implementation this plan relocates. Conflicts with that plan's Goal Invariant "`switchboardCommandRegistry.has('markdown.api.render')` returns `true`" — that invariant is **intentionally inverted** here; update it rather than working around it. Independent of `harden-panel-csp-remove-script-src-attr-unsafe-inline`.

## Dependencies

- **Blocked by `fix-kanban-plan-preview-dead-in-standalone`** — ship that first. It adds `marked` as a direct dependency and establishes the `marked` + DOMPurify pipeline this plan relocates into a shared module.
  - **Status (verified against HEAD):** the blocker is **met**. The `markdown.api.render` registration lives at `src/standalone/bootstrap.ts:1835`, backed by `marked` + a module-scope DOMPurify (`:1810-1840`), and `markdown-render-sanitize-contract.test.js` already asserts it. `marked`, `jsdom`, and `dompurify` are all direct dependencies. This plan can proceed without waiting on anything further.
- No dependency on the CSP hardening plan; the two can land in either order.

## Adversarial Synthesis

Key risks: (1) **partial migration** — leaving 1 of 11 call sites on the old seam produces a build where one pane renders through VS Code and ten through `marked`, with no error anywhere; (2) **a throwing renderer silently re-arms the ticket fallbacks**, restoring the exact divergence this plan exists to remove, in a form that looks like working software; (3) **a `marked` output regression in the standalone host** — the durable surface — that no reviewer caught, because the visual-delta review is the only detector and it is manual; (4) **the TS1479 trap** — a coder who "simplifies" the dynamic `await import('marked')` back to a static `import { marked } from 'marked'` reproduces the exact compile error `bootstrap.ts` worked around, in a second file, and the build fails with a module-resolution error that does not name the root cause.

Mitigations: visual-delta review in the **standalone** host across all consumer surfaces (the extension host is not a user-observed surface under the cutover path); a contract test asserting zero remaining `markdown.api.render` references in `src/services/` — a count, not a spot check; log on the renderer's catch arm so a swallowed failure is visible, and assert in test that a hostile payload does not take the catch arm; the dynamic-import + `webpackMode: "eager"` pattern is copied from `bootstrap.ts:1837` and the Superseded callout in Proposed Changes records *why* it cannot be a static import, so the next reader does not "fix" it backward.

The honest residual risk is aesthetic: `marked`'s output may be worse than VS Code's somewhere no reviewer looked. That is bounded — it is presentation, in a preview pane, in the standalone host, reversible by editing one module — and it is the price of having a renderer that can be tested at all. The extension host's output is not a concern: it stops rendering at the cutover.

## Proposed Changes

### `src/services/markdownRenderer.ts` (new)

**Context.** A shared, host-free module. Both composition roots already import from `src/services/`; neither needs new wiring.

**Logic.**

```ts
import { JSDOM } from 'jsdom';
import createDOMPurify = require('dompurify');

// One window, reused for every render. Building a JSDOM per call is ~100x
// slower and is the mistake this comment exists to prevent.
const purifier = createDOMPurify(new JSDOM('').window as unknown as Window);

// `marked` v16 is ESM-only ("type": "module") and the root tsconfig is
// module: Node16, so a static `import { marked } from 'marked'` is a TS1479
// compile error in src/services/ — the same constraint that forced
// bootstrap.ts to use a dynamic import. webpackMode: "eager" inlines the
// module into the bundle instead of emitting an async chunk, so the await
// resolves against an already-loaded module and the payload gains no file.
let _marked: typeof import('marked')['marked'] | undefined;
async function getMarked() {
    return (_marked ??= (await import(/* webpackMode: "eager" */ 'marked')).marked);
}

// Module-scope promise kept warm so repeated sync-looking calls don't re-await.
let _markedReady: Promise<typeof import('marked')['marked']> | undefined;

/**
 * The single markdown renderer for both hosts. Replaces the VS Code
 * `markdown.api.render` seam, which produced different HTML in each host and
 * could not be tested outside a running VS Code.
 *
 * DOMPurify is not optional: every consumer assigns the result to innerHTML,
 * and `marked` does not sanitize (its `sanitize` option was removed in v0.8 —
 * do not try to set it).
 *
 * The function is async because `marked` must be dynamically imported under
 * Node16. Callers that already `await` the seam stay `await`-shaped; callers
 * that don't wrap must add `await` (see the call-site notes — preserve each
 * site's existing error handling, and do not change enclosing function
 * signatures beyond what awaiting this requires).
 */
export async function renderMarkdownToHtml(markdown: string): Promise<string> {
    try {
        _markedReady ??= getMarked();
        const marked = await _markedReady;
        return purifier.sanitize(marked(markdown || '') as string);
    } catch (err) {
        console.error('[markdownRenderer] render failed:', err);
        return '';
    }
}
```

> **Superseded:** the original snippet used `import { marked } from 'marked';` and a synchronous `export function renderMarkdownToHtml(markdown: string): string`.
> **Reason:** `marked` v16 ships as `"type": "module"` with `main: ./lib/marked.esm.js`; under the root `tsconfig.json`'s `module: Node16`, a static ESM import of an ESM-only package from a CommonJS-compiled file is TS1479. `bootstrap.ts:1837` already hits this exact error and works around it with `await import(/* webpackMode: "eager" */ 'marked')`. Lifting the bootstrap handler "verbatim" into `src/services/` would have reproduced the compile error in a second file. Verified: `node_modules/marked/package.json` has `"type": "module"`, no CJS entry in `exports`.
> **Replaced with:** dynamic `await import('marked')` with `webpackMode: "eager"`, a module-scope cached promise so the import is paid once, and an `async`/`Promise<string>` signature. Callers already `await` the seam, so the signature change is shape-preserving at the call sites; the Complexity Audit note about "11 mechanical call-site replacements" still holds because each site already has `await`.

**Edge Cases.** Must never throw — several callers do not wrap the call. The catch arm logs rather than returning silently, because an empty string re-arms the webview fallbacks in `tickets.js` and would otherwise present as "it renders, just differently".

### The 11 call sites (5 provider files)

**Logic.** Replace

```ts
const renderedHtml = await this._seams().commands.executeCommand<string>('markdown.api.render', content);
```

with

```ts
const renderedHtml = await renderMarkdownToHtml(content);
```

at `PlanningPanelProvider.ts` (1771, 3755, 4367, 4497, 5441), `TaskViewerProvider.ts` (13990, 14396), `TicketsPanelProvider.ts` (2511, 2577), `DesignPanelProvider.ts` (2501), `sharedUtilityVerbs.ts` (104). The `await` is retained because `renderMarkdownToHtml` is `async` (dynamic `marked` import under Node16).

**Edge Cases.** Preserve each site's existing `|| ''` / `?? ''` and try/catch verbatim — they are now redundant but harmless, and removing them is a second change riding along inside a mechanical one. Do not change any enclosing function's signature: a function that is `async` for other reasons stays `async`.

### `src/standalone/bootstrap.ts` (delete the seam registration)

**Logic.** Remove the `switchboardCommandRegistry.register('markdown.api.render', …)` block and the module-scope `markdownPurifier` / `JSDOM` / `createDOMPurify` / `marked` imports that the preview plan added, now that the shared module owns them. Leave every other registration untouched.

**Edge Cases.** Confirm by grep that nothing else in either root references the command before deleting — the registry is string-keyed, so an orphaned caller fails at runtime with `undefined`, not at compile time.

### `src/test/markdown-renderer-contract.test.js` (new)

**Logic.** Carries over the preview plan's hostile-payload assertions and adds the deterministic-snapshot assertion (parity is structural — one function, both roots).

## Verification Plan

### Automated Tests

1. **Sanitization contract (carried over, required).** `await renderMarkdownToHtml(...)` on the hostile payload from `fix-kanban-plan-preview-dead-in-standalone` Verification step 8. Negative: output contains none of `onerror`, `onload`, `javascript:`, `<script`, `<iframe`. Paired positive, same render: `<h1>`, `<table`, `<code`, `<li>`, `<strong>`, `href="https://example.com"` all survive. Without the positive half, a renderer returning `''` passes. (Tests `await` the function — it is `async` under Node16.)
2. **The catch arm was not taken.** Spy on `console.error` during test 1 and assert it was not called — a renderer that throws and returns `''` otherwise passes every negative assertion in test 1.
3. **Seam is gone.** Assert `grep -rn "markdown.api.render" src/services/ src/standalone/` returns zero call sites. Pin to zero, not "fewer than before" — a partial migration is the failure mode this catches.
4. **One window, not one per render.** Assert by code reading or a `JSDOM` constructor spy that the window is built once at module scope. Also assert the `marked` dynamic import is settled once and cached (the module-scope `_markedReady` promise), not re-awaited per call.
5. **Renderer output is deterministic and stable.** `await renderMarkdownToHtml(...)` on the same fixture markdown — headings, GFM table with alignment, fenced code with a language, nested list, link, inline HTML — and assert the output matches a pinned snapshot. Both composition roots now call the same function, so cross-host parity is guaranteed by construction (one code path, not two); the snapshot test catches a `marked`/DOMPurify version bump silently changing the output.
6. **Standalone visual-delta review across all consumer surfaces** — the durable surface. In `npx switchboard`: kanban plan preview, constitution pane, PRD pane, archived-plan detail, insight pane, ticket description, and the edit-mode live preview. Headings, code blocks, tables, lists and links must be legible and correctly styled. This is the review that matters — the standalone host is the survivor.
7. `npm run compile` and `tsc` clean; `npm run test:contract:verb-engine` green — `verb-engine-planning-headless.test.js:283` mocks `markdown.api.render` and **will need updating**, since the mock is now never consulted. Update it to assert the shared renderer's output rather than deleting the assertion.
8. **Three further test files break on this plan and must be updated in the same diff** (each currently asserts the seam this plan deletes — a green build requires touching all three, not just #7):
    - **`src/test/markdown-render-sanitize-contract.test.js`** — asserts `markdown.api.render` is registered in `bootstrap.ts` (`:186-189`), asserts the handler body calls `marked`/`getMarkdownPurifier().sanitize` (`:191-199`), asserts no per-call JSDOM (`:201-205`), and asserts the try/catch shape (`:207-212`). All four registration/handler tests fail once the registration is deleted. The **behavioral** hostile-payload tests (`:216+`, driven by `renderPipeline`) move to the new `markdown-renderer-contract.test.js` (this plan already says it carries them over); the registration/handler-shape tests are deleted outright — they assert a seam that no longer exists, and the parity + sanitization tests in the new file supersede them. Do not leave them asserting a deleted registration.
    - **`src/test/tickets-description-markdown-fallback.test.js`** (`:140-145`) — asserts each of `TicketsPanelProvider.ts` and `TaskViewerProvider.ts` contains exactly **2** occurrences of the comment `markdown.api.render is a VS Code built-in and is unavailable on hosts`. Replacing the call sites removes those comments, so `hits === 2` fails. The comment's premise (the seam is a VS Code built-in that yields undefined off VS Code) no longer holds — the shared renderer always returns HTML. Invert the assertion: the comment must be **absent** (the seam is gone), and replace it with a comment documenting that the host now renders via `renderMarkdownToHtml` and the webview fallback is dead code retained only for the >30k cutoff. If the fallback comment test is kept as-is it codifies a lie.
    - **`src/test/sharedUtils-renderMarkdown.test.js`** (`:334-336`) — mocks `executeCommand('markdown.api.render')` to return `undefined` and asserts `pushes[0].html === undefined` (the standalone "seam yields undefined, source markdown survives" path). After `sharedUtilityVerbs.ts:104` calls `renderMarkdownToHtml(content)` directly, the mock is never consulted and `html` is real rendered HTML — the `=== undefined` assertion fails. Update the test to assert `pushes[0].html` is the rendered HTML (contains `<ul>`/`<li>` for the `- a\n- b` fixture) and that `pushes[0].markdown` still survives as the fallback payload. The "seam yields undefined" scenario no longer exists; do not preserve it as a passing path.

### Goal Invariants

- **Positive:** `await renderMarkdownToHtml('# Hello')` resolves to a string containing `<h1>` in a plain Node process, with no VS Code and no standalone host running. The function is `async` (dynamic `marked` import under Node16), so tests `await` it. The old seam could not be tested this way at all.
- **Positive:** `await renderMarkdownToHtml(...)` produces deterministic, snapshot-stable output for a fixed fixture (Verification step 5). Both composition roots call the same function, so cross-host parity is structural — one code path, not two to reconcile.
- **Negative (paired):** zero references to `markdown.api.render` remain in `src/services/` or `src/standalone/`. Paired positive: all consumer surfaces still render in the standalone host — a change that removes the references by deleting the render calls fails this pair.
- **Negative:** `sharedUtils.js`'s `renderMarkdown` and its 24 client-side call sites are unmodified. They are out of scope; a diff touching them has exceeded this plan.
