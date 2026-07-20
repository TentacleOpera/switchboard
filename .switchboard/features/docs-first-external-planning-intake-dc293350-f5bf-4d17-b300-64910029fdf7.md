# Docs-first external planning intake

**Complexity:** 5

## Goal

Make an already-possible workflow discoverable: point an agent at your docs, have it write a **high-level plan (user flows and logic, not code)**, and paste that plan onto the board — where Switchboard's own code planner turns it into an implementation. This is a discovery and guidance fix, not new power; the capability exists today but goes unused (the repo's own author forgot it existed for months). Docs are docs — there is deliberately **no** intent-vs-dev-docs distinction, no folder roles, and no requirement that the agent see code; how detailed the plan is tracks how good the user's docs are, which is the user's responsibility. Two independent pieces deliver it: consolidate all markdown docs into the single Docs tab (deleting the redundant Dev Docs tab and the overengineered project-context auto-bundle), and add a Create Plans tab in the planning webview (taking the deleted NotebookLM slot) that points an agent at the docs via a source picker, hands over a behaviour-only planning prompt, and accepts the pasted-back plan.

## How the Subtasks Achieve This

- **Merge Dev Docs tab into Docs tab and delete the project-context auto-bundle feature**: Consolidates to one docs model. Folds the Dev Docs tab's affordances (+ New Doc, Draft with agent → renamed `draftImproveLocalDoc`) into the Docs tab's Manage Folders model and deletes the project-context auto-bundle-push (Feature A only — the PRD-injection toggle, Feature B, is preserved). Docs stay undifferentiated: **no per-folder role, no `DEV` badge, no accessor** (this reverses the earlier folder-role amendment). The source-filter dropdown stays sources-only.
- **Create Plans — point an agent at your docs and get a plan back**: Adds the Create Plans tab to `planning.html` (in the slot vacated by the deleted NotebookLM export). Its one real mechanism is a **source picker** — a generated docs zip, a public link (GitHub Pages / public repo branch / any URL), or a platform reference (Notion / ClickUp / Linear, read via that platform's MCP) — so the agent can be pointed at wherever the docs already live. It hands over a single behaviour-only planning prompt (adapted only by where to read the docs) and accepts the pasted-back plan as a board card (pinned to the active project when one is set). No dev-docs toggle, no mode variants, no code-reading step. Also removes the NotebookLM whole-repo export across its seven surfaces.

## Dependencies & sequencing

**No strict order — the two plans are independent and can ship in either order.** The earlier "merge first so the Create Plans dev-docs toggle can consume a folder-role accessor" dependency is gone: the folder role, its accessor, and the dev-docs toggle were all cut. The remaining coupling is soft — Create Plans reads the consolidated Docs tab's doc set, reuses its Draft-with-agent handoff for an optional "improve my docs" button, and takes the `planning.html` tab slot NotebookLM vacates. The two plans delete different things (merge → auto-bundle + Dev Docs tab; Create Plans → NotebookLM export), so there is no conflict; whichever lands second reconciles the `planning.html` tab strip and the switchboard-site prev/next chain.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Merge the Dev Docs tab into the Docs tab](../plans/merge-dev-docs-into-docs-tab.md) — **CODE REVIEWED**
- [ ] [Build the Create Plans tab](../plans/create-plans-tab-docs-only-agent-intake.md) — **CODE REVIEWED**
- [ ] [Delete the project-context auto-bundle feature](../plans/delete-project-context-auto-bundle.md) — **CODE REVIEWED**
- [ ] [Remove the NotebookLM export](../plans/remove-notebooklm-export.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Review Findings

Feature-level review found the dispatch's "implementation complete" claim wrong: the working tree at review start did not compile (three independent breaks from the half-done auto-bundle deletion) and the flagship Create Plans tab was entirely absent, with only the NotebookLM removal and the frontend half of the Dev Docs merge landed; a concurrent session was also still writing to `PlanningPanelProvider.ts` mid-review and was waited out, then its duplicate `draftImproveLocalDoc` handler reconciled into one. All four subtasks were completed in-place during review — Dev Docs backend deleted, Feature A fully removed (Feature B PRD-injection preserved), Create Plans built end-to-end (tab, handlers, jszip docs bundler, projectName paste-back threading) — and the catalog/allowlist regenerated. Verification: every subtask plan's grep passes, catalog drift check clean, `node --check` on planning.js passes; compile and tests were skipped per dispatch flags, so `npm run build` plus a manual pass over the Docs tab buttons, Remote tab, and the zip→prompt→paste-back loop is the outstanding validation. Files changed: `PlanningPanelProvider.ts`, `SetupPanelProvider.ts`, `TaskViewerProvider.ts`, `extension.ts`, `ContextBundler.ts`, four `remote/*` files, `setup.html`, `planning.html`, `planning.js`, `package.json`(+lock), regenerated `protocol-catalog.json`/`verbAllowlist.ts`.
