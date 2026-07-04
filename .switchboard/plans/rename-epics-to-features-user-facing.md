---
description: Rename user-facing "epic"/"epics" terminology to "feature"/"features" across Switchboard's UI, notifications, and docs, without touching internal identifiers or persisted contracts
---

# Plan: Rename "Epics" → "Features" (User-Facing Surfaces Only)

## Goal

Rename the parent-task concept currently called **"epic"/"epics"** to **"feature"/"features"** everywhere a *user* reads it — webview labels/buttons/modals, VS Code notifications, and documentation — while deliberately leaving internal code identifiers and persisted data contracts untouched.

### Problem / Background

"Epic" is felt to be outdated terminology for the parent-task grouping in Switchboard. The maintainer wants the product to speak "feature" to users. The concept is deeply embedded (~6,000 raw matches repo-wide), but a codebase survey shows the term lives in three cleanly-separable layers, and only the first is user-facing:

- **Display text (~70 strings)** — what users actually read. This is the rename target.
- **Internal identifiers (~600 occurrences)** — CSS classes, JS/TS variable & function names, and webview↔extension message-type constants. Invisible to users; renaming them is pure churn with real breakage risk.
- **Persisted state / contracts** — the `.switchboard/epics/` on-disk directory (which *is* the epic-identity invariant), SQLite columns `is_epic`/`epic_id`, remote-provider field names. These carry migration risk against ~4,000 installs.

### Root-cause insight that makes this tractable

The risky layers and the user-facing layer **barely overlap**. Almost everything a user reads is inert display text; almost everything carrying migration risk is internal and invisible. Therefore a terminology rename can be done as a **string-only change** with no schema migration, no file moves, and no message-protocol changes — provided we hold a firm boundary between "the word on screen" and "the identifier in code / on disk."

Confirmed by survey:
- **package.json is essentially clean** — zero `epic` command IDs, zero command titles, zero keybindings. Only one setting *description* mentions "Epic Ultracode," which is a *separate* feature (the ULTRACODE animation), not the parent-task concept — leave it.
- The `.switchboard/epics/` path is load-bearing: the watcher/importer treat "any file under `.switchboard/epics/`" as an epic. Renaming the directory is a migration project in its own right, out of scope here.

## Metadata
- **Tags:** ui, terminology, refactor, webview, docs
- **Complexity:** 5
- **Repo:** switchboard
- **Project:** switchboard

## User Review Required
No — boundary decisions resolved (full slash-command rename; Notion renamed as a clean break since it is unreleased; docs included).

## Scope

### ✅ IN SCOPE — user-facing display text (~70 strings)

