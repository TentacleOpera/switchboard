# Project Constitution

This document defines the non-negotiable invariants and the aspirational standards for
Switchboard. Rules marked **[INVARIANT]** are already in force and breaking them is a defect;
rules marked **[STANDARD]** are targets the project is growing into. When an invariant and a
convenience conflict, the invariant wins.

Related governance lives in `CLAUDE.md` (agent rules) and `AGENTS.md` (workflow protocol). This
constitution is the higher-level charter; where it and those files overlap, they must agree.

---

## Project Domain & Purpose

Switchboard is a **published VS Code extension** (`publisher: TurnZero`, ~4,000 installs) that lets
users drag-and-drop work to trigger AI agent teams — "no prompts, no API keys, one hand free." Its
core surfaces:

- A **Kanban board** that moves plans through workflow stages (Created → Coded → Reviewed → Done),
  backed by a `sql.js` database (`kanban.db`).
- **Planning, Design, Setup, Project, and Task Viewer** webview panels.
- **Integrations** with ClickUp, Linear, and Notion for two-way ticket/doc sync.
- An agent **workflow protocol** (`.agent/workflows`, `.switchboard/plans/`) that orchestrates
  planning, review, and chat consultation.

Two facts shape every decision and override most defaults:

1. **There are real users on old versions.** Any state, file, or setting that shipped in a released
   version is a compatibility surface forever.
2. **The extension ships as a single bundle.** The `.vsix` contains no `node_modules`.

---

## Architecture & Layering Invariants

- **[INVARIANT] The bundle is self-contained.** Webpack must bundle every runtime dependency into
  `dist/extension.js`. Never rely on runtime `require`/dynamic `import` of an unbundled package, and
  never assume `node_modules` exists at runtime — it does not in the published `.vsix`. The extension
  runs from `dist/extension.js` and serves webviews from `dist/webview/`.

- **[INVARIANT] Always rebuild after editing webviews.** Sources in `src/webview/*` are served from
  `dist/webview/` after `npm run compile`. Editing source without rebuilding ships stale UI.

- **[INVARIANT] The db `config` table is the home for state and config.** State/config flows through
  the database `config` table (via the state/config bridge). The multi-process `state.json` protocol
  is fiction — the extension is the only writer. Do not invent new file-based state channels.

- **[INVARIANT] Migrate anything that shipped.** For any state/file/setting that exists in a released
  version: import before deleting, archive legacy files as `*.migrated.bak` rather than unlinking,
  preserve unknown/legacy keys instead of dropping them, and never assume a prior migration "already
  ran." Features that have only ever existed in unreleased dev work may take clean breaks. **When
  unsure whether something shipped, assume it did and migrate** — a no-op migration is free; a missing
  one destroys user data.

- **[INVARIANT] Webview ↔ host boundary is message-passing only.** Webviews are sandboxed iframes.
  They communicate with the extension host exclusively via `postMessage`; they do not touch the file
  system, the database, or VS Code APIs directly. Browser modals (`confirm`, `alert`, `prompt`) are
  silent no-ops in this sandbox — see the no-confirm invariant below.

- **[INVARIANT] Kanban column transitions are host-owned.** Execution agents must never mutate kanban
  columns via SQL during normal workflow execution. Querying state read-only is fine; manual moves go
  through the sanctioned `kanban_operations` path only when the user explicitly requests one.

- **[INVARIANT] Tabs own independent workspace selection.** Each panel/tab keeps its own workspace
  dropdown. Never collapse multiple tabs onto one shared workspace root — users routinely run
  kanban on one repo and tickets on another simultaneously.

- **[STANDARD] Keep services single-responsibility.** Logic lives in `src/services/*` (one concern per
  service); `src/extension.ts` is wiring, not business logic. As `extension.ts` (~3,300 lines) grows,
  extract cohesive units into services rather than adding to it.

---

## Coding & Language Conventions

- **[INVARIANT] TypeScript is the source language.** New code is `.ts` compiled by webpack/`ts-loader`.
  Test files may be `.js` or `.ts` (see Testing). Match the idiom, naming, and comment density of the
  surrounding file.

