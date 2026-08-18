# Docs Health Sub-Tab in Connections — Planning Doc Guidance & Maintenance Prompt

## Goal

Non-technical users who point external planning agents (Spark, Claude Cowork, etc.) at their docs don't know which docs make plans better. Today there is no surface in Switchboard that tells a user what kinds of docs help planning agents, why they matter, or how to maintain them.

The Web Agents tab has an "Improve my docs with an agent" button, but it's generic — it copies a prompt that says "rewrite for clarity" without knowing which structural doc types are missing. It's also one-shot, not recurring.

This plan adds a **Docs Health** sub-tab to the Connections panel that:
1. Lists the **general categories** of planning-navigational docs in plain language a non-technical user can understand — categories that adapt to any project type, not just VS Code extensions.
2. Provides a **"Copy maintenance prompt"** button that generates a self-contained, tool-agnostic prompt an external scheduled agent can run to check for and create/update these docs.
3. Does NOT do live scanning — the prompt tells the agent to build its own scanner logic, since doc conventions and project architectures vary.

### Root cause

The docs-zip pipeline works (user picks a folder → zip is built → agent reads docs → writes plan). The gap is doc *completeness*: users don't know what kinds of docs they should have, and there's no mechanism to keep those docs fresh over time. This is a product/UX gap, not a technical pipeline gap.

### Why general categories, not a fixed checklist

Spark's original four asks (component map, IPC index, search scoping, file TOCs) were specific to Switchboard's architecture — a VS Code extension with webview/host postMessage, large monolithic JS files, and a dist/ build artifact. A REST API service would need an endpoint index, not an IPC index. A CLI tool has no UI panels to map. A small library may have no files large enough to need TOCs. The Docs Health tab must recommend *categories of orientation* that every project benefits from, while letting the agent determine the specific form for the project it's pointed at.

## Metadata

**Complexity:** 5
**Tags:** frontend, backend, ui, ux, feature
**Project:** Browser Switchboard

## User Review Required

None — additive feature (new sub-tab). No changes to existing tabs or behaviour.

## Complexity Audit

### Routine

- Purely additive — a new sub-tab that doesn't modify any existing flow. No migrations, no state changes, no database changes.
- Tab switching logic in `connections.js` (lines 18-29) already handles arbitrary tabs via the `data-tab` / `data-tab-content` pattern — no change needed there.
- The HTML structure (tab button + tab content div) follows the exact pattern of the existing 4 tabs.
- No init message needed for this tab (unlike web-agents which sends `createPlansInit`).

### Complex / Risky

- **Touches both frontend and backend**: new HTML sub-tab + JS wiring (frontend) and new verb handler to assemble and copy the prompt (backend).
- **The prompt content is the hard part** — it needs to describe general doc categories that adapt to any project type (web service, CLI tool, library, mobile app, extension) while being specific enough that an agent can actually create useful docs from it. Each category needs intent + examples of how it manifests in different project types + creation instructions.
- **Verb registration is build-system-coupled**: the verb must be added to `protocol-catalog.json` (not the auto-generated allowlist), then `npm run catalog:generate` regenerates `src/generated/verbAllowlist.ts`. Getting this wrong breaks `parity:check` in CI.
- **Response mechanism must use push+return pattern**: the handler must both `postMessageToWebview` (for VS Code webview) and `return` the result (for browser host transport.js re-dispatch) so the webview's "Copied!" status line updates in both hosts.

## Edge-Case & Dependency Audit

