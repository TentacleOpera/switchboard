# Build the Create Plans tab

## Metadata
- **Complexity:** 5
- **Tags:** frontend, backend, ux, feature, docs

_(No project named and no PROJECT PIN directive — lands unassigned, reassign on the board.)_

## What this does

Add a **Create Plans** tab to `planning.html` (in the slot the NotebookLM tab vacates) that surfaces an already-possible-but-undiscovered workflow: point an agent at your docs, get back a high-level plan (user flows + logic, not code), paste it onto the board. This is a **discovery/guidance fix** — no new power, just make it obvious. Docs are docs: no intent/dev distinction, no toggle, no code-reading. The agent can be an external web chat or a local agent.

Removing the NotebookLM export is a *separate* subtask (`remove-notebooklm-export.md`), which frees this tab's slot. This subtask assumes that slot is (or will be) free; land NotebookLM-removal first if both are in flight.

> Split from the original create-plans plan; the NotebookLM removal moved to its own subtask. Content preserved.

## The source picker (the one real mechanism)

The tab's only real choice is **where the docs are**; Switchboard hands the agent the right pointer + instructions. Three sources:
1. **Generated zip** — Switchboard bundles the managed doc set (constitution + PRDs + README + curated Docs-tab folders) into a markdown zip carrying `HOW-TO-PLAN.md`. Fallback when docs aren't hosted. **Docs-only by design** — never `git ls-files`, never source code.
2. **Public link** — the user pastes a URL (GitHub Pages, a public repo branch, anything fetchable); Switchboard remembers it and the prompt points the agent there.
3. **Platform reference** — docs live in Notion / ClickUp / Linear; the prompt tells the agent to read them via that platform's **MCP** given a reference the user provides. Switchboard stores the reference; it does not fetch.

## The generated prompt (product copy)

One prompt, adapted only by a single source-specific line (where/how to read). Shipped as `HOW-TO-PLAN.md` in the zip and as the copyable prompt for link/platform.

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
**Source-specific line prepended:** zip → none (`HOW-TO-PLAN.md` ships in the zip); public link → `The docs are published at <URL>. Read them there.`; platform → `The docs live in <Notion|ClickUp|Linear> at <reference>. Use the <platform> MCP to read them.`

## Steps

### 1 — Tab UI (`src/webview/planning.html` + `planning.js`)
- Add `<button class="shared-tab-btn" data-tab="create-plans">CREATE PLANS</button>` in the tab strip (the NOTEBOOKLM slot) and a `<div id="create-plans-content" class="shared-tab-content">` pane. Reuse the existing `shared-tab-btn` / `shared-tab-content` CSS + tab-switch JS.
- Pane contents: (1) source picker (segmented control / radios: Zip · Public link · Platform); (2) a public-URL field (shown for Public link) and a platform + reference field (shown for Platform); (3) **Copy planning prompt** (link/platform) and **Download docs zip** (zip) buttons; (4) a paste-back textarea + "Create plan card" button; (5) an optional "Improve my docs with an agent" button.
- Posts: `createPlansCopyPrompt` / `createPlansDownloadZip` / `createPlansPasteBack` / `createPlansImproveSource`, sending the chosen source + reference with the copy/zip messages.
- Gating: with no usable source (no docs and no reference) the package actions are `disabled` and the tab points the user to write a first doc (PRD/constitution) — never an empty zip. With no public URL, the link Copy button is greyed with a hint.