- **[INVARIANT] Lint and build must be clean.** `npm run lint` (eslint over `src`) and `npm run
  compile` (webpack) must both pass before a change ships. This is the merge gate.

- **[STANDARD] No stray artifacts in `src/`.** Avoid committing `*.bak`, `*.orig`, `*.rej`, `*.tmp`,
  and `*.js.map` alongside sources. Several exist today (e.g. `LocalFolderService.ts.bak`,
  `extension.test.ts.rej`) — prefer removing them over adding more.

- **[STANDARD] Reference code by `path:line`** in discussion and link related plans/docs rather than
  duplicating their content.

---

## Security & Reliability Requirements

- **[INVARIANT] Secrets live in VS Code SecretStorage — nowhere else.** The Stitch key and all
  ClickUp / Linear / Notion tokens must be stored via `context.secrets` (SecretStorage). They must
  **never** be written to `state.json`, the db `config` table, plan files, workspace files, logs, or
  anything committed to git. When migrating older installs that stored a credential elsewhere, move it
  into SecretStorage and scrub the old location.

- **[INVARIANT] Sanitize all untrusted content rendered in webviews.** Any user/plan/integration text
  injected into a webview must pass through DOMPurify (as already done in `kanban.html`, `setup.html`,
  `sharedUtils.js`, `PlanningPanelProvider`, `agentConfig`). Never `innerHTML` raw external content.

- **[INVARIANT] NEVER add confirmation dialogs to delete/destructive buttons.** No `confirm()`,
  `window.confirm()`, modal `showWarningMessage`, two-click "are you sure?", or equivalent gate.
  Buttons are deliberately hard to misclick and deletes execute immediately. This is both a product
  rule (demanded repeatedly) and a technical one: `confirm()` is a **silent no-op** in the sandboxed
  webview iframe, so a confirm gate makes the button do *literally nothing*. Multi-choice decision
  dialogs (e.g. 3-way conflict resolution) are allowed; plain confirm gates are not. If you find one,
  it is a bug — remove it.

- **[STANDARD] Degrade gracefully on integration failure.** Network/API failures to ClickUp, Linear,
  or Notion must not corrupt local state or crash a panel. Surface the error, preserve local data, and
  allow retry.

- **[STANDARD] Plans are self-contained and decisive.** A plan must document its core problem,
  background, and root-cause analysis inside/just below `## Goal`. Do not leave hedged "User Review
  Required" items — decide and state the decision; reserve review items for genuine product calls
  (usually "None").

---

## Performance & Testing Standards

- **[INVARIANT] Merge gate = lint + compile.** A change ships only when `npm run lint` and
  `npm run compile` are green. Tests are advisory at the gate, not blocking — but see the standards
  below.

- **[STANDARD] Run the tests that cover what you touched.** The suite is regression-heavy (100+ files
  in `src/test/`, many named `*-regression.test.js`). When you change an area, run its regression and
  contract tests (e.g. `npm run test:regression:plan-sync`, `npm run test:contract:research-modal`,
  the `test:integration:*` scripts). Fixing a user-reported bug should add or extend a regression test
  that would have caught it.

- **[STANDARD] Don't let the full suite rot.** `npm run pretest` (compile-tests + compile + lint) and
  `npm test` (`vscode-test`) should stay runnable. New features ship with tests; bug fixes ship with
  regression coverage.

- **[STANDARD] Keep the UI responsive.** Webview rendering and host message handling must stay snappy
  on large boards. Debounce continuous sync and high-frequency events (the pattern already used in
  `ContinuousSyncService`); avoid blocking the extension host on synchronous I/O or large DB scans.

- **[STANDARD] Keep the bundle lean.** Every dependency added to `dependencies` lands in the shipped
  `dist/extension.js`. Prefer small, bundle-friendly libraries and avoid adding heavy deps for
  marginal gains.

---

*Amendments: edit this file in a PR. Invariants change only with explicit owner sign-off; standards
may be tightened as the project matures.*