- **Tab placement**: fifth sub-tab in Connections, after Web Agents. Tab label: "Docs Health". The existing tab bar is in `connections.html` (lines 309-312) — add `<button class="shared-tab-btn" data-tab="docs-health" role="tab" aria-selected="false">Docs Health</button>` after the Web Agents button (line 312), and a corresponding `<div class="shared-tab-content" id="docs-health-fields" data-tab-content="docs-health">` after the web-agents-fields div (which ends at line 572).
- **Tab switching logic**: `connections.js` (lines 18-29) handles tab switching by toggling `active` class. The web-agents tab has a special `createPlansInit` postMessage on activation (line 27). Docs Health has no init message — it's static content + a copy button.
- **Message handler**: new verb `docsHealthCopyPrompt` — follows the `createPlansInit` pattern (push + return), NOT the `createPlansCopyPrompt` pattern (break-only). See Proposed Changes §3 for the reason.
- **Verb registration**: `docsHealthCopyPrompt` must be added to `protocol-catalog.json` under `providers.planning.verbs[]` (the array that includes `createPlansCopyPrompt`, `createPlansImproveSource`, etc. around line 1011), AND in the schema section with `"payloadKeys": ["type"]` (alongside the existing `createPlansImproveSource` schema entry around line 7853). Then run `npm run catalog:generate` to regenerate `src/generated/verbAllowlist.ts`. Do NOT hand-edit `src/generated/verbAllowlist.ts` — it is auto-generated and the next `catalog:generate` will wipe manual edits.

  > **Superseded:** Add `docsHealthCopyPrompt` to `src/generated/verbAllowlist.ts` (the existing allowlist that gates webview→host messages).
  > **Reason:** `src/generated/verbAllowlist.ts` is auto-generated from `protocol-catalog.json` (its first line: `// AUTO-GENERATED — do not edit; run \`npm run catalog:generate\`.`). Hand-editing it means the next `catalog:generate` wipes the addition, and `parity:check` in CI fails because the allowlist no longer matches the catalog.
  > **Replaced with:** Add `docsHealthCopyPrompt` to `protocol-catalog.json` under `providers.planning.verbs[]` and in the schema section with `"payloadKeys": ["type"]`, then run `npm run catalog:generate` to regenerate the allowlist.

- **Browser host parity**: the Connections panel is also served in the browser standalone (`src/standalone/`). The verb handler must work through the `/connections/verb` HTTP path (LocalApiServer.ts line 4418), same as the other create-plans verbs. The handler must `return` its result so transport.js can re-dispatch it to the webview (the `createPlansInit` pattern at PlanningPanelProvider.ts:3037).
- **Prompt content**: the prompt must be self-contained — it cannot reference Switchboard-specific files, paths, or architecture. It describes general doc categories with examples of how each manifests in different project types (web service, CLI, library, extension, mobile app). The agent receiving the prompt determines which forms are relevant for the specific project.
- **No live scanning**: confirmed by user. The UI is a static list of recommended doc categories with descriptions + a copy-prompt button. No file-system scanning, no status indicators, no "exists/missing" checks. The prompt tells the agent to do the scanning.
- **Scheduled vs one-shot**: the prompt should be framed as usable either way. It says "check if these docs exist and are current; create or update as needed" — which works as a one-shot run or a nightly scheduled job. The UI should mention "paste into a scheduled agent for nightly maintenance" as a suggestion, not a requirement.
- **Relationship to "Improve my docs" button**: the existing button in the Web Agents tab is about improving *existing* docs (clarity, organization). The Docs Health tab is about *creating and maintaining structural docs* that aid planning. They're complementary, not overlapping. No change to the existing button.

## Dependencies

- Companion plan "Planning Navigational Docs" creates the actual docs for the Switchboard repo itself (using the Switchboard-specific forms of these categories). This plan creates the product feature that recommends the general categories to all users. They can ship independently — the Docs Health tab recommends doc types generically and doesn't depend on the Switchboard repo's own docs existing.

## Adversarial Synthesis

**Risk Summary:** Key risks: verb allowlist edited directly instead of via protocol-catalog.json (critical build-system fix — the file is auto-generated); response mechanism mismatch — createPlansCopyPrompt pattern doesn't push a result message, so webview feedback never fires (critical functional fix — use createPlansInit push+return pattern instead); line number inaccuracies in connections.html and connections.js (practical fix — verified anchors provided); missing schema entry in protocol-catalog.json (completeness fix). Mitigations: route through protocol-catalog.json + catalog:generate, use push+return pattern, update line references, add payloadKeys entry.

**Challenge: "Why a sub-tab and not just a section in the Web Agents tab?"**
The Web Agents tab is already a 3-step flow (where are your docs → paste plan back → improve docs). Adding a docs-health section would make it a 4-step flow with a different purpose (maintaining docs vs creating plans). A separate sub-tab keeps each tab focused on one job. The user explicitly chose "new sub-tab" over "section in Web Agents tab."

**Challenge: "The prompt will be too generic to be useful — every project's docs are different."**
This is the core design tension. The resolution: the prompt describes *categories of orientation* (not fixed doc specs) and gives concrete examples of how each category manifests in different project types. The agent determines which forms are relevant and builds its own scanner logic. The user explicitly said: "have some guidance for an agent to make its own scanner logic. Not all docs conventions are the same." The prompt is a framework, not a template.