### 2 — Handlers (`src/services/PlanningPanelProvider.ts`)
- `createPlansCopyPrompt`: assemble the shared-core prompt, prepend the source-specific line for the chosen source, write to clipboard (reuse the `clipboard.writeText` + `showTemporaryNotification` pattern at 2786–2787).
- `createPlansDownloadZip`: call `bundleDocsContext` (step 3), write `HOW-TO-PLAN.md` into the zip, return the zip path.
- `createPlansPasteBack`: read the pasted markdown, resolve `kanban.activeProjectFilter` (best-effort via `_kanbanProvider?.getProjectFilter()`), then create the card pinned to that project (or unassigned). **Wiring that does not exist today:** the existing `importPlanFromClipboard` → `_createInitiatedPlan` call passes NO `projectName` (TaskViewerProvider.ts:18891); the mechanism exists (`_createInitiatedPlan` honours `options.projectName` → `db.assignPlansToProject`, 19244–19255). Prefer extending `importPlanFromClipboard` to accept an optional `projectName` so there's one paste-to-board path; thread `kanban.activeProjectFilter` through.
- `createPlansImproveSource` (optional): reuse the Docs tab's Draft-with-agent handoff (`draftImproveLocalDoc` post-merge, `draftImproveDevDoc` pre-merge) with wording tailored to "lay these docs out as a clear behavioural source for planning." Targets a user-selected Docs-tab folder. Optional, not gated, reads no code.
- Remembered public URL + platform reference = per-workspace config keys (same store pattern as `notebook.root`).

### 3 — Docs-scoped bundler (`src/services/ContextBundler.ts`)
- Add `bundleDocsContext(workspaceRoot, { activeProject? }): Promise<{ zipPath: string }>`. Source set = constitution + PRDs (all, or the active project's) + README + curated Docs-tab folders, filtered to `.md` + `.txt`. **Never** invoke `git ls-files`. Emit a markdown zip + `HOW-TO-PLAN.md`. Reuse the chunking/manifest shape of `bundleWorkspaceContext` but constrain the source set at the entry point.
- Add an invariant comment at the top: `// DOCS-ONLY BY DESIGN. Do not add a code-inclusion option — see plan create-plans-tab-docs-only-agent-intake.md.`

### 4 — Verbs + docs
- **`protocol-catalog.json`** — add `createPlansCopyPrompt`, `createPlansDownloadZip`, `createPlansPasteBack`, `createPlansImproveSource` to `PLANNING_VERBS`; run `npm run catalog:generate`.
- **switchboard-site** — add `create-plans.md` describing the tab, the source picker (zip / public link / platform-via-MCP), and the docs-not-code / behaviour-first principle. Reconcile the Artifacts prev/next chain: this page takes NotebookLM's place in the sequence (coordinate with `remove-notebooklm-export.md`, which deletes `notebooklm.md`). Release notes: point users here as the replacement for "get context to an agent for planning."

## Watch out
- **Paste-back pinning is unwired today** — `importPlanFromClipboard` passes no `projectName` (TaskViewerProvider.ts:18891). Thread it, or paste-back always lands unassigned. On project-filter read failure → unassigned (never invent a project).
- **Docs-only bundler invariant** — the zip must refuse source files by design (the `.md`/`.txt` allowlist + the entry-point comment). A doc folder containing a `.env`/source file is excluded by the allowlist.
- **Tab slot** — this adds the CREATE PLANS tab; `remove-notebooklm-export.md` removes the NOTEBOOKLM tab. Both edit the `planning.html` tab strip — land NotebookLM-removal first, or reconcile the strip when the second lands.
- Existing paste guards still apply: no H1/H2/H3 → "Imported Plan"; >200 KB rejected.

## Verify (manual, in the running extension)
- Zip source → Download docs zip contains the managed docs + `HOW-TO-PLAN.md` and **no code**; paste a sample plan back → card appears unassigned.
- Public link → Copy prompt references the URL and instructs behaviour-only planning. Platform → Copy prompt tells the agent to read via that platform's MCP at the reference.
- One prompt only — no dev-docs toggle, no change/vision variants, no folder-role UI.
- Paste-back with a project active → card pinned to it (confirm the `projectName` threading landed).
- Optional "Improve my docs" copies a doc-improvement prompt for a selected folder; the tab works without ever using it; reads no code.
- No dead ends: with no docs/URL/reference/projects the tab points to writing a first doc, not an empty zip.
