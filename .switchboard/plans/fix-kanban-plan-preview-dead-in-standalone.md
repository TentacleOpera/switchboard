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

This plan adds `marked` as a direct dependency (it is currently only a transitive dependency in `node_modules`, pulled in via `mermaid@11.14.0`; verified present at `node_modules/marked` v16.4.2). Confirm that adding a direct dependency on `marked` is acceptable, vs. extracting the existing client-side `renderMarkdown` from `sharedUtils.js` into a shared module. `marked` is the standard approach; the extracted renderer is dependency-free but less complete (no GFM tables, no syntax highlighting, hand-rolled edge cases).

**Two further decisions need a human:**

1. **Behavior change for currently-working ticket paths.** Registering `markdown.api.render` swaps the rendering engine for ticket descriptions and the edit-mode live preview from the hand-rolled `renderMarkdown` (`sharedUtils.js:122`) to `marked`. The code in those paths is unchanged, but the HTML they receive changes (different block structure, no `code-line` wrappers, different class names). The webview CSS was tuned against `renderMarkdown`'s output. Confirm that a visual-delta review of ticket descriptions and live preview in standalone is an acceptable verification cost, vs. accepting the engine swap as parity-improving. See "Behavior Change for Currently-Working Paths" below.

2. **HTML sanitization.** `marked` v16 does NOT sanitize HTML — raw `<script>`/HTML in markdown passes through to the webview's `innerHTML`. The `sanitize` option was removed from `marked` in v0.8 and no longer exists; do not attempt to configure it. The content rendered includes ticket descriptions from ClickUp/Linear APIs and plan files imported from other machines (shared workspaces) — these are not fully trusted. The webview CSP is the only barrier today. Confirm whether a sanitizer (`DOMPurify`, not currently a dependency) should be added, or whether the webview CSP is accepted as sufficient. The extension host's `markdown.api.render` sanitizes by default; this standalone bridge would not, creating a host asymmetry.

## Approach

1. **Register `markdown.api.render` in `bootstrap.ts`.** Add a `switchboardCommandRegistry.register('markdown.api.render', ...)` call alongside the existing standalone command registrations (`:1219+`). The handler takes a markdown string and returns rendered HTML using `marked` (already in `node_modules`, to be added as a direct dependency).

2. **Add `marked` as a direct dependency.** Run `npm add marked`. It is already present as a transitive dependency — adding it as a direct dependency prevents it from disappearing if the transitive dependency is removed. Prefer a version published at least 7 days ago.

3. **Sanitize the output (open item — see User Review Required).** VS Code's `markdown.api.render` produces sanitized HTML. `marked` v16 produces standard HTML and does **not** sanitize — the `sanitize` option was removed in `marked` v0.8 and no longer exists; do not attempt to configure it. The webview's `externalizeAnchors` function processes the output and works on any HTML structure but does not strip dangerous tags. The content rendered includes ticket descriptions from ClickUp/Linear APIs and plan files imported from shared workspaces — not fully trusted. The webview CSP is the only barrier today. Either add `DOMPurify` (not currently a dependency) to the handler pipeline, or accept the CSP as sufficient and document the host asymmetry (extension host sanitizes, standalone does not). This is flagged for user decision, not silently resolved.

## Complexity Audit

### Routine

- Registering a command in `switchboardCommandRegistry` — one line, same pattern as the 10+ existing registrations in `bootstrap.ts:1219+`.
- Adding `marked` as a direct dependency — one `npm add` command.
- The handler is a one-liner: `(content: string) => marked.parse(content)`.

### Complex / Risky

- **Rendering fidelity.** VS Code's markdown renderer and `marked` produce different HTML. VS Code adds CSS classes (`code-line`, `hljs`), wraps blocks in specific containers, and handles VS Code-specific extensions (e.g. command links). `marked` produces standard GFM HTML. The webview CSS may style VS Code's output differently than `marked`'s output. Verify the preview renders readably — it does not need to be pixel-identical, but code blocks, tables, and links must be legible.
- **11 call sites, one registration — two populations.** Registering the command fixes the 6 broken project-panel paths at once AND silently swaps the rendering engine for the 5 currently-working ticket/live-preview paths (which today use the hand-rolled `renderMarkdown` fallback). The strength is one-change leverage; the risk is that the engine swap changes the HTML structure for ticket descriptions, where the webview CSS was tuned against `renderMarkdown`'s output. The consumers all use the HTML as `innerHTML` after `externalizeAnchors`, so the contract is "valid HTML string" — `marked` satisfies it — but "valid" is not "visually identical." A visual-delta review of ticket descriptions in standalone is required, not optional.