**Challenge: "Users won't find this tab — it's the fifth tab in Connections."**
True discoverability concern. Mitigation: the tab label "Docs Health" is self-explanatory, and the tab content leads with a plain-language intro: "Good docs = good plans. These are the docs that help your planning agent write better plans." The Web Agents tab's intro already says "How detailed the plan is tracks how good your docs are" — we could add a cross-reference line there pointing to the Docs Health tab.

**Challenge: "What if the user has no docs folder configured?"**
The Docs Health tab doesn't require a configured docs folder — it's a static recommendation list + a copy-prompt button. The prompt itself tells the agent to scan the project and create docs in whatever location makes sense. No dependency on the LocalFolderService or managed-docs infrastructure.

**Challenge: "Three categories or four? Is 'navigation aids for large files' universal enough to list?"**
It's conditional — a small project may have no files large enough to need TOCs. But the category card can note "only relevant if the project has large source files" and the prompt can instruct the agent to skip it if no files exceed a threshold. Listing it is better than omitting it — a user with a large codebase won't know to ask for it if it's not shown. The card description should make the conditional nature clear.

**Challenge: "The response mechanism — createPlansCopyPrompt just breaks, so no webview feedback."**
The `createPlansCopyPrompt` arm writes to clipboard and shows a host-side notification, then `break`s. No message is pushed to the webview. But the Docs Health tab wants an in-webview "Copied to clipboard!" status line (`#dh-status`). The arm must push `docsHealthPromptResult` via `this.postMessageToWebview()` AND return it for browser host re-dispatch — the `createPlansInit` pattern (PlanningPanelProvider.ts:3036-3037), not the `createPlansCopyPrompt` pattern.

## Proposed Changes

### 1. Add "Docs Health" sub-tab to `src/webview/connections.html`

**Tab button** (after the Web Agents button at line 312):
```html
<button class="shared-tab-btn" data-tab="docs-health" role="tab" aria-selected="false">Docs Health</button>
```

**Tab content** (after the web-agents-fields div, which ends at line 572):
A new `<div class="shared-tab-content" id="docs-health-fields" data-tab-content="docs-health">` containing:

- **Intro section**: plain-language explanation: "Good docs make good plans. When you point a planning agent at your docs, these are the kinds of docs that help it understand your product and write better plans. Copy the maintenance prompt below and paste it into a scheduled agent (like a Spark scheduled run) to create and keep these docs updated."

- **Doc categories list**: 4 cards, one per general doc category. Each card describes the *intent* (what orientation it provides) and gives examples of how it manifests in different project types:

  1. **Architecture / Component Map** — "A map of what your product is and how its pieces fit together. Helps the agent understand the project's structure without reading every file."
     - *Why this helps*: The agent knows where to look instead of searching broadly.
     - *Looks like*: A folder-layout overview plus a table mapping features or UI areas to their source files. For a web service: routes→handlers→models. For a CLI: commands→modules. For a library: public API→internal modules.

  2. **Data-Flow / Interface Index** — "A list of how information moves through your system — the entry points, the messages, the interfaces between layers. Helps the agent find where things happen and how they connect."
     - *Why this helps*: The agent can trace a user action to the code that handles it without guessing.
     - *Looks like*: For a web service: API endpoints with method, path, handler, and purpose. For a browser extension: message types and their handlers. For an event-driven app: event names, publishers, and subscribers. For a CLI: flags, subcommands, and what they do. For a library: exported functions/classes and what they do.

  3. **Search Scoping Guidelines** — "A note telling the agent where your source code lives and where your build artifacts, generated files, and dependencies are. Prevents the agent from reading stale or generated files."
     - *Why this helps*: The agent searches the right directories and ignores noise.
     - *Looks like*: A short section in your README or root docs: "Source is in `src/`. Build output is in `dist/` (or `build/`, `out/`, `.next/`, `target/`). Don't read generated files or `node_modules/`."

  4. **Navigation Aids in Large Files** — "A table of contents at the top of large source files listing the major sections with line numbers. Lets the agent jump straight to the relevant code." *(Only relevant if your project has large source files — roughly 500+ lines.)*
     - *Why this helps*: The agent opens the file it needs and goes straight to the right section.
     - *Looks like*: A comment block near the top of the file: `// Sections: State (L20), Renderers (L150), Event Handlers (L300), Message Dispatch (L500)...`

  Each card has: a title, a plain-language description, a "Why this helps" sub-line, and a "Looks like" sub-line with project-type examples.

