# Remove the Legacy Planner Design-Doc Option

## Metadata
**Complexity:** 6
**Tags:** refactor, backend, cli

## Goal

Completely remove the legacy "planner design doc" feature — the `planner.designDocEnabled` / `planner.designDocLink` settings and everything that reads, writes, resolves, or injects them — now that the per-project PRD (`.switchboard/projects/<slug>/prd.md`) is the supported way to feed product requirements into agent prompts.

**Out of scope / explicitly kept:** the *design-system* doc (`planner.designSystemDoc*`) and the Design panel's document list (`designDocs`, `designDocsReady`, `_designDocsDebounce` — note the **plural**). The discriminator for what to remove is the exact tokens **`designDocLink`, `designDocEnabled`, `designDocContent`**, the config keys **`planner.designDocEnabled` / `planner.designDocLink`**, and the option/addon field **`designDoc`** (singular boolean in `agentConfig`/addons). Do **not** touch `designSystemDoc*` or `designDocs*`.

### Problem / background / root-cause analysis

`planner.designDoc*` is a project-wide pointer to a single requirements/design document. It is injected into prompts under two labels (`agentPromptBuilder.ts`):
- Planner prompt: **"PLANNING EPIC REFERENCE"** (`:564`, plus the pre-fetched-Notion variant `:607`).
- Acceptance-review prompt: **"LEGACY DESIGN DOC (fallback baseline)"** (`:766`) — bottom of the precedence stack, below PRD (primary) and Constitution.

It has been superseded by the per-project PRD (`prdUtils.ts`, `KanbanProvider._resolveProjectPrd`). Evidence it is legacy/redundant:
- The acceptance-review block already ranks it last, explicitly "fallback baseline."
- `KanbanProvider.ts:3251` checks `if (!designDocLink && !resolvedOptions.prdEnabled)` — the two are parallel inputs and the PRD is the modern one.
- The only mechanism that *auto-populated* `designDocLink` — `PlannerPromptWriter._writeDocToDocsDir` (`:105-116`) — is **dead code**: every live caller passes `skipDesignDocLink: true` (`PlanningPanelProvider.ts:7599, 7601, 7949, 8014, 8080, 8204`), and the option's own JSDoc says it backed a "removed Copy Link feature." `writeFromCache` has no caller at all.

So today the setting is populated **only** by manual UI toggles. Removing it is a behavior change *only* for users who have explicitly set a `designDocLink`; for everyone else it is dead-weight cleanup.

### Relationship to the persistence-consistency plan

`feature_plan_20260630_settings-persistence-consistency.md` originally re-scoped `planner.designDoc*` (Global vs Workspace). That work is now **superseded by removal** — the consistency plan has been trimmed to drop `designDoc*` and keeps only `designSystemDoc*` under the "whether vs what" principle. Sequence: **do this removal first**, then the consistency plan, so the latter doesn't migrate keys that are about to be deleted.

## Scope (by file)

`designDoc` (singular) appears ~152× across 25 files; after excluding the kept `designDocs*`/`designSystemDoc*` tokens, the real removal targets are below. Implementer should grep each file for `designDocLink|designDocEnabled|designDocContent|planner\.designDoc|addons?\.designDoc\b|\.designDoc\b` and remove.

### 1. Prompt builder — `src/services/agentPromptBuilder.ts` (~17 hits)
- Remove option/addon interface fields `designDocLink`, `designDocContent` (`:115-116`, `:198` area).
- Remove the planner injection blocks: "PLANNING EPIC REFERENCE" (`:562-565`) and its pre-fetched-Notion variant (`:605-608`).
- Remove the acceptance-review "LEGACY DESIGN DOC (fallback baseline)" block (`:765-769`), leaving PRD → Constitution as the precedence stack.
- Remove the addons fallback branches referencing `designDocLink` (`:767-768` legacy baseline, `:1198-1199`).

### 2. Resolution + config I/O — `src/services/KanbanProvider.ts` (~27 hits)
- Remove `_resolveGlobalDesignDoc` (`:3027-3039`) and all assignments from it (`:3141-3142`, `:3224-3225`, `:3250-3254`).
- At `:3251`, simplify `if (!designDocLink && !resolvedOptions.prdEnabled)` to depend on the PRD only.
- Remove `designDocEnabled`/`designDocLink` from the prompts-config payload (`:3372-3373`) and the config writes (`:3686-3690`).
- Remove the active-design-doc helper (`:8237-8238`).

### 3. Config getters/setters — `src/services/TaskViewerProvider.ts` (~25 hits)
- Remove the `designDocEnabled`/`designDocLink` write blocks (`:7974-7987`, `:9768-9769`) and getters (`:15910-15914`, `:15929-15932`).
- Remove associated message-handler cases.

