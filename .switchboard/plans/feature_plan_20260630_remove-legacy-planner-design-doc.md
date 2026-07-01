# Remove the Legacy Planner Design-Doc Option

**Plan ID:** 39168a8b-55c5-4b2f-880a-3ed9ddbc1c71

## Metadata
**Complexity:** 6
**Tags:** refactor, backend, cli

## Goal

Completely remove the legacy "planner design doc" feature — the `planner.designDocEnabled` / `planner.designDocLink` settings and everything that reads, writes, resolves, or injects them — now that the per-project PRD (`.switchboard/projects/<slug>/prd.md`) is the supported way to feed product requirements into agent prompts.

**Out of scope / explicitly kept:** the *design-system* doc (`planner.designSystemDoc*`) and the Design panel's document list (`designDocs`, `designDocsReady`, `_designDocsDebounce` — note the **plural**). The discriminator for what to remove is the exact tokens **`designDocLink`, `designDocEnabled`, `designDocContent`**, the config keys **`planner.designDocEnabled` / `planner.designDocLink`**, the option/addon field **`designDoc`** (singular boolean in `agentConfig`/addons), and the Notion design-doc-specific config field **`designDocUrl`** + its `fetchAndCache` command. Do **not** touch `designSystemDoc*`, `designDocs*`, or the `NotionFetchService` **class** itself (shared infrastructure — see Edge-Case audit).

### Problem / background / root-cause analysis

`planner.designDoc*` is a project-wide pointer to a single requirements/design document. It is injected into prompts under two labels (`agentPromptBuilder.ts`):
- Planner prompt: **"PLANNING EPIC REFERENCE"** (`:562-565`, plus the pre-fetched-Notion variant `:605-608`).
- Acceptance-review prompt: **"LEGACY DESIGN DOC (fallback baseline)"** (`:765-769`) — bottom of the precedence stack, below PRD (primary) and Constitution.
- Addons fallback path: **"PLANNING EPIC REFERENCE"** (`:1196-1199`).

It has been superseded by the per-project PRD (`prdUtils.ts`, `KanbanProvider._resolveProjectPrd`). Evidence it is legacy/redundant:
- The acceptance-review block already ranks it last, explicitly "fallback baseline."
- `KanbanProvider.ts:3251` checks `if (!designDocLink && !resolvedOptions.prdEnabled)` — the two are parallel inputs and the PRD is the modern one.
- The only mechanism that *auto-populated* `designDocLink` — `PlannerPromptWriter._writeDocToDocsDir` (`:105-116`) — is **dead code**: every live caller passes `skipDesignDocLink: true` (`PlanningPanelProvider.ts:7725, 7727, 8075, 8140, 8206, 8330`), and the option's own JSDoc says it backed a "removed Copy Link feature." `writeFromCache` has no caller at all.

So today the setting is populated **only** by the live "Set as Active Epic" UI path (`PlanningPanelProvider.setKanbanPlanContext` → writes `planner.designDocLink`/`designDocEnabled`) and manual setup-panel toggles. Removing it is a behavior change *only* for users who have explicitly set a `designDocLink`; for everyone else it is dead-weight cleanup.

### Relationship to the persistence-consistency plan

`feature_plan_20260630_settings-persistence-consistency.md` originally re-scoped `planner.designDoc*` (Global vs Workspace). That work is now **superseded by removal** — the consistency plan has been trimmed to drop `designDoc*` and keeps only `designSystemDoc*` under the "whether vs what" principle. Sequence: **do this removal first**, then the consistency plan, so the latter doesn't migrate keys that are about to be deleted.

## User Review Required

**Scope decision — "Set as Active Epic" button removal.** The Projects panel's "Set as Active Epic" button (`btnSetActiveEpic` in `project.js`) posts `setKanbanPlanContext`, which sets `planner.designDocLink` so the selected epic's plan flows into planner prompts. Once `planner.designDoc*` is removed, this button has no backing setting and must be removed (along with `btnDisableEpic` → `disableDesignDoc`). **Confirm:** is epic→planning-context still a feature anyone uses, or is it fully superseded by per-project PRDs (Projects tab + PROJECT CONTEXT toggle)? If users still rely on it, this plan must be re-scoped to rewire the button to the PRD path instead of deleting it. Default assumption per the plan's thesis: **remove it** (PRD is the successor).