- **Copy prompt section**: a button `<button id="dh-btn-copy" class="strip-btn strip-btn--primary">Copy docs maintenance prompt</button>` with a hint: "Paste into a scheduled agent to create and update these docs nightly. Works with any agent — Spark, Claude, Devin, or a cron-triggered CLI agent."

- **Status line**: `<span id="dh-status" class="cp-hint"></span>` for "Copied!" feedback.

### 2. Wire the copy button in `src/webview/connections.js`

Add an event listener for `dh-btn-copy` that posts `{ type: 'docsHealthCopyPrompt' }` to the host. Handle the response message `docsHealthPromptResult` to show "Copied to clipboard!" in the status line.

The tab-switching logic (lines 18-29) already handles arbitrary tabs via the `data-tab` / `data-tab-content` pattern — no change needed there. No init message needed for this tab (unlike web-agents which sends `createPlansInit`).

### 3. Add `docsHealthCopyPrompt` handler in `src/services/PlanningPanelProvider.ts`

> **Superseded:** Follow the exact pattern of `createPlansImproveSource` (line 3145) and `createPlansCopyPrompt` (line 3039).
> **Reason:** `createPlansCopyPrompt` just `break`s after clipboard write — no message is pushed to the webview. But the Docs Health tab wants an in-webview "Copied to clipboard!" status line (`#dh-status`). Without a pushed response message, the status line never updates and the button appears to do nothing.
> **Replaced with:** Follow the `createPlansInit` pattern (line 3019-3037): push the result via `this.postMessageToWebview()` AND `return { success: true, ...result }` so transport.js can re-dispatch in the browser host.

- Add `case 'docsHealthCopyPrompt':` to the verb handler switch.
- Assemble a prompt string (extract as a named constant `DOCS_HEALTH_PROMPT` at the top of the file, like `CREATE_PLANS_CORE_PROMPT`, rather than inline in the case arm) that:
  - Explains the agent's role: "You are maintaining planning docs for a project. These docs help planning agents write better plans by providing navigational orientation — understanding the project's structure, data flows, and code organization without reading every file."
  - Lists the 4 general doc categories with intent, examples across project types, and creation instructions:
    1. **Architecture / Component Map**: "Determine the project's structure — what are the major pieces and how do they relate? Create or update a markdown file (e.g. ARCHITECTURE.md) that maps features, UI areas, or modules to their source files. Include a folder-layout overview. The form depends on the project type: a web service maps routes→handlers→models; a CLI maps commands→modules; a library maps public API→internal modules; a browser extension maps panels→HTML→scripts→providers. If a map exists, verify the mappings are still accurate and update stale references."
    2. **Data-Flow / Interface Index**: "Identify how information moves through the system — the entry points, messages, or interfaces between layers. Create or update a markdown file listing each one with where it's defined, where it's handled, and its purpose. The form depends on the project: a web service lists API endpoints (method, path, handler, purpose); a browser extension lists message types and handlers; an event-driven app lists events, publishers, subscribers; a CLI lists flags and subcommands; a library lists exported functions/classes. If an index exists, verify entries are current. If the project has no inter-layer communication (e.g. a single-file script), note that and skip."
    3. **Search Scoping Guidelines**: "Identify which directories contain source code vs build artifacts, generated files, and dependencies. Check the project's root README or agent instructions for a note telling agents where to search and where not to. If missing, add a short section naming the source directories and the directories to ignore. Build your own logic to distinguish source from generated — common signals: the directory is in .gitignore, it's listed as an output in a build config, or it contains compiled/transpiled output."
    4. **Navigation Aids in Large Files**: "Identify source files over ~500 lines. For each, check if it has a table-of-contents comment block near the top listing major sections with approximate line ranges. If missing, read the file, identify its major regions, and add a TOC comment block in the appropriate comment syntax for the language. If present, verify the line ranges are still approximately accurate. If no files exceed the threshold, note that and skip."
  - Includes the "build your own scanner logic" guidance: "You determine what's relevant — check file existence, compare referenced paths against actual paths, verify line ranges are still accurate, and determine which forms of each category apply to this project's architecture. Doc conventions vary by project; adapt the format, filenames, and structure to what makes sense for this project. Skip any category that doesn't apply (e.g. a project with no large files doesn't need file TOCs; a single-file script doesn't need a data-flow index)."
  - Ends with: "Report back with a summary of what you created, updated, confirmed as current, or skipped and why."