## Edge-Case & Dependency Audit

**Race Conditions.** None. The command registration runs at bootstrap, before any provider handles a message. The registry is synchronous.

**Security.** The markdown content rendered by `markdown.api.render` comes from plan files (`.switchboard/plans/*.md`) and ticket descriptions. Plan files are user-authored; ticket descriptions come from ClickUp/Linear APIs. `marked` v16 does NOT sanitize HTML — the `sanitize` option was removed in v0.8 and no longer exists. If a plan file or ticket description contains `<script>` tags or raw HTML, `marked` passes them through to the webview's `innerHTML`. VS Code's renderer sanitizes by default; this standalone bridge would not, creating a host asymmetry. The webview CSP is the only barrier. If untrusted content is a concern (shared workspaces, imported plans, ticket API descriptions), add `DOMPurify` (not currently a dependency) to the handler pipeline, or accept the CSP as sufficient. This is flagged for user decision in User Review Required — it is not silently resolved, and the removed `sanitize` option must not be referenced as a mitigation.

**Side Effects.** Registering the command has two effects: (1) the 6 broken project-panel preview paths start producing rendered HTML where there were blank panes / empty states / escaped plaintext — this is the fix; (2) the 5 currently-working ticket/live-preview paths stop using their `renderMarkdown` fallback and start consuming `marked` HTML — a rendering-engine swap with no code change in those paths. The first run after this change will show previews where there were blank panes, AND ticket descriptions may look different (different HTML structure). No persisted state changes.

**Dependencies & Conflicts.** `marked` is already in `node_modules` as a transitive dependency. Adding it as a direct dependency prevents silent removal. No conflict with existing dependencies. Independent of the sixteen-seam wiring plan — either can ship first.

## Dependencies

- Independent of the sixteen-seam `LocalApiServer` wiring plan. Either can ship first; this plan fixes the preview, that plan fixes the action routes.
- `marked` must be added as a direct dependency before the command registration can use it.

## Adversarial Synthesis