## Complexity Audit

### Routine
- Delete `planner.designDocEnabled` / `planner.designDocLink` definitions from `package.json`.
- Remove the prompt-builder injection blocks ("PLANNING EPIC REFERENCE", "LEGACY DESIGN DOC") and addon interface fields.
- Remove `_resolveGlobalDesignDoc` and its call sites in `KanbanProvider.ts`.
- Remove the dead `PlannerPromptWriter._writeDocToDocsDir` auto-registration block and `skipDesignDocLink` option from all signatures.
- Remove `designDoc`/`designDocLink` addon fields and mapping lines in `agentConfig.ts`.
- Remove config getters/setters and message-handler cases in `TaskViewerProvider.ts` and `SetupPanelProvider.ts`.
- Remove webview toggle UI + handlers in `setup.html`, `kanban.html`, `sharedDefaults.js`.
- Update test assertions/snapshots that referenced the removed blocks.

### Complex / Risky
- **Webview message-contract lockstep:** the `activeDesignDocUpdated` / `kanbanContextSet` / `designDocSetting` message types and their listeners in `project.js`/`setup.html` must be removed in lockstep with the backend handlers in `PlanningPanelProvider`/`SetupPanelProvider`/`TaskViewerProvider`. A listener pointing at a deleted handler = silent no-op + console errors.
- **`NotionFetchService` shared-service boundary:** the `designDocUrl` config field + the `fetchAndCache` command at `extension.ts:1484` are design-doc-specific and in scope, but `NotionFetchService` is shared by `NotionBackupService`, `NotionBrowseService`, `ResearchImportService`, `NotionRemoteProvider`, and `LocalApiServer`. Remove only the design-doc-specific config field + command; **keep the class**.
- **"Set as Active Epic" UX removal** — gated on User Review above.

## Edge-Case & Dependency Audit

**Race Conditions**
- `_sendActiveDesignDocState()` is `await`ed at 7 call sites (440, 620, 745, 3171, 6692, 6766, 7757). Removing the method requires removing all 7 call sites in the same pass; a dangling `await this._sendActiveDesignDocState()` on a deleted method is a compile error (caught early) — low risk, but enumerate all sites.

**Security**
- No new surface. The `designDocUrl` Notion fetch command uses `context.secrets` via `NotionFetchService`; removing the command removes a secret-reading path. No secret exposure introduced.

**Side Effects**
- Users with `planner.designDocLink` / `planner.designDocEnabled` in their `settings.json` will retain harmless orphan keys (VS Code does not error on unknown config keys). No data loss — the referenced doc file/Notion page is never touched.
- The "Set as Active Epic" button disappears from the Projects panel (UX change — see User Review).
- `kanbanContextSet` / `activeDesignDocUpdated` / `designDocSetting` messages stop being emitted; any external consumer of these message types breaks. (No external consumers found — all listeners are in-repo webviews.)

**Dependencies & Conflicts**
- **Sequence dependency:** must land *before* `feature_plan_20260630_settings-persistence-consistency.md`, which has been trimmed to drop `designDoc*`. If the consistency plan lands first, it will migrate keys that this plan then deletes — wasted work.
- `NotionFetchService` is a dependency of 5+ services — do not delete the class, only the `designDocUrl` field + fetch command.
- `PlannerPromptWriter.ts.bak3` (stale backup, 5 hits) — not compiled; ignore or delete separately. Do not treat as a source target.

## Dependencies
- None (standalone removal). Sequencing note: should precede `feature_plan_20260630_settings-persistence-consistency.md`.

## Adversarial Synthesis

