# Planning Docs Health

**Complexity:** 5

## Goal

Improve the quality of plans produced by external planning agents (Spark, Claude Cowork, etc.) by ensuring the docs they read include navigational orientation. Plan 1 creates four structural docs for the Switchboard repo itself — a component map, an IPC message index, search-scoping guidance, and section TOCs in large files. Plan 2 adds a Docs Health sub-tab to Connections that surfaces these doc categories to all users and provides a copy-paste maintenance prompt for scheduled agents to create and keep them updated.

## How the Subtasks Achieve This

- **Planning Navigational Docs**: Creates the four structural docs Spark identified as missing — `ARCHITECTURE.md` (component map with feature-to-file table), `docs/IPC_PROTOCOL.md` (message-type index by panel), a "For AI agents" search-scoping section in `README.md`, and section TOC comment blocks in the 9 largest source files. These directly close the docs-completeness gap that makes planning agents start every task with broad codebase searches.
- **Docs Health Sub-Tab in Connections**: Adds a fifth sub-tab to the Connections panel that lists four general doc categories (architecture map, data-flow/interface index, search scoping, navigation aids for large files) in plain language for non-technical users. Each category is described by its *intent* with examples of how it manifests in different project types (web service, CLI, library, extension) — not as a fixed Switchboard-specific checklist. A "Copy docs maintenance prompt" button generates a self-contained, tool-agnostic prompt that instructs an external agent to determine which forms are relevant for the project, build its own scanner logic, and create/update/skip each category as appropriate.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Planning Navigational Docs — Component Map, IPC Index, Search Scoping, File TOCs](../plans/feature_plan_20260818140000_planning-navigational-docs.md) — **CODE REVIEWED**
- [ ] [Docs Health Sub-Tab in Connections — Planning Doc Guidance & Maintenance Prompt](../plans/feature_plan_20260818140001_docs-health-connections-tab.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; subtasks can be executed in parallel. Plan 1 (docs creation) and Plan 2 (Docs Health tab) are independently shippable — the tab recommends doc categories generically and doesn't depend on the Switchboard repo's own docs existing. However, shipping Plan 1 first provides a concrete reference set that makes Plan 2's tab content feel less abstract during testing.

## Review Findings

Both subtasks reviewed in place against their plan files. Plan 2 shipped a red `npm run compile` (TS2783 in the `docsHealthCopyPrompt` arm) and a browser-host false success (headless clipboard seam is a no-op, returned body carried no `prompt`) — both fixed in `src/services/PlanningPanelProvider.ts`. Plan 1's `docs/IPC_PROTOCOL.md` and all nine section-map TOCs were authored on pre-commit line numbers and drifted up to +102 lines (vs their declared ±20); all 703 IPC references and all nine TOCs were recomputed and now verify clean, three badly-misplaced TOC entries were corrected, a fabricated `webviewReady` row was removed, and the new verb was indexed. All CI gates re-run green except `test:contract:browser-panel-verb-routing`, which is red on `copyTextToClipboard` from another team's Jobs-tab code that this commit swept into `connections.js` — reported, not fixed, as it needs `ConnectionsPanelProvider` constructor surgery outside this feature's stream.