**Webview visible text**
- `src/webview/kanban.html` (~30 display strings): `PROMOTE TO EPIC` button + tooltip (~2511), epic-workflow tooltips (~2533/2536), `SUGGEST EPICS` button (~2569), "Apply epic ultracode/goal" label (~2771–2772), Epic-Create modal `Create Epic`/`Epic Name`/`Epic name...` placeholder/`Create Epic` submit (~3151–3164) and dynamic variants (~7460–7488), card meta `EPIC: N SUBTASKS` (~5475), `Review epic` (~5483), `ADD N TO EPIC` (~6924), Worktrees section `EPICS` header + copy + `Epic:` label + `-- Choose an Epic --` + `Create Epic Worktree` + "Please select an epic first." (~9327–9538, 9643/9725/9727), routing help text (~9294–9295).
- `src/webview/project.html` (~15 display strings): `EPICS` tab (~1668), `+ New Epic` (~1770), `Loading epics...` (~1777), `Select an epic to preview` (~1784), New-Epic modal `Create New Epic`/`Epic Name *`/`Enter epic name`/`Add Subtask to Epic` (~2154–2180), PRD explainer prose (~621).
- `src/webview/project.js` (~7 display strings, of 327 total matches): `No epics found. Use "+ New Epic"...` (~2250), button/title text `Delete Epic`/`+ Subtask`/`Refine` (~2459–2461), `Select an epic to preview` (~2503/2614).
- `src/webview/implementation.html` (6 — verify which are visible), `src/webview/setup.html:616` (visible warning copy — see Ambiguity #2).

**VS Code notifications (~16 strings)**
- `src/services/KanbanProvider.ts`: ~8536, 8553, 8677, 8818, 8824, 8830, 8834, 8851, 8926, 9522, 9530, 9553, 9555 ("Epic already has worktree", "Target is not a valid epic.", "Cannot add an epic as a subtask.", "Failed to create epic.", "Epic merge failed:", etc.).
- `src/services/TaskViewerProvider.ts:3577` ("...requires a Planning Epic...").
- `src/services/PlanningPanelProvider.ts:6252, 6298` ("Missing workspace or epic file...", "Failed to copy refine-epic prompt").

**Documentation** *(in scope)*
- `README.md` (~14), `docs/switchboard_user_manual.md` (~43), `docs/how_to_use_switchboard.md` (~14), plus `AGENTS.md`/`CLAUDE.md` concept prose (~10). No runtime risk.

**Slash commands + skill files — FULL rename** *(in scope)*
- Rename skill folders and their invocation names: `.claude/skills/create-epic/` → `create-feature/`, `improve-epic/` → `improve-feature/`, and the `refine-epic` prompt path → `refine-feature`.
- Rename `.agents/skills/create_epic.md` → `create_feature.md`, `refine_epic.md` → `refine_feature.md`, `group-into-epics/` → `group-into-features/`, and the scripts `kanban_operations/create-epic.js` → `create-feature.js`, `assign-to-epic.js` → `assign-to-feature.js` (and every call site that invokes them).
- Rename `.agents/workflows/improve-epic.md` → `improve-feature.md`; update cross-references in `improve-plan.md`, `switchboard-chat.md`, `sw-remote.md`, `switchboard-index.md`.
- Update the invocation registry `src/services/ClaudeCodeMirrorService.ts:45–133` so the mirrored slash-command names become `create-feature`, `improve-feature`, `refine-feature`, `switchboard-feature`.
- Update the workflow registry tables and skill tables in `CLAUDE.md` / `AGENTS.md`.
- No `epic` alias retained — this is a clean rename, not an aliasing pass.

**Notion sync property names — FULL rename (clean break, unreleased)** *(in scope)*
- The Notion remote integration is **unreleased dev work**, so per repo migration rules it takes a clean break: no migration, no back-compat shim.
- Rename the Notion database property names `'Is Epic'` → `'Is Feature'` and self-relation `'Epic'` → `'Feature'` in `NotionBackupService.ts` (~243, 246, 311, 316, 429, 441–442, 565, 585–587) and `NotionRemoteProvider.ts:112`.
- Rename the `RemoteProvider.ts:29` interface field `isEpicCandidate` → `isFeatureCandidate` and its writers/readers (`LinearRemoteProvider.ts:77`, `NotionRemoteProvider.ts:112`, `RemoteControlService.ts:469, 530–531`) — since these are part of the same unreleased remote path, rename them together for cleanliness.

### ⚙️ OUT OF SCOPE — internal identifiers (~600 occurrences)
Not renamed. No user impact; renaming is churn + risk.
- CSS classes / element IDs: `.epic-card`, `.epic-plan-item`, `#epics-list-pane`, `#new-epic-modal`, etc. (project.html ~85, kanban.html clusters).
- JS/TS variables & functions: `isEpic`, `epicId`, `createEpic`, `epicUltracodeEnabled`, `updateEpicActionButton`, `getEpicPlans`, `cascadeEpicByPlanId`, etc.
- Webview↔extension message `type`/`command` constants: `suggestEpics`, `setEpicWorkflowMode`, `promoteToEpic`, `createWorktreeForEpic`, etc. (must change on both ends together — not worth it).

> **Guardrail:** because display strings and code identifiers frequently sit on the same or adjacent lines (e.g. a button whose label is "EPIC" but whose id is `btn-epic-action`), each edit must change *only the text node / string literal a user sees*, never the surrounding identifier, class, id, or message-type. A blind find-replace of "epic"→"feature" would break the app. This is a surgical, string-literal-only pass.

### 🚫 OUT OF SCOPE — persisted state / contracts (migration risk, ~4,000 installs)
Explicitly excluded per repo migration rules:
- **`.switchboard/epics/` directory** and `epic-*` filename convention — the epic-identity invariant across GlobalPlanWatcherService, KanbanDatabase, PlanManifestService, PlanningPanelProvider, ClickUp/Linear sync, WorkspaceExcludeService (~40 refs + physical files). Renaming = a dedicated file-move migration, separate plan.
- **SQLite columns `is_epic` / `epic_id`** and indexes `idx_plans_is_epic`/`idx_plans_epic_id` (KanbanDatabase, ~90 refs across migrations V29/V31/V36/V37/V41) — would need its own schema migration.
- **Plan-file marker `> **Epic Plan ID:**`** and `subtask-of:`/`epic` HTML-comment tags — parsing/generation contracts.

## Resolved Decisions

1. **Slash commands / skill files → FULL rename.** `/create-epic`, `/improve-epic`, `/refine-epic` and their skill folders, scripts, workflows, and the `ClaudeCodeMirrorService.ts` registry are all renamed to the `feature` forms. No `epic` aliases retained. (See "Slash commands" under In Scope.)
2. **Notion property names → FULL rename, clean break.** The Notion remote integration is unreleased dev work, so it takes a clean break with **no migration and no compat shim** (per repo rules: "Features that have only ever existed in unreleased dev work can take clean breaks"). Rename `'Is Epic'`/`'Epic'` → `'Is Feature'`/`'Feature'` and the `isEpicCandidate` remote-provider field. (See "Notion sync property names" under In Scope.)
3. **Documentation → included** in this pass.

## Implementation Steps

1. **kanban.html display text** — edit the ~30 visible strings; leave every `id=`, `class=`, `data-*`, and `postKanbanMessage({type:...})` untouched. Diff-review each hunk to confirm only text nodes/labels/placeholders/tooltips changed.
2. **project.html display text** — edit tab label, `+ New Feature`, modal headings/labels/placeholders (~15); leave `#epics-*` ids and `.epic-*` classes.
3. **project.js dynamic strings** — edit the ~7 user-visible strings; leave the ~320 identifiers/DOM lookups.
4. **implementation.html / setup.html** — edit only the confirmed-visible copy; in setup.html keep the literal `.switchboard/epics/` path token intact even while rewording surrounding text (Ambiguity #2).
5. **Notification strings** — edit the ~16 `show*Message` literals in KanbanProvider/TaskViewer/PlanningPanel. These are plain user-facing English; safe.
6. **Slash commands / skill files (full rename)** —
   a. `git mv` skill folders `.claude/skills/create-epic` → `create-feature`, `improve-epic` → `improve-feature`; rename `refine-epic` prompt path → `refine-feature`.
   b. `git mv` `.agents/skills/create_epic.md`, `refine_epic.md`, `group-into-epics/`, and `kanban_operations/create-epic.js` / `assign-to-epic.js` to their `feature` names.
   c. `git mv` `.agents/workflows/improve-epic.md` → `improve-feature.md`.
   d. Update **every call site / cross-reference**: `ClaudeCodeMirrorService.ts` registry (~45–133), workflow cross-refs in `improve-plan.md`/`switchboard-chat.md`/`sw-remote.md`/`switchboard-index.md`, and the registry/skill tables in `CLAUDE.md` and `AGENTS.md`. Grep for the old script/skill/workflow names to catch programmatic invocations.
7. **Notion + remote-provider rename (clean break)** — rename `'Is Epic'`/`'Epic'` property strings in `NotionBackupService.ts` and `NotionRemoteProvider.ts`; rename `isEpicCandidate` → `isFeatureCandidate` in `RemoteProvider.ts` and its writers/readers (`LinearRemoteProvider.ts`, `NotionRemoteProvider.ts`, `RemoteControlService.ts`). No migration/back-compat.
8. **Docs** — rewrite user-facing "epic" prose to "feature" in README + `docs/*` manuals + `AGENTS.md`/`CLAUDE.md` concept prose.
9. **Consistency sweep** — grep the changed webviews/services/skills for any user-visible "epic"/"Epic" string or stale skill/workflow reference missed; verify no *internal* identifier/class/id/message-type/DB-column/`.switchboard/epics/`-path token was altered.

## Edge-Case & Dependency Audit
- **Blind-replace hazard:** the #1 risk. Adjacent identifiers (`btn-epic-action`, `isEpic`, message `type:'createEpic'`) must survive. Enforce string-literal-only edits + per-hunk review.
- **Mixed display/contract tokens:** `setup.html:616` and the `> **Epic Plan ID:**` marker contain a word that is both shown and parsed — reword the sentence, preserve the token.
- **Race Conditions:** None — no async/state behavior changes.
- **Security:** None.
- **Migrations:** None. The `.switchboard/epics/` directory and SQLite `is_epic`/`epic_id` columns remain out of scope (still named `epic`), so no released-state migration is needed. The Notion rename is a *clean break* (unreleased feature) — explicitly no migration/back-compat, which is only valid because that integration never shipped. Do not let scope creep pull the directory or DB columns in without a companion migration plan.
- **Skill/script rename fallout:** the biggest new risk. Any programmatic caller of `create-epic.js`/`assign-to-epic.js` or reference to the old skill/workflow names must be updated in lockstep, or the slash commands / kanban actions silently break. The `ClaudeCodeMirrorService` registry, workflow cross-refs, and CLAUDE.md/AGENTS.md tables are all coupled to these names.
- **Tests:** tests referencing `.switchboard/epics/`, `is_epic`, `epic_id` are unaffected (unchanged). Tests referencing renamed skill/workflow file names, the Notion `'Is Epic'` property, or `isEpicCandidate` WILL need updating. Grep test dirs for these tokens.

## Verification
- `npm run compile` succeeds (source is truth; ignore `dist/`).
- Load VSIX; open kanban + project views: the parent-task concept reads "Feature(s)" everywhere on screen — tab, buttons, modals, worktrees section, card meta.
- Trigger the renamed notifications (create a feature, invalid worktree, merge) and confirm wording.
- Confirm existing epics still load, group, and sync correctly (directory/DB/message-types unchanged → behavior identical).
- Grep confirms no remaining user-visible "epic" in the edited surfaces, and no identifier/path/column was renamed.

## Complexity Audit

### Routine
- ~70 string-literal edits across a handful of files.
- Doc prose rewrite.
- No schema, no migration, no protocol changes.

### Complex / Risky
- Discipline of separating display text from adjacent identifiers in dense webview files.
- **Full slash-command / skill-file rename:** file moves + registry + cross-references + programmatic call sites must move together, or slash commands and kanban actions break. This is the main risk carrier.
- **Notion clean-break rename** is only safe because the integration is unreleased — validate that assumption holds before deleting the old property names.