Key risks: (1) the live `activeDesignDoc`/`planningEpic`/`setKanbanPlanContext` webview-sync subsystem was absent from the original enumeration — removing the setting without removing its only live populator leaves a dead button; (2) `NotionFetchService` is shared infrastructure, so only the `designDocUrl` config field + fetch command are in-scope, not the class; (3) the "Set as Active Epic" button removal is a UX change requiring user sign-off. Mitigations: grep-driven removal in config→resolver→prompt→webview→test order with lockstep message-contract cleanup; gate the epic-button removal on User Review; preserve `NotionFetchService` class.

## Proposed Changes

`designDoc` (singular) appears ~152× across 25 files; after excluding the kept `designDocs*`/`designSystemDoc*` tokens, the real removal targets are below. Implementer should grep each file for `designDocLink|designDocEnabled|designDocContent|planner\.designDoc|addons?\.designDoc\b|\.designDoc\b|designDocUrl` and remove. **Line numbers below are verified against the current `src/` tree (2026-07-01) but may drift — re-grep before editing each file.**

### 1. Prompt builder — `src/services/agentPromptBuilder.ts` (~17 hits)
- Remove option/addon interface fields `designDocLink`, `designDocContent` (`:115-117`).
- Remove the planner injection blocks: "PLANNING EPIC REFERENCE" (`:562-565`) and its pre-fetched-Notion variant (`:605-608`).
- Remove the acceptance-review "LEGACY DESIGN DOC (fallback baseline)" block (`:765-769`), leaving PRD → Constitution as the precedence stack.
- Remove the addons fallback branches referencing `designDocLink`/`designDocContent` (`:1196-1199`).

### 2. Resolution + config I/O — `src/services/KanbanProvider.ts` (~21 hits)
- Remove `_resolveGlobalDesignDoc` (`:3027-3039`) and all assignments from it (`:3141-3142`, `:3224-3225`, `:3250-3254`).
- At `:3251`, simplify `if (!designDocLink && !resolvedOptions.prdEnabled)` to depend on the PRD only.
- Remove `designDocEnabled`/`designDocLink` from the prompts-config payload (`:3372-3373`) and the config-write handler (`:3686-3690`).
- Remove the active-design-doc helper at `:8228-8229` (reads both config keys).

### 3. Config getters/setters + content resolver — `src/services/TaskViewerProvider.ts` (~14 hits)
- Remove the `designDocEnabled`/`designDocLink` write blocks (`:7967-7977`) and the workspace-target write at `:9803`.
- Remove getters at `:15944` (`designDocEnabled`) and `:15948` (`designDocLink`).
- Remove `_getDesignDocContent` helper (`:15961-15979`) — the Notion-content resolver that feeds `designDocContent`.
- Remove `handleGetDesignDocSetting` (`:4157`) and its 3 call sites (`:4444`, `:4555`, `:10262`).
- Remove associated message-handler cases that route to these helpers.

### 4. Planning panel + active-design-doc subsystem — `src/services/PlanningPanelProvider.ts` (~20 hits)
- Remove state fields `_activeDesignDocSourceId` / `_activeDesignDocId` (`:132-133`).
- Remove `_getPlanningEpicName` (`:7070-7075`) and `_sendActiveDesignDocState` (`:7078-7087`), plus all 7 call sites (`:440`, `:620`, `:745`, `:3171`, `:6692`, `:6766`, `:7757`).
- Remove the `setKanbanPlanContext` message handler (`:3156-3177`) — writes `planner.designDocLink`/`designDocEnabled` + emits `kanbanContextSet`.
- Remove the `disableDesignDoc` message handler (`:2759`) and `_handleDisableDesignDoc` (`:6676-6694`) — clears both config keys + resets `_activeDesignDoc*`.
- Remove the `designDocEnabled`/`designDocLink` write blocks at `:3166-3169`, `:6679-6685`, `:6759-6762`.
- The six `writeContentToDocsDir/...` call sites currently pass `{ skipDesignDocLink: true }` — drop the now-removed option from those calls (`:7725, 7727, 8075, 8140, 8206, 8330`).
- Remove the `activeDesignDocUpdated` message emission (inside `_sendActiveDesignDocState` and `:6696-6697`).