- Write the prompt to clipboard via `this._seams().clipboard.writeText(DOCS_HEALTH_PROMPT)`.
- Show temporary notification: "Docs maintenance prompt copied to clipboard".
- Push the result to the webview AND return it (the `createPlansInit` pattern):
  ```typescript
  const result = { type: 'docsHealthPromptResult', success: true };
  this.postMessageToWebview(result);
  return { success: true, ...result };
  ```
  This ensures the webview's `#dh-status` updates in both the VS Code host (via `postMessageToWebview`) and the browser host (via the HTTP return body, which transport.js re-dispatches).

### 4. Register `docsHealthCopyPrompt` in `protocol-catalog.json` and regenerate the allowlist

> **Superseded:** Add `docsHealthCopyPrompt` to `src/generated/verbAllowlist.ts`.
> **Reason:** `src/generated/verbAllowlist.ts` is auto-generated from `protocol-catalog.json`. Hand-editing it is wiped on the next `catalog:generate` and breaks `parity:check` in CI.
> **Replaced with:** Add the verb to `protocol-catalog.json` and run `npm run catalog:generate`.

1. Add `"docsHealthCopyPrompt"` to the `providers.planning.verbs[]` array in `protocol-catalog.json` (alphabetically positioned, alongside `createPlansCopyPrompt` etc. around line 1011).
2. Add a schema entry in the `verbSchemas` section of `protocol-catalog.json` (alongside the `createPlansImproveSource` entry around line 7853):
   ```json
   "docsHealthCopyPrompt": {
     "payloadKeys": ["type"],
     "siteCount": 1
   }
   ```
3. Run `npm run catalog:generate` to regenerate `src/generated/verbAllowlist.ts` (and any other generated files).
4. Verify `npm run parity:check` passes (allowlists ≡ catalogs).

### 5. Add response handler in `src/webview/connections.js`

Handle `docsHealthPromptResult` message type in the main message listener's switch block (the `window.addEventListener('message', ...)` at line 701, switch block starting at line 705). Add a new `case 'docsHealthPromptResult':` alongside the existing `createPlansState` / `createPlansFolderPicked` / `createPlansPasteBackResult` cases (around line 788). On success, show "Copied to clipboard!" in `#dh-status`. On failure, show the error message.

### 6. Add cross-reference in Web Agents tab intro

In `connections.html`, the Web Agents tab intro is inside the `<div class="cp-intro">` at lines 514-517. The intro currently ends with "How detailed the plan is tracks how good your docs are." Add a line after it: "See the **Docs Health** tab for the kinds of docs that make the biggest difference."

## Verification Plan

- [ ] Connections panel shows a fifth sub-tab labeled "Docs Health".
- [ ] Clicking the tab shows 4 doc-category cards with plain-language descriptions, "Why this helps" sub-lines, and "Looks like" examples that span multiple project types (web service, CLI, library, extension).
- [ ] The category cards describe general intents, not Switchboard-specific doc specs. No card mentions postMessage, webviews, dist/, or VS Code by name.
- [ ] The "Navigation Aids" card notes it's only relevant for projects with large source files.
- [ ] Clicking "Copy docs maintenance prompt" copies a prompt to the clipboard and shows "Copied to clipboard!" in `#dh-status` (verifies the push+return response mechanism works).
- [ ] The copied prompt is self-contained (no Switchboard-specific paths or references), lists all 4 general doc categories with intent + project-type examples + creation instructions, includes the "build your own scanner logic" guidance, and instructs the agent to skip categories that don't apply.
- [ ] The prompt works as a one-shot or scheduled instruction (no hardcoded schedule cadence).
- [ ] Tab switching between all 5 tabs works correctly (no broken active states).
- [ ] Browser standalone: the verb `docsHealthCopyPrompt` works through the `/connections/verb` HTTP path (returns `{ success: true, type: 'docsHealthPromptResult' }` in the response body for transport.js re-dispatch).
- [ ] `protocol-catalog.json` has `docsHealthCopyPrompt` in `providers.planning.verbs[]` and in the schema section with `"payloadKeys": ["type"]`.
- [ ] `npm run catalog:generate` regenerates `src/generated/verbAllowlist.ts` with the new verb.
- [ ] `npm run parity:check` passes (allowlists ≡ catalogs).
- [ ] `npm run lint` passes.
- [ ] `npm run compile` passes.
- [ ] Existing create-plans flow (zip, link, platform, paste-back, improve) is unaffected.
- [ ] Existing Jobs tab and Spark Context regenerator are unaffected.