Key risks: (1) `marked`'s HTML output differs from VS Code's renderer in CSS class names and block structure — the preview may render but look different (code blocks, tables); (2) `marked` v16 does NOT sanitize HTML (the `sanitize` option was removed in v0.8) — untrusted plan files or ticket API descriptions with `<script>` tags would pass through to the webview `innerHTML`, with only the CSP as barrier, creating a host asymmetry vs the extension host which sanitizes by default; (3) the registration silently swaps the rendering engine for the 5 currently-working ticket/live-preview paths from the hand-rolled `renderMarkdown` to `marked` — a behavior change with no code diff in those paths, where the webview CSS was tuned against `renderMarkdown`'s output. Mitigations: verify rendering in the browser project panel after wiring; add `DOMPurify` or accept CSP as the sanitization barrier (user decision); perform a visual-delta review of ticket descriptions and live preview in standalone to catch the engine-swap regression.

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
switchboardCommandRegistry.register('markdown.api.render', (content: string) => {
    try {
        return marked.parse(content || '');
    } catch {
        return '';
    }
});
```

Import `marked` at the top of `bootstrap.ts`: `import { marked } from 'marked';`

**Edge Cases.** The handler must not throw — `vscodeShim.executeCommand` never throws (it returns `undefined`), and the callers use `|| ''` or `?? ''` to handle undefined. A throw would become an unhandled rejection in the caller's async path. Wrap in try/catch returning `''` on failure.

### `package.json` (direct dependency)

**Logic.** Add `marked` as a direct dependency via `npm add marked`. It is already present as a transitive dependency — this prevents silent removal.

### No code changes to provider files — but a behavior change for 5 paths

The 11 `executeCommand` call sites are unchanged in code. They already call `this._seams().commands.executeCommand<string>('markdown.api.render', content)` and handle `undefined` with `|| ''` or `?? ''`. Once the command is registered, they get real HTML instead of `undefined`. No provider-level code change is needed.

**Behavior Change for Currently-Working Paths.** The 5 ticket/live-preview call sites (Population 2 above) currently render via a client-side `renderMarkdown` fallback because the host returns `''`. Once `markdown.api.render` returns `marked` HTML:

- `tickets.js:7689, 7722`: `message.renderedDescriptionHtml` is no longer `''`, so the `|| renderMarkdown(_linearSrc)` fallback **stops firing**. Ticket descriptions render through `marked` instead of the hand-rolled `renderMarkdown`.
- `sharedUtilityVerbs.ts:104`: the `html` field is no longer `undefined`. The webview paths that rendered from the `markdown` source field will now consume `marked` HTML directly.

This is an engine swap, not a code change. The HTML structure differs (`marked` emits standard GFM; `renderMarkdown` emits hand-rolled HTML the webview CSS was tuned against). **A visual-delta review of ticket descriptions and the edit-mode live preview in standalone is mandatory** — see Verification Plan step 8. The existing test `tickets-description-markdown-fallback.test.js` asserts the fallback *exists* and is *documented*; it does not assert the fallback *fires* in standalone, so it will not catch this swap. The test `sharedUtils-renderMarkdown.test.js:335` asserts `pushes[0].html === undefined` in the standalone-mock case — that test mocks the seam directly and does not go through `bootstrap.ts`, so it is unaffected by the registration, but its premise (undefined in standalone) no longer holds in the real host.

## Verification Plan

### Automated Tests

1. **Reproduce first.** In `npx switchboard`, open the project panel, go to the Kanban tab, click a plan. Confirm the preview pane shows nothing (blank or "Loading preview..." that never resolves).
2. **After wiring**, click the same plan. Confirm the preview pane renders the plan's markdown content as HTML (headings, code blocks, lists, tables legible).
3. **Constitution preview.** In the project panel's Constitution tab, confirm the constitution file renders as HTML (not blank).
4. **Archived plan detail + Insight preview.** In the Archives tab, confirm an archived plan renders as HTML (not the "Preview unavailable on this host." empty state). In the Tuning tab, confirm an insight renders as HTML (not escaped plaintext).
5. **Edit-mode live preview.** Enter edit mode on a kanban plan, confirm the live preview pane renders as you type (the `renderMarkdownLive` path, `sharedUtilityVerbs.ts:104`).
6. `npm run compile` and `tsc` clean; `npm run test:contract:verb-engine` green (the `renderMarkdownLive` test at `verb-engine-planning-headless.test.js:283` mocks `markdown.api.render` — confirm it still passes with the real registration).
7. **Both hosts, same preview.** Open the same plan in the extension host and the standalone host; confirm both render the preview (not pixel-identical, but both legible).
8. **Visual-delta review of ticket descriptions (engine-swap regression check).** In `npx switchboard`, open the Tickets panel, select a Linear issue and a ClickUp task with rich descriptions (tables, code blocks, lists). Compare the rendered description BEFORE this change (rendered via the hand-rolled `renderMarkdown` fallback) and AFTER (rendered via `marked`). Confirm the description is legible and not visually broken — code blocks, tables, and lists must render. This is the check that catches the silent engine swap for the 5 currently-working paths. If the output is visually broken, the webview CSS needs adjustment for `marked`'s HTML structure (out of scope for this plan — flag back).

### Goal Invariants

- **Positive:** `switchboardCommandRegistry.has('markdown.api.render')` returns `true` in the standalone host (asserted by inspecting `switchboardCommandRegistry.registeredCommands` after bootstrap).
- **Positive:** `await headlessSeams.commands.executeCommand('markdown.api.render', '# Hello')` returns a string containing `<h1>` in the standalone host (asserted by a unit test or manual REPL check).
- **Negative (paired):** no call site in `PlanningPanelProvider.ts`, `TaskViewerProvider.ts`, `TicketsPanelProvider.ts`, `DesignPanelProvider.ts`, or `sharedUtilityVerbs.ts` was modified to add a client-side fallback. Paired positive: the single command registration fixes the 6 broken project-panel paths without touching provider code.