### 5. `src/services/PlannerPromptWriter.ts` (~15 hits)
- Remove the dead auto-registration block (`:105-116`) and the `skipDesignDocLink` option from all signatures (`:52-59`, `:159`, `:198`, `:237`). Pure dead-code removal.
- Note: `:260` references `notionCfg?.designDocUrl` as a fallback doc title — part of the Notion design-doc pipeline; remove with the `designDocUrl` cleanup.

### 6. Agent config — `src/services/agentConfig.ts` (~5 hits)
- Remove the `designDoc` field (`:28`) and `designDocLink` field (`:29`) from the addon interface.
- Remove the addon-mapping lines (`:195-197`). Keep `designSystemDoc*` mappings.

### 7. Setup panel plumbing — `src/services/SetupPanelProvider.ts` (~4 hits)
- Remove the `handleGetDesignDocSetting` round-trip (`:722-726`) and the `designDocSetting` message emission.
- Remove any `designDoc*` save-payload handling.

### 8. Webview UI — remove controls + handlers (do not touch `designDocs*`)
- `src/webview/setup.html` (~8 hits): remove `lastDesignDocLink` var (`:1525`), the `designDocLink` payload field (`:2386`), the `designDocSetting` message handler (`:4639`), the `design-doc-toggle` / `design-doc-status-line` UI block (`:4641-4647`), and the toggle's change handler / save-payload wiring.
- `src/webview/kanban.html` (2 hits): remove the `plannerAddonPlanningEpic` checkbox that maps to addon `designDoc` (`:3309`) and its addon-mapping entry (`:4069`).
- `src/webview/project.html` (1 hit): remove the `btnSetActiveEpic` / `btnDisableEpic` button markup and the legacy `planner.designDocLink` back-compat comment (`:1526`).
- `src/webview/project.js` (~3 hits): remove `btnSetActiveEpic` click handler → `setKanbanPlanContext` (`:2355-2368`), `btnDisableEpic` click handler → `disableDesignDoc` (`:2371-2374`), and any `kanbanContextSet` / `activeDesignDocUpdated` listeners.
- `src/webview/sharedDefaults.js` (2 hits): remove `designDoc: false` from the addons default (`:21`) and the addon definition `{ id: 'designDoc', label: 'Planning Epic Reference (legacy)' ... }` (`:61`).
- **`src/webview/design.js` — NOT IN SCOPE.** All 4 `designDoc` hits are `designDocs*` (plural, the Design panel's document list: `:43`, `:762`, `:2756`, `:3076`). Zero legacy hits. Do not touch.

### 9. Settings registration — `package.json` (3 hits)
- Remove the `switchboard.planner.designDocEnabled` (`:308`) and `switchboard.planner.designDocLink` (`:313-316`) definitions.

### 10. `src/extension.ts` + Notion design-doc fetch (1 hit)
- The hit at `:1484` is `config?.designDocUrl` — a `NotionFetchService` config field, **not** `planner.designDocLink`. The `fetchAndCache` command (`:1482-1492`) is design-doc-specific (warns "No Notion design doc URL configured"). Remove this command registration + its `designDocUrl` config read.
- **Clarification:** also remove the `designDocUrl` config field from `NotionFetchService.ts` (`:16`, `:610`) and the `designDocUrl` write in `TaskViewerProvider.ts:5615`. **Keep the `NotionFetchService` class** — it is shared by `NotionBackupService`, `NotionBrowseService`, `ResearchImportService`, `NotionRemoteProvider`, and `LocalApiServer`.

### 11. Tests (~4 files, ~14 hits)
- `src/test/agent-config-drag-drop-mode.test.js` (4 hits): remove `designDoc: true`/`designDocLink` assertions (`:7-15`).
- `src/test/prompts-tab-move-regression.test.js` (6 hits): remove assertions on `designDocLink` (`:249-250`), `planner.designDocEnabled` (`:371-372`), `planner.designDocLink` (`:376-377`).
- `src/test/planning-aggregate-cache.test.js` (2 hits): comments only (`:83-84`) — update prose, no assertion changes.
- `src/test/minimal-prompt.test.js` (2 hits): remove `designDocContent` fixture (`:85`) and the "PLANNING EPIC REFERENCE (pre-fetched from Notion)" assertion (`:88`).
- **`src/services/__tests__/KanbanProvider.test.ts` — NOT IN SCOPE.** Verified: zero `designDoc*` hits. The original plan listed it at "(2)" — incorrect. Do not touch.
- Update any snapshots that asserted the "PLANNING EPIC REFERENCE" / "LEGACY DESIGN DOC" prompt blocks.
- `PlanningPanelProvider.ts.bak3` (5 hits) — stale `.bak3` backup; not compiled. Ignore or delete separately.

## Migration — none needed

Per direction: this is not critical state. `planner.designDoc*` is an opt-in convenience pointer, not user data — the referenced doc file is never touched by removal, and anyone who had one set can re-attach it via the Projects panel's per-project PRD. So **no migration, notice, or one-time clear is required.** Just delete the settings from `package.json` and all code paths.

This is consistent with CLAUDE.md's migration rule: that rule protects state whose loss "destroys user data." Here nothing is destroyed — the doc remains on disk/Notion; only a redundant pointer disappears. Any value still sitting in a user's `settings.json` for the removed keys becomes a harmless, unread orphan (VS Code does not error on unknown config keys).

**Caveat:** if the User Review decision keeps "Set as Active Epic" (rewires to PRD instead of removing), then `planner.designDocLink` write paths are preserved under a new key and a one-time migration of existing `designDocLink` values may become relevant. Default path (removal) needs no migration.

## Verification Plan

### Automated Tests
- **SKIP** per session directive — test suite run separately by the user. The test-file edits in §11 are the test-side deliverable; the user will run `npm test` (or equivalent) to confirm green.

### Manual / Static Verification
- Grep the tree post-change for `designDocLink|designDocEnabled|designDocContent|planner\.designDoc|designDocUrl` → zero matches outside `.bak3`. Confirm `designSystemDoc*` and `designDocs*` are untouched.
- Planner prompt no longer contains "PLANNING EPIC REFERENCE"; acceptance-review prompt no longer contains "LEGACY DESIGN DOC"; PRD and Constitution blocks still present and correctly ordered.
- Setup/Kanban/Planning/Projects UIs no longer show the design-doc control or the "Set as Active Epic" / "Disable Epic" buttons; no console errors from removed message handlers (`activeDesignDocUpdated`, `kanbanContextSet`, `designDocSetting` have no remaining listeners or emitters).
- `NotionFetchService` still instantiates correctly for NotionBackup/Browse/Research/Remote paths (smoke-check the Notion integration tests).
- Build only for VSIX; otherwise test from `src/`.

## Files Touched
`package.json`, `src/extension.ts`, `src/services/agentPromptBuilder.ts`, `src/services/KanbanProvider.ts`, `src/services/TaskViewerProvider.ts`, `src/services/PlanningPanelProvider.ts`, `src/services/PlannerPromptWriter.ts`, `src/services/agentConfig.ts`, `src/services/SetupPanelProvider.ts`, `src/services/NotionFetchService.ts` (config field only), `src/webview/setup.html`, `src/webview/kanban.html`, `src/webview/project.html`, `src/webview/project.js`, `src/webview/sharedDefaults.js`, plus listed test files. (`src/webview/design.js` and `src/services/__tests__/KanbanProvider.test.ts` explicitly excluded — false positives. `PlanningPanelProvider.ts.bak3` ignored.)

## Recommendation
Complexity 6 → **Send to Coder.** Multi-file mechanical removal following existing patterns; no new architecture, no data-consistency risk. The one non-mechanical item (epic-button UX removal) is gated on User Review and can be sliced off if the user elects to rewire instead of delete.