## Completion Report

Implemented the Docs Health sub-tab end-to-end. Added the fifth sub-tab button (`data-tab="docs-health"`) and a `#docs-health-fields` content div with intro, 4 doc-category cards (Architecture/Component Map, Data-Flow/Interface Index, Search Scoping Guidelines, Navigation Aids in Large Files — each with plain-language description, "Why this helps", and "Looks like" examples spanning web service/CLI/library/extension/mobile app), a `#dh-btn-copy` button, and a `#dh-status` span to `src/webview/connections.html`; also added the cross-reference line to the Web Agents `cp-intro`. Wired the copy button in `src/webview/connections.js` to post `{ type: 'docsHealthCopyPrompt' }` and added a `case 'docsHealthPromptResult':` arm writing "Copied to clipboard!" (or error) into `#dh-status`. Added a module-level `DOCS_HEALTH_PROMPT` constant and a `case 'docsHealthCopyPrompt':` arm to `src/services/PlanningPanelProvider.ts` using the `createPlansInit` push+return pattern (`postMessageToWebview` AND `return { success: true, ...dhResult }`), not the break-only `createPlansCopyPrompt` form. The prompt is self-contained and tool-agnostic (no Switchboard/VS Code/postMessage/dist references), describes the 4 categories generically with per-project-type examples, instructs the agent to build its own scanner logic and skip non-applicable categories, and ends with a created/updated/confirmed/skipped summary ask. Ran `npm run catalog:generate` which regenerated `protocol-catalog.json` (verb in `providers.planning.verbs[]`, schema entry `payloadKeys: ["type"]`, `siteCount: 1`) and `src/generated/verbAllowlist.ts` (verb in `PLANNING_VERBS`). Per directive, skipped `npm run compile`, `npm run lint`, `npm run parity:check`, and automated tests. All edits additive around the existing Jobs-tab working-tree changes — no reverts, no commits. No issues encountered.


## Review Findings

Reviewed against this plan; one CRITICAL and one compile-blocking defect fixed in `src/services/PlanningPanelProvider.ts`. The as-committed arm did not compile — `return { success: true, ...dhResult }` is TS2783 (`success` specified before a spread that also carries it), so `npm run compile`, a CI gate, was red on the shipped code. Separately the arm faked success on the browser host: the standalone clipboard seam is a no-op logger (`src/standalone/hostServices.ts`), so `clipboard.writeText` copies nothing there and the returned body carried no `prompt`, leaving `#dh-status` to report "Copied to clipboard!" over an empty clipboard — a dead-button/false-success the PRD forbids; the arm now returns `{ ...dhResult, prompt: DOCS_HEALTH_PROMPT }` so `transport.js` writes it client-side, and the verb was added to `docs/IPC_PROTOCOL.md`. Verified green after the fix: `compile`, `lint` (0 errors), `catalog:check`, `parity:check`, `verb-returns:check`, `push-routing:check`, `standalone-parity:check`, `standalone-fork:check`, and `test:contract:connections-routing` (14/14) / `panel-runtime-surface`. Remaining risks, both unfixed and belonging to other streams: `npm run test:contract:browser-panel-verb-routing` is RED because this commit also swept in ~215 lines of another team's in-flight Jobs-tab code in `connections.js`, whose `copyTextToClipboard` post is reachable on the browser `/connections/verb` route (falls back to `TASKVIEWER_VERBS`) but not through `ConnectionsPanelProvider` in the editor host, which only checks `SETUP_VERBS`/`PLANNING_VERBS`; and the editor host receives `docsHealthPromptResult` twice (arm push plus the forwarded return body), which is idempotent here and matches the existing `createPlansInit` precedent.
