# Create Plans — point an agent at your docs and get a plan back

## Goal

Give Switchboard a single, obvious place that surfaces a workflow it already supports but nobody discovers: **point an agent at your project's docs, have it write a high-level plan (user flows and logic — not code), and paste that plan back onto the board.** The agent can be an external web chat *or* a local agent on the user's machine — anything that isn't Switchboard's own code planner. The tab adds no new power; it makes an invisible capability obvious and guides users to hash out the *what* and the *how-it-should-behave* before the code planner turns it into an implementation. Let the user point the agent at wherever their docs already live — a generated zip, a public link (GitHub Pages / public repo branch / any URL), or a platform reference (Notion / ClickUp / Linear, read via that platform's MCP). Remove the existing NotebookLM export, which bundles the whole repo (including code) and pulls agents toward implementation.

### Problem & background

**This is a discoverability problem first.** The workflow already works — you can hand your docs to any agent today and paste the resulting plan onto the board — but nothing surfaces it, so it goes unused. Switchboard's own author forgot the capability existed for *months* in his own open-source repo. That is the problem being solved. The pieces that do exist point the wrong way:

- **The NotebookLM export bundles the entire git repo — code and all.** Handing an agent the codebase makes it reason about *implementation*: files, functions, how things are wired. That is the opposite of what a planning partner is for, whose value is thinking about *what the product should do* unencumbered by how it's currently built.
- **The paste-a-plan intake is buried and uninstructed.** Nothing tells the agent that a Switchboard plan should stay at the level of flows and logic, so pasted plans are inconsistent and drift into premature implementation detail.
- **There is no front door for "let an agent help me plan from my docs" at all** — least of all for a brand-new workspace with no plans yet, which is exactly when "help me draft my first plans" is most useful.

### The principle this fixes

Plans should start as **high-level user flows and logic**, then become code — not the other way round. Going straight to code skips the important work of defining the base logic and the user experience. An agent handed your docs should produce a plan describing **how the product should behave** — the flows, the expected outcomes, the edge cases in user terms. Switchboard's own deep-planning and coding fleet turn that behaviour plan into code afterwards, once it is on the board. How detailed the agent can be is entirely a function of how good the docs are — **that is the user's responsibility, and Switchboard makes no attempt to model or grade it.** There is deliberately no notion of "intent docs" vs "dev docs," no toggle, and no requirement that the agent see code: docs are docs, and the user decides how detailed theirs are.

## Metadata

**Complexity:** 4
**Tags:** frontend, backend, ux, feature, docs

_(No project named and no PROJECT PIN directive present — this plan lands unassigned and can be reassigned on the board.)_

## User Review Required

Yes — this deletes a shipped export and introduces a new tab. Confirm before dispatch:
1. **Remove the NotebookLM export** entirely (it bundles code; it conflicts with the docs-not-code principle).
2. **Doc delivery is a source picker** — a generated zip, a public link, or a platform reference — and **never** source code, even as an option.
3. **No dev-docs toggle, no folder roles, no "current behaviour vs vision" modes.** Docs are undifferentiated; there is one prompt. (This removes the apparatus a prior version of this plan carried; the merge plan's folder-role addition is cut with it.)
4. **Public link and platform reference are bring-your-own** — Switchboard stores the reference the user provides and hands it to the agent via the prompt. It does not host, and it does not fetch. The zip is the only thing Switchboard actually produces.
5. **Workspace-first, project-optional** — the tab works with zero projects; a project only *narrows* the bundle and *pins* the result when one is active.

## Complexity Audit

### Routine
- New `Create Plans` tab markup in `planning.html` — a single new `shared-tab-btn` + content pane following the existing tab pattern (tab strip at lines 3694–3699), taking the slot the deleted NOTEBOOKLM tab vacates. UI-only.
- "Copy planning prompt" clipboard button — reuses the existing `clipboard.writeText` + `showTemporaryNotification` pattern already used by `draftImproveDevDoc` (PlanningPanelProvider.ts:2786–2787).
- "Download docs zip" — a new docs-scoped bundler that reuses the traversal/chunking shape of `ContextBundler.bundleWorkspaceContext` but constrains the source set to docs.
- Paste-back field — reuses the existing `switchboard.importPlanFromClipboard` command (extension.ts:957) and `_createInitiatedPlan` (TaskViewerProvider.ts:19177).
- Remembered public docs URL + platform reference — per-workspace config keys, same store pattern as `notebook.root`.
- Removing the NotebookLM docs page on `switchboard-site` and repointing its `prev`/`next` neighbours — prose + frontmatter edits.

### Complex / Risky
- **Full removal of the NotebookLM export across seven surfaces.** A partial removal leaves dangling verb-allowlist entries that compile fine but point at deleted handlers (see Proposed Changes → `protocol-catalog.json`). Requires symbol-by-symbol deletion, not a broad grep.
- **Paste-back project pinning wiring.** The existing `importPlanFromClipboard` → `_createInitiatedPlan` call passes NO `projectName` (TaskViewerProvider.ts:18891). The mechanism exists (`_createInitiatedPlan` honours `options.projectName` → `db.assignPlansToProject`, lines 19244–19255) but the wiring does not. The coder must thread `kanban.activeProjectFilter` through.
- **Docs-only bundler invariant.** The zip bundler must refuse source files by design; a future "include this one .ts file" request would erode the principle. Needs a code-level invariant comment at the bundler's entry point. (This applies only to the zip source — the public-link and platform-reference sources are pointers the user controls.)

## Edge-Case & Dependency Audit

**Race Conditions**
- The optional "Improve my docs" handoff writes back to a Docs-tab managed folder while the Docs tab's active-doc watcher (`_setupActiveDevDocWatcher` → its post-merge equivalent) is armed. The watcher already suppresses panel-initiated writes and reloads on external edits — the agent's write is an external edit, so the Docs tab live-reloads. No new race.
- Paste-back while a plan-file creation is already in flight: `_createInitiatedPlan` uses `_pendingPlanCreations` / `_planCreationInFlight` guards and `GlobalPlanWatcherService.registerPendingCreation` — the existing paste path already handles this. No new logic needed.

**Security**
- The public-link and platform-reference paths are bring-your-own; Switchboard does not fetch them, so there is no SSRF surface — the reference is handed to the external agent via the clipboard prompt, not requested by Switchboard.
- The private zip is uploaded by the user to a vendor of their choice; the tab's wording must not overclaim privacy. The zip contains only docs. Confirm the docs-scoped bundler excludes `.env`, secret files, and anything outside the curated doc set even if a doc folder happens to contain them (extension allowlist `.md` + `.txt`).

**Side Effects**
- Removing the NotebookLM export orphans the persisted `notebook.root` webview-state key and the `.switchboard/NotebookLM/` output folder. The folder is disposable output (leave it in place); the state key is harmless (ignored). A one-time cleanup on panel load is cheap but optional.
- Users who relied on the NotebookLM DOCX bundle for non-planning purposes lose it. The plan's thesis is that docs-not-code is the correct replacement; release notes must say so.

**Dependencies & Conflicts**
- **`merge-dev-docs-into-docs-tab.md` — soft coupling only, NOT a hard dependency.** This plan reuses the consolidated Docs tab (single docs model) as the source of the doc set it bundles, and reuses that tab's Draft-with-agent handoff for the optional "improve my docs" button (`draftImproveLocalDoc` post-merge, `draftImproveDevDoc` pre-merge — the optional button doesn't block on the exact name). It also takes the `planning.html` tab slot the NotebookLM tab vacates. **There is no accessor contract and no strict sequencing** — the two plans can ship in either order. If both are in flight, whoever lands second reconciles the `planning.html` tab strip and the switchboard-site prev/next chain.
- **`redistribute-project-html-tabs.md` — interaction dissolved.** That plan wanted to move NotebookLM out of `project.html`. Its premise is outdated: `project.html` has 6 tabs (lines 1214–1219) and NotebookLM lives in `planning.html` (line 3699). This plan *deletes* NotebookLM entirely and puts Create Plans in the vacated `planning.html` slot. Net: `planning.html` 6→6, `project.html` untouched.
- **`project-html-dev-docs-tab-and-ia.md` — moot.** That older plan moved NotebookLM INTO `project.html`; the current code shows it back in `planning.html`, so the move was reverted. This plan removes NotebookLM outright.
- **`cross-platform-agent-collaboration.md` — supersedes its near-term rationale.** This plan delivers the simple "an agent helps produce a plan" version; the collaboration plan's live co-authoring scope remains separate and should be shelved unless live co-authoring is genuinely wanted.

## The source picker (the one real mechanism)

The tab's only real choice is **where the docs are**; Switchboard hands the agent the right pointer plus the planning instructions. Three sources:

1. **Generated zip** — Switchboard bundles the managed doc set (constitution + PRDs + README + curated Docs-tab folders) into a markdown zip that also carries `HOW-TO-PLAN.md`. This is the fallback for when docs aren't hosted anywhere. **Docs-only by design** — it never invokes `git ls-files` and never includes source code.
2. **Public link** — the user pastes a URL where their docs are published (GitHub Pages, a public repo branch, any fetchable location). Switchboard remembers it. The copied prompt points the agent at the URL.
3. **Platform reference** — the docs live in Notion / ClickUp / Linear. The copied prompt tells the agent to read them via that platform's **MCP**, given the reference the user provides (a page URL / list ID / doc link). Switchboard stores the reference; it does not fetch.

The intent is to make it trivial for the agent to find the best location; Switchboard is agnostic about where docs live and only ever *produces* the zip.

## The generated prompt (product copy — behaviour, not code)

Shipped as `HOW-TO-PLAN.md` inside the zip, and as the copyable prompt for the public-link and platform sources. **One prompt**, adapted only by a single source-specific line that tells the agent *where and how* to read the docs.

**Shared core:**
```
You are helping plan a change to a product. You have its docs — read them and
write a plan that describes DESIRED BEHAVIOUR:
- What should the product do? What is the user flow, start to finish?
- What are the expected outcomes and the edge cases, in user terms?
- What is explicitly out of scope?

Do NOT write code, choose libraries, or design implementation. Stay at the level
of user flows and logic — how it should work, not how it is built. Defining the
base logic and the user experience is the point; turning it into code happens
later, inside the tool this plan goes back into.

Return the plan as markdown with a short title, a Goal, the flows/expected
behaviour, and edge cases. It will be pasted directly onto a planning board.
```

**Source-specific line prepended:**
- **Zip:** (no prepend needed — `HOW-TO-PLAN.md` ships inside the zip alongside the docs).
- **Public link:** `The docs are published at <URL>. Read them there.`
- **Platform:** `The docs live in <Notion|ClickUp|Linear> at <reference>. Use the <platform> MCP to read them.`

## Flows

### Flow A — Pick a source, hand off
1. User opens **Create Plans** and picks a doc source (zip / public link / platform reference).
2. For a link or platform, the user provides/confirms the reference once (Switchboard remembers it). For the zip, nothing is needed.
3. User clicks **Copy planning prompt** (link/platform) or **Download docs zip** (zip). The clipboard / zip carries the behaviour-only instruction.
4. User pastes into any agent — an external web chat or a local agent on their machine. The agent returns a behaviour plan.

### Flow B — Paste the plan back
1. User pastes the agent's plan into the tab and confirms.
2. A plan card is created on the board from the pasted markdown.
3. **Pinning:** if a project is currently active, the card is pinned to it; if not, it lands **unassigned** (never pin the workspace name, never invent a project).
4. The user then runs Switchboard's normal internal flow (improve/deep-plan → code) on that card.

### Flow C — Project active (narrowing)
When a project is selected, the zip/pointer additionally scopes to that project's PRD and linked docs, and paste-back pins to that project. Everything else is identical. Projects are a refinement, never a requirement.

### Cold start / thin docs (optional helper, not a gate)
- If there are no docs to point at, the tab says so and points the user at the existing PRD / constitution builders to write a first doc. It does not produce an empty pack.
- An **optional** "Improve my docs with an agent" button reuses the Docs tab's Draft-with-agent handoff to help flesh out thin docs. It is plain doc editing — **optional, never gated, and not a code-reading step.** The old "Flow 0: generate dev docs from code and auto-tag the folder" is removed; nothing here reads code.

## Expected behavior of the Create Plans tab

- Lives in the planning (artifacts) webview (`planning.html`), in the slot the deleted NOTEBOOKLM tab vacates — next to the Docs tab that holds its source material. The board it feeds (in `project.html`) is reached via the paste-back backend path, not UI adjacency.
- Renders and fully functions **with no projects and no plans**.
- Presents the loop in order: **pick a source → package / point → take to an agent → paste back**, with the optional "improve my docs" helper available but skippable.
- The planning prompt is one click to clipboard; the zip is one click to download.
- **Never offers an "include code" option.** The docs-not-code boundary is not user-configurable.

## Removing the NotebookLM export

- Remove the whole-repo NotebookLM bundling feature and its entry points from the UI.
- **Rationale:** it bundles code, which is exactly what this feature establishes agents should not receive.
- **Existing users / on-disk output:** the export only ever wrote generated files under `.switchboard/NotebookLM/`. Stop generating; leave any existing folder in place (disposable output) and mention the removal in release notes. No user data is stored there.
- Update the published docs site to drop the NotebookLM page and repoint its prev/next neighbours.

### Seven surfaces
- **`src/services/ContextBundler.ts`:** delete `bundleWorkspaceContext` (or leave the function but remove all call sites — prefer delete, since the new docs bundler is separate).
- **`src/services/PlanningPanelProvider.ts`:** delete `_handleAirlockExport` (line 9385) and the message cases `airlock_export` (3367), `airlock_openNotebookLM` (3372), `airlock_openAIStudio` (3376 — keep only if AI Studio is used elsewhere; check), `airlock_openFolder` (3380), `importNotebookLMPlans` (3353), `notebookDefaultRoot` (2648). Remove the `bundleWorkspaceContext` import.
- **`src/extension.ts`:** delete the `switchboard.importNotebookLMPlans` command registration (lines 962–965).
- **`src/services/TaskViewerProvider.ts`:** delete `importNotebookLMPlans` (line 18907) and any private helpers it alone uses.
- **`src/webview/planning.html` + `planning.js`:** delete the NOTEBOOKLM tab button (planning.html:3699) and its content pane + JS handlers (planning.js: 2701, 4924, 5022, 5086, 12502, 12538).
- **`protocol-catalog.json` + `src/generated/verbAllowlist.ts`:** remove the NotebookLM verb entries (15 matches in protocol-catalog.json) and **add** the new `createPlansCopyPrompt` / `createPlansDownloadZip` / `createPlansPasteBack` / `createPlansImproveSource` verbs. **Edit `protocol-catalog.json`, then regenerate via `npm run catalog:generate` — do not hand-edit the generated file.**
- **`switchboard-site/src/pages/docs/artifacts/notebooklm.md`:** delete the page and repoint the `prev`/`next` frontmatter chain on its neighbours before the Astro build, or DocsLayout renders dead links.

## Proposed Changes

### `src/webview/planning.html` (+ `planning.js`)
- **Context:** The tab lives in the planning webview, next to the Docs tab — NOT in `project.html`. This plan deletes the NOTEBOOKLM tab from `planning.html` (line 3699); Create Plans takes that slot (net tab count 6→6).
- **Logic:** Add `<button class="shared-tab-btn" data-tab="create-plans">CREATE PLANS</button>` where the NOTEBOOKLM button was. Add a `<div id="create-plans-content" class="shared-tab-content">` pane rendering: (1) a **source picker** (segmented control / radios: Zip · Public link · Platform), (2) a public-URL field (shown for Public link) and a platform + reference field (shown for Platform), (3) **Copy planning prompt** (link/platform) and **Download docs zip** (zip) buttons, (4) a paste-back textarea + "Create plan card" button, (5) an optional "Improve my docs with an agent" button.
- **Implementation:** Reuse the existing `shared-tab-btn` / `shared-tab-content` CSS and tab-switch JS. The buttons post `createPlansCopyPrompt` / `createPlansDownloadZip` / `createPlansPasteBack` / `createPlansImproveSource`; the source choice and reference are sent with the copy/zip messages.
- **Edge Cases:** With no usable source (no docs and no reference), the package actions are `disabled` and the tab points the user to write a first doc. With no public URL set, the link source's Copy button is greyed with a hint. The tab never produces an empty zip.

### `src/services/PlanningPanelProvider.ts`
- **Context:** Serves both `project.html` and `planning.html` through the same `_handleMessage` router; replies route via `isProject ? _projectPanel : _panel`. The existing `draftImproveDevDoc` handler (lines 2763–2788) builds a clipboard prompt — the shape the "improve my docs" button reuses.
- **Logic — new handlers:**
  - `createPlansCopyPrompt`: assemble the behaviour-only instruction (product copy above), prepend the source-specific line for the chosen source (public URL or platform reference), write to clipboard.
  - `createPlansDownloadZip`: call the new docs-scoped bundler (below), write `HOW-TO-PLAN.md` into the zip, return the zip path for download.
  - `createPlansPasteBack`: read the pasted markdown, resolve `kanban.activeProjectFilter` (best-effort via `_kanbanProvider?.getProjectFilter()`), call `_createInitiatedPlan(title, text, false, { skipBrainPromotion: true, projectName: activeProject || undefined })`. **This is the wiring `importPlanFromClipboard` does NOT do today** (TaskViewerProvider.ts:18891 passes no `projectName`).
  - `createPlansImproveSource` (optional): reuse the `draftImproveDevDoc`/`draftImproveLocalDoc` prompt-building shape, wording tailored to "lay these docs out as a clear behavioural source for planning." Targets a Docs-tab managed folder the user selects. Optional, not gated.
- **Implementation:** Prefer extending `importPlanFromClipboard` to accept an optional `projectName` so there is one paste-to-board path, rather than calling `_createInitiatedPlan` directly.
- **Edge Cases:** Pasted content with no H1/H2/H3 falls back to "Imported Plan" (existing behaviour). Pasted content >200 KB is rejected (existing guard). Project-filter read fails → paste-back lands unassigned (never invent a project). Remembered public URL and platform reference are per-workspace config keys (store pattern like `notebook.root`).

### `src/services/ContextBundler.ts` (new docs-scoped bundler)
- **Context:** The existing `bundleWorkspaceContext` (line 64) bundles the whole git repo into DOCX parts — what the NotebookLM export uses and this plan removes. The new bundler is docs-only.
- **Logic:** Add `bundleDocsContext(workspaceRoot, { activeProject? }): Promise<{ zipPath: string }>`. Source set = constitution + PRDs (all, or the active project's) + README + curated Docs-tab folders. **Never** invoke `git ls-files`; enumerate only the curated doc set, filtered to `.md` + `.txt`. Emit a markdown zip + `HOW-TO-PLAN.md`.
- **Implementation:** Reuse the chunking/manifest shape of `bundleWorkspaceContext` but constrain the source set at the entry point. Add an invariant comment at the top: `// DOCS-ONLY BY DESIGN. Do not add a code-inclusion option — see plan create-plans-tab-docs-only-agent-intake.md.`
- **Edge Cases:** A doc folder that happens to contain a `.env` or source file is excluded by the `.md`/`.txt` allowlist. Large docs are acceptable (bounded, no code).

### NotebookLM removal — seven surfaces
See the itemised list under **Removing the NotebookLM export → Seven surfaces** above. Delete symbol-by-symbol; a partial removal leaves dangling verb-allowlist entries that compile but point at deleted handlers.

### `switchboard-site` docs
- Add a `create-plans.md` page describing the new tab, the source picker (zip / public link / platform-via-MCP), and the docs-not-code / behaviour-first principle.
- Repoint the prev/next chain: this page replaces `notebooklm.md` in the Artifacts sequence. Reconcile with the merge plan's `research.md`/`notebooklm.md` edits against the pages actually present at build time.
- Release notes: call out the NotebookLM removal explicitly and point users to Create Plans as the replacement for "get context to an agent for planning."

## Verification Plan

> Per session directive: **no compilation, no automated tests** in this verification plan. Verify by walking the flows manually in the running extension.

### Flow-based verification (manual)
1. **Source picker — zip:** open Create Plans, pick Zip → Download docs zip → confirm it contains the managed docs + `HOW-TO-PLAN.md` and **no code** → paste a sample plan back → card appears unassigned.
2. **Source picker — public link:** pick Public link, set a docs URL → Copy planning prompt → confirm the clipboard references the URL and instructs behaviour-only planning.
3. **Source picker — platform:** pick Platform, choose Notion/ClickUp/Linear and provide a reference → Copy planning prompt → confirm the clipboard tells the agent to read the docs via that platform's MCP at the reference, and still instructs behaviour-only planning.
4. **One prompt, no modes:** confirm there is a single prompt with only the source line varying — no dev-docs toggle, no change/vision variants, no folder-role UI anywhere.
5. **Paste back with project active:** select a project → paste a plan → card is pinned to that project. **Confirm the `projectName` threading is wired** (the existing `importPlanFromClipboard` does not pass it today).
6. **Optional improve helper:** invoke "Improve my docs with an agent" → confirm it copies a doc-improvement prompt for a selected Docs-tab folder → confirm it is optional and reads no code; the tab still functions without ever using it.
7. **NotebookLM gone:** the export action is absent from the UI; the docs site no longer references it; no broken links. **Grep `protocol-catalog.json` and `src/generated/verbAllowlist.ts`** for any remaining NotebookLM verb entries — a dangling entry compiles fine but points at a deleted handler.
8. **No dead ends:** with no docs, no URL, no reference, no projects, the tab points the user to write a first doc (PRD/constitution) — not an empty zip.

## Relationship to other plans

- **`merge-dev-docs-into-docs-tab.md` — soft coupling, not a hard dependency; ship in either order.** This plan reads the consolidated Docs tab's doc set and reuses its Draft-with-agent handoff for the optional improve button, and takes the `planning.html` tab slot NotebookLM vacates. The earlier "merge must ship first so the folder-role accessor exists" dependency is **gone** — the folder role and its accessor were cut from both plans. The two plans delete different things (merge → auto-bundle + Dev Docs tab; this → NotebookLM export), so there is no conflict; whoever lands second reconciles the tab strip and the site prev/next chain.
- **`redistribute-project-html-tabs.md` — interaction dissolved** (see Dependencies).
- **`project-html-dev-docs-tab-and-ia.md` — moot** (see Dependencies).
- **`cross-platform-agent-collaboration.md` — supersedes its near-term rationale, not its full scope.** This delivers the simple, shippable "an agent helps produce a plan" version with none of the collaboration plan's coordination machinery (turn-tokens, bidirectional content-pull, attribution). It does NOT provide concurrent multi-agent co-authoring of a *live* plan — that is the collaboration plan's target, which should be shelved unless genuinely wanted.

## Recommendation

Complexity 4 → **Send to Coder** once the five review points are confirmed. The work is a thin new UI tab (a source picker + prompt/zip + paste-back), one docs-scoped packaging step, and the removal of the NotebookLM export across seven named surfaces. The behavioural boundary — docs not code, behaviour not implementation, one prompt with no modes — is the thing to hold firm on; it is also what keeps the feature small, which is the point, because this is fundamentally a discovery fix.