### 4. Planning panel — `src/services/PlanningPanelProvider.ts` (~11 hits)
- Remove `designDocEnabled`/`designDocLink` writes (`:3065-3068`, `:6564`, `:6644-6647`) and message handlers.
- The six `writeContentToDocsDir/...` call sites currently pass `{ skipDesignDocLink: true }` — drop the now-removed option from those calls (`:7599, 7601, 7949, 8014, 8080, 8204`).

### 5. `src/services/PlannerPromptWriter.ts` (~5 hits)
- Remove the dead auto-registration block (`:105-116`) and the `skipDesignDocLink` option from all signatures (`:54-59`, `:159`, `:198`, `:237`). Pure dead-code removal.

### 6. Agent config — `src/services/agentConfig.ts` (~9 hits)
- Remove the `designDocLink` field (`:29`) and the addon-mapping lines that set `a.designDocLink`/`a.designDoc` (`:196-197`). Keep `designSystemDoc*` mappings (`:203-204`).

### 7. Setup panel plumbing — `src/services/SetupPanelProvider.ts` (~4 hits)
- Remove `getDesignDoc*` message round-trips and any `designDoc*` save-payload handling.

### 8. Webview UI — remove controls + handlers (do not touch `designDocs*`)
- `src/webview/setup.html` (2), `src/webview/kanban.html` (2), `src/webview/project.html` (1), `src/webview/project.js` (1), `src/webview/design.js` (4 — verify these aren't `designDocs*`), `src/webview/sharedDefaults.js` (2): remove the design-doc toggle/link inputs, their change handlers, and message cases. Audit each hit to confirm it's the singular legacy setting, not the Design panel's `designDocs` list.

### 9. Settings registration — `package.json`
- Remove the `switchboard.planner.designDocEnabled` and `switchboard.planner.designDocLink` definitions.

### 10. `src/extension.ts` (1 hit)
- Remove the single `designDoc*` reference (verify context).

### 11. Tests (~5 files, ~23 hits)
- `src/test/agent-config-drag-drop-mode.test.js` (8), `src/test/prompts-tab-move-regression.test.js` (10), `src/test/planning-aggregate-cache.test.js` (2), `src/test/minimal-prompt.test.js` (1), `src/services/__tests__/KanbanProvider.test.ts` (2), plus Notion fetch tests/fixtures referencing it. Remove `designDoc*` assertions/fixtures; keep `designSystemDoc*`. Update snapshots that asserted the "PLANNING EPIC REFERENCE"/"LEGACY DESIGN DOC" blocks.
- `PlanningPanelProvider.ts.bak3` (5) — a stale `.bak3` backup; ignore (not compiled) or delete separately.

## Migration — none needed

Per direction: this is not critical state. `planner.designDoc*` is an opt-in convenience pointer, not user data — the referenced doc file is never touched by removal, and anyone who had one set can re-attach it via the Projects panel's per-project PRD. So **no migration, notice, or one-time clear is required.** Just delete the settings from `package.json` and all code paths.

This is consistent with CLAUDE.md's migration rule: that rule protects state whose loss "destroys user data." Here nothing is destroyed — the doc remains on disk/Notion; only a redundant pointer disappears. Any value still sitting in a user's `settings.json` for the removed keys becomes a harmless, unread orphan (VS Code does not error on unknown config keys).

## Verification
- Build only for VSIX; otherwise test from `src/`.
- Grep the tree post-change for `designDocLink|designDocEnabled|designDocContent|planner\.designDoc` → zero matches outside `.bak3`. Confirm `designSystemDoc*` and `designDocs*` are untouched.
- Planner prompt no longer contains "PLANNING EPIC REFERENCE"; acceptance-review prompt no longer contains "LEGACY DESIGN DOC"; PRD and Constitution blocks still present and correctly ordered.
- Setup/Kanban/Planning UIs no longer show the design-doc control; no console errors from removed message handlers.
- Run the updated test suites green.

## Files Touched
`package.json`, `src/extension.ts`, `src/services/agentPromptBuilder.ts`, `src/services/KanbanProvider.ts`, `src/services/TaskViewerProvider.ts`, `src/services/PlanningPanelProvider.ts`, `src/services/PlannerPromptWriter.ts`, `src/services/agentConfig.ts`, `src/services/SetupPanelProvider.ts`, `src/webview/setup.html`, `src/webview/kanban.html`, `src/webview/project.html`, `src/webview/project.js`, `src/webview/design.js`, `src/webview/sharedDefaults.js`, plus listed test files. (`PlanningPanelProvider.ts.bak3` ignored.)
