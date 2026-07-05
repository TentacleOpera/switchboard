---
description: Rename user-facing "epic"/"epics" terminology to "feature"/"features" across Switchboard's UI, notifications, and docs, without touching internal identifiers or persisted contracts
---

# Plan: Rename "Epics" → "Features" (User-Facing Surfaces Only)

## Goal

Rename the parent-task concept currently called **"epic"/"epics"** to **"feature"/"features"** everywhere a *user* reads it — webview labels/buttons/modals, VS Code notifications, and documentation — while deliberately leaving internal code identifiers and persisted data contracts untouched.

### Problem / Background

"Epic" is felt to be outdated terminology for the parent-task grouping in Switchboard. The maintainer wants the product to speak "feature" to users. The concept is deeply embedded (~6,000 raw matches repo-wide), but a codebase survey shows the term lives in three cleanly-separable layers, and only the first is user-facing:

> **Maintainer correction (2026-07-04):** the **entire epic feature is unreleased experimental work** — it has never shipped to the ~4,000 installs. This means the persisted-state layer (`.switchboard/epics/` directory, `is_epic`/`epic_id` columns, Notion `Is Epic`/`Epic` schema) carries **no migration risk**: it is all clean-break eligible. The display-text-only boundary below is therefore a **churn/risk-avoidance choice, not a migration necessity**. A future fuller rename (directory + DB columns + identifiers) is now possible without a migration plan; this pass deliberately stays display-text-only to keep the diff small and the breakage surface bounded.

- **Display text (~70 strings)** — what users actually read. This is the rename target.
- **Internal identifiers (~600 occurrences)** — CSS classes, JS/TS variable & function names, and webview↔extension message-type constants. Invisible to users; renaming them is pure churn with real breakage risk.
- **Persisted state / contracts** — the `.switchboard/epics/` on-disk directory (which *is* the epic-identity invariant), SQLite columns `is_epic`/`epic_id`, remote-provider field names. **Unreleased experimental work (maintainer-confirmed 2026-07-04) — no migration risk.** A directory + DB-column rename is clean-break eligible but out of scope for this display-text pass (churn + ~90 refs across watcher/importer/sync).

### Root-cause insight that makes this tractable

The risky layers and the user-facing layer **barely overlap**. Almost everything a user reads is inert display text; almost everything carrying breakage risk is internal and invisible. Therefore a terminology rename can be done as a **string-only change** with no schema migration, no file moves, and no message-protocol changes — provided we hold a firm boundary between "the word on screen" and "the identifier in code / on disk." (The entire epic feature is unreleased, so even the persisted-state layer carries no migration risk — but it is still excluded from this pass to keep the diff bounded. A future full rename is clean-break eligible.)

Confirmed by survey:
- **package.json is essentially clean** — zero `epic` command IDs, zero command titles, zero keybindings. Only one setting *description* mentions "Epic Ultracode," which is a *separate* feature (the ULTRACODE animation), not the parent-task concept — leave it.
- The `.switchboard/epics/` path is load-bearing: the watcher/importer treat "any file under `.switchboard/epics/`" as an epic. Renaming the directory is a migration project in its own right, out of scope here.

## Metadata
- **Plan ID:** DFDD679A-78ED-40B6-A041-C4FCA5ADFC4C
- **Tags:** ui, ux, refactor, docs
- **Complexity:** 5
- **Project:** switchboard

## User Review Required
No — maintainer confirmed (2026-07-04) the entire epic feature is unreleased experimental work, never shipped to the ~4,000 installs. Boundary decisions resolved: full slash-command rename; Notion `Is Epic`/`Epic` renamed as a clean break (no migration); `isEpicCandidate` TS field left as an internal identifier (churn avoidance, not migration); docs included. The display-text-only boundary is a churn/risk choice — a future full rename of the directory + DB columns + identifiers is clean-break eligible but out of scope for this pass.

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

**Notion `Is Epic` / `Epic` property names — FULL rename (clean break)** *(in scope)*
- The two Notion database property strings `'Is Epic'` → `'Is Feature'` and the self-relation `'Epic'` → `'Feature'` are renamed. The entire epic feature is unreleased experimental work (maintainer-confirmed 2026-07-04), so per repo migration rules a clean break applies: no migration, no back-compat shim.
- **Scope fence:** this pass renames ONLY the two `Is Epic`/`Epic` property strings. Other `NotionBackupService.ts` property names are left untouched — not because they're released contracts (the epic feature isn't), but because they're unrelated to the "epic"→"feature" terminology rename and broadening the edit risks introducing bugs for no terminological benefit.
- Edit sites (string literals only — these are Notion DB property names, not TS identifiers): `NotionBackupService.ts` (~243, 246, 311, 316, 347, 429, 441–442, 444–445, 565–566, 585, 587–588) and `NotionRemoteProvider.ts` (~102, 105, 112). Comments at the same lines may be reworded for consistency but are non-breaking.

### ⚙️ OUT OF SCOPE — internal identifiers (~600 occurrences)
Not renamed. No user impact; renaming is churn + risk.
- CSS classes / element IDs: `.epic-card`, `.epic-plan-item`, `#epics-list-pane`, `#new-epic-modal`, etc. (project.html ~85, kanban.html clusters).
- JS/TS variables & functions: `isEpic`, `epicId`, `createEpic`, `epicUltracodeEnabled`, `updateEpicActionButton`, `getEpicPlans`, `cascadeEpicByPlanId`, etc.
- **`isEpicCandidate` TS interface field** (`RemoteProvider.ts:29`) and its writers/readers (`LinearRemoteProvider.ts:77`, `NotionRemoteProvider.ts:112`, `RemoteControlService.ts:469, 530–531`). Pure internal identifier on `RemoteStateDelta`, zero user-facing surface. Out of scope on churn-avoidance grounds (not migration — the epic feature is unreleased). A future full rename pass can take it cleanly.
- **LocalApiServer RPC endpoint keys** `createEpic` / `assignToEpic` (`TaskViewerProvider.ts:1011, 1023`) and the **`KanbanProvider` method names** they route to (`createEpicFromPlanIds`, `assignPlansToEpic`). These are internal identifiers. The renamed `.js` scripts (`create-feature.js`, `assign-to-feature.js`) POST to these endpoint keys by name — so the endpoint keys MUST stay `epic` even though the script FILE names change. Renaming the keys would break the scripts.
- Webview↔extension message `type`/`command` constants: `suggestEpics`, `setEpicWorkflowMode`, `promoteToEpic`, `createWorktreeForEpic`, etc. (must change on both ends together — not worth it).

> **Guardrail:** because display strings and code identifiers frequently sit on the same or adjacent lines (e.g. a button whose label is "EPIC" but whose id is `btn-epic-action`), each edit must change *only the text node / string literal a user sees*, never the surrounding identifier, class, id, or message-type. A blind find-replace of "epic"→"feature" would break the app. This is a surgical, string-literal-only pass.

### 🚫 OUT OF SCOPE — persisted state / contracts (unreleased, but churn-heavy)
Excluded from THIS pass on churn/risk-avoidance grounds (NOT migration — the entire epic feature is unreleased experimental, maintainer-confirmed 2026-07-04). All of the below is clean-break eligible for a future fuller rename pass:
- **`.switchboard/epics/` directory** and `epic-*` filename convention — the epic-identity invariant across GlobalPlanWatcherService, KanbanDatabase, PlanManifestService, PlanningPanelProvider, ClickUp/Linear sync, WorkspaceExcludeService (~40 refs + physical files). Renaming = a dedicated file-move pass, separate plan (now possible without migration).
- **SQLite columns `is_epic` / `epic_id`** and indexes `idx_plans_is_epic`/`idx_plans_epic_id` (KanbanDatabase, ~90 refs across migrations V29/V31/V36/V37/V41) — would need its own schema-rename pass (now possible without migration).
- **Plan-file marker `> **Epic Plan ID:**`** and `subtask-of:`/`epic` HTML-comment tags — parsing/generation contracts.

## Resolved Decisions

1. **Slash commands / skill files → FULL rename.** `/create-epic`, `/improve-epic`, `/refine-epic` and their skill folders, scripts, workflows, and the `ClaudeCodeMirrorService.ts` registry are all renamed to the `feature` forms. No `epic` aliases retained. (See "Slash commands" under In Scope.)
2. **Notion `Is Epic`/`Epic` property strings → FULL rename, clean break.** The entire epic feature (including the Notion `Is Epic`/`Epic` property schema) is unreleased experimental work — confirmed by the maintainer (2026-07-04). Per repo rules: "Features that have only ever existed in unreleased dev work can take clean breaks." Rename ONLY the two property strings `'Is Epic'`/`'Epic'` → `'Is Feature'`/`'Feature'`. No migration, no back-compat shim. The `isEpicCandidate` TS field is NOT renamed (internal identifier — churn avoidance). Other `NotionBackupService.ts` property names are untouched (out of scope for this pass).
3. **Documentation → included** in this pass.

## Implementation Steps

1. **kanban.html display text** — edit the ~30 visible strings; leave every `id=`, `class=`, `data-*`, and `postKanbanMessage({type:...})` untouched. Diff-review each hunk to confirm only text nodes/labels/placeholders/tooltips changed.
2. **project.html display text** — edit tab label, `+ New Feature`, modal headings/labels/placeholders (~15); leave `#epics-*` ids and `.epic-*` classes.
3. **project.js dynamic strings** — edit the ~7 user-visible strings; leave the ~320 identifiers/DOM lookups.
4. **implementation.html / setup.html** — edit only the confirmed-visible copy; in setup.html keep the literal `.switchboard/epics/` path token intact even while rewording surrounding text (Ambiguity #2).
5. **Notification strings** — edit the ~16 `show*Message` literals in KanbanProvider/TaskViewer/PlanningPanel. These are plain user-facing English; safe.
6. **Slash commands / skill files (full rename)** —
   a. `git mv` skill folders `.claude/skills/create-epic` → `create-feature` and `improve-epic` → `improve-feature`. NOTE: there is **no `.claude/skills/refine-epic/` folder** — `refine-epic` is sourced from the `.agents/skills/refine_epic.md` *file* (handled in 6b), not a `.claude/skills/` folder.
   b. `git mv` `.agents/skills/create_epic.md` → `create_feature.md`, `refine_epic.md` → `refine_feature.md`, `group-into-epics/` → `group-into-features/`, and `kanban_operations/create-epic.js` → `create-feature.js`, `assign-to-epic.js` → `assign-to-feature.js`.
   c. `git mv` `.agents/workflows/improve-epic.md` → `improve-feature.md`.
   d. Update **every call site / cross-reference** (enumerated — do not rely on grep alone):
      - **`ClaudeCodeMirrorService.ts` registry** — update BOTH rows that point at `workflows/improve-epic.md`: row `:54` (`name: 'improve-epic'` → `'improve-feature'`) AND row `:133` (`name: 'switchboard-epic'` → `'switchboard-feature'`). Also row `:66` (`create-epic`→`create-feature`, source `skills/create_epic.md`→`create_feature.md`), row `:88` (`refine-epic`→`refine-feature`, source `skills/refine_epic.md`→`refine_feature.md`), row `:92` (`group-into-epics`→`group-into-features`). The two `improve-epic.md`-sourced rows (`:54` and `:133`) are coupled — renaming the file once requires updating both registry rows.
      - **Hard runtime `readFileSync` call sites (will ENOENT if missed):**
        - `PlanningPanelProvider.ts:6231` (`.agents/skills/refine_epic.md` → `refine_feature.md`) AND `:6234` (the `.agent` **singular** fallback path `'.agent','skills','refine_epic.md'` → `refine_feature.md`). The Refine button dies if either is missed.
        - `KanbanProvider.ts:10326` (`.agents/skills/group-into-epics/SKILL.md` → `group-into-features/SKILL.md`) AND `:10333` (the `.agent` **singular** fallback). The Suggest-Epics board button dies if either is missed.
      - **Agent-prompt script-path strings (agent runs a non-existent script if missed):**
        - `agentPromptBuilder.ts:519, 520` — literal prompt text `node .agents/skills/kanban_operations/assign-to-epic.js ...` → `assign-to-feature.js`. Update both the path and the second `assign-to-epic.js` reference on `:520`.
        - `KanbanProvider.ts:10341, 10350` — prompt text `calling create-epic.js` / `node .agents/skills/kanban_operations/create-epic.js ...` → `create-feature.js`.
      - **LocalApiServer HTTP route strings (agent-facing — scripts POST to these):**
        - `LocalApiServer.ts:1108` — `pathname === '/kanban/epic'` → `'/kanban/feature'` (the create-feature.js script posts here).
        - `LocalApiServer.ts:1110` — `pathname === '/kanban/epic/assign'` → `'/kanban/feature/assign'` (the assign-to-feature.js script posts here).
        - The JS files that POST to these routes (`create-epic.js`→`create-feature.js`, `assign-to-epic.js`→`assign-to-feature.js`) must update their fetch URL strings to match — these live inside the `.js` scripts being renamed in 6b.
        - The TS option-callback keys (`createEpic`/`assignToEpic`) and handler method names (`_handleKanbanCreateEpic`/`_handleKanbanAssignEpic`) STAY `epic` (internal). Only the route STRING literals change.
      - **Workflow cross-refs:** `improve-plan.md:15,17`, `switchboard-index.md:34,36,37,50`, `switchboard-split.md:9`, `sw-remote.md:215-216`.
      - **Registry/skill tables in `CLAUDE.md`** (~lines 53-54, 134, 136) **and `AGENTS.md`** — update the workflow-registry + skill-table rows for `improve-epic`/`create-epic`/`refine-epic`/`group-into-epics`/`switchboard-epic`.
      - **Non-breaking comment updates** (optional, for grep-cleanliness): `LocalApiServer.ts:35,46,321,370`, `TaskViewerProvider.ts:1012,1024`, `agentPromptBuilder.ts:268,501,504`. These reference the old script names in comments only — updating them keeps grep searches clean but is not required for correctness.
      - **Do NOT rename** the LocalApiServer endpoint keys `createEpic`/`assignToEpic` or the `KanbanProvider` methods `createEpicFromPlanIds`/`assignPlansToEpic` (internal identifiers, OUT OF SCOPE). The renamed `.js` scripts call these endpoint keys by name, so the keys must stay `epic`.
7. **Notion property-string rename (clean break)** — rename ONLY the two Notion DB property strings `'Is Epic'` → `'Is Feature'` and `'Epic'` → `'Feature'` in `NotionBackupService.ts` (~243, 246, 311, 316, 347, 429, 441–442, 444–445, 565–566, 585, 587–588) and `NotionRemoteProvider.ts` (~102, 105, 112). These are Notion property names (string literals), not TS identifiers. Do NOT rename the `isEpicCandidate` TS field, the LocalApiServer endpoint keys, or any other `NotionBackupService.ts` property that shipped in v1.5.9. No migration/back-compat (valid because the entire epic feature is unreleased experimental — maintainer-confirmed 2026-07-04).
8. **Docs** — rewrite user-facing "epic" prose to "feature" in README + `docs/*` manuals + `AGENTS.md`/`CLAUDE.md` concept prose.
9. **Consistency sweep** — grep the changed webviews/services/skills for any user-visible "epic"/"Epic" string or stale skill/workflow reference missed; verify no *internal* identifier/class/id/message-type/DB-column/`.switchboard/epics/`-path token was altered.

## Edge-Case & Dependency Audit
- **Blind-replace hazard:** the #1 risk. Adjacent identifiers (`btn-epic-action`, `isEpic`, message `type:'createEpic'`) must survive. Enforce string-literal-only edits + per-hunk review.
- **Mixed display/contract tokens:** `setup.html:616` and the `> **Epic Plan ID:**` marker contain a word that is both shown and parsed — reword the sentence, preserve the token.
- **Race Conditions:** None — no async/state behavior changes.
- **Security:** None.
- **Migrations:** None. The entire epic feature is unreleased experimental work (maintainer-confirmed 2026-07-04), so the `.switchboard/epics/` directory, SQLite `is_epic`/`epic_id` columns, and Notion `Is Epic`/`Epic` schema all carry zero migration risk. The Notion property rename is a clean break (no back-compat). The directory + DB columns are out of scope for THIS pass on churn grounds (now clean-break eligible for a future pass).
- **Skill/script rename fallout:** the biggest new risk — now fully enumerated in Implementation Step 6d. The hard runtime `readFileSync` sites (`PlanningPanelProvider.ts:6231/6234`, `KanbanProvider.ts:10326/10333`, including the `.agent` singular fallbacks) and the agent-prompt script-path strings (`agentPromptBuilder.ts:519-520`, `KanbanProvider.ts:10341/10350`) will silently break (ENOENT or agent runs a missing script) if missed. The `ClaudeCodeMirrorService` registry has a dual-row coupling on `improve-epic.md` (rows 54 + 133). Miss any one and a board button or slash command silently fails.
- **LocalApiServer endpoint-key trap:** the renamed `.js` scripts POST to endpoint keys named `createEpic`/`assignToEpic`. Those keys (and `KanbanProvider.createEpicFromPlanIds`/`assignPlansToEpic`) are internal identifiers and MUST stay `epic`. An implementer chasing "rename everything" could rename the endpoint key and break the scripts. Step 6d flags this explicitly.
- **Tests:** VERIFIED — `src/test/**` contains NO references to `refine_epic`/`create_epic`/`group-into-epics`/`create-epic.js`/`assign-to-epic.js`/`isEpicCandidate`/`Is Epic`/`improve-epic`. No test updates are required for the renamed tokens. (An earlier draft flagged this as a risk — corrected: no test references exist.) Tests referencing `.switchboard/epics/`, `is_epic`, `epic_id` are unaffected (those identifiers are unchanged).

## Complexity Audit

### Routine
- ~70 string-literal edits across a handful of webview/service files.
- Doc prose rewrite.
- No schema migration, no protocol changes, no test updates (verified: no test references the renamed tokens).
- Notion `Is Epic`/`Epic` → `Is Feature`/`Feature` is a 2-string clean break (unreleased schema).

### Complex / Risky
- **Discipline of separating display text from adjacent identifiers** in dense webview files (button label "EPIC" vs id `btn-epic-action` on the same line).
- **Full slash-command / skill-file rename — the main risk carrier.** File moves + the `ClaudeCodeMirrorService` registry (with the dual-row `improve-epic.md` coupling at rows 54+133) + TWO hard runtime `readFileSync` sites with `.agent` singular fallbacks (`PlanningPanelProvider.ts:6231/6234`, `KanbanProvider.ts:10326/10333`) + TWO agent-prompt script-path strings (`agentPromptBuilder.ts:519-520`, `KanbanProvider.ts:10341/10350`) must all move in lockstep. Miss one → silent ENOENT or agent runs a missing script.
- **LocalApiServer endpoint-key trap:** renamed `.js` scripts call endpoint keys `createEpic`/`assignToEpic` by name — those keys must stay `epic` (internal). Easy to wrongly rename.
- **Notion clean-break validity** — the `Is Epic`/`Epic` schema is unreleased (entire epic feature is unreleased experimental, maintainer-confirmed 2026-07-04). Clean break confirmed; no User Review needed.

## Dependencies
- `feature_plan_20260704232500_epic-operations-agent-clarity.md` (Feature Operations Agent Clarity — verb scripts + endpoints + cheatsheet) — **bidirectional coordination.** That plan creates new agent-facing verb scripts (`remove-from-feature.js`, `delete-feature.js`, `split-feature.js`), HTTP paths (`/kanban/feature/*`), and a "Feature Operations Cheatsheet" using `feature` terminology to match this rename. Both plans share the same boundary: agent-facing strings = `feature`, internal TS identifiers (option callback keys `removeFromEpic`/`deleteEpic`/`splitEpic`/`createEpic`/`assignToEpic`, KanbanProvider methods, DB columns, `.switchboard/epics/` path) = `epic`. **This rename plan MUST also rename the existing `/kanban/epic` and `/kanban/epic/assign` HTTP route strings to `/kanban/feature` and `/kanban/feature/assign`** (they are agent-facing — scripts POST to them). Add these two route-string edits to this plan's scope or confirm the agent-clarity plan takes them.
- `sess_20260702_remoteEpicStructure — Notion + Linear epic-aware state mirroring (unreleased epic feature)` — the Notion `Is Epic`/`Epic` schema being renamed here was introduced by this work. Both are unreleased; the clean-break rename is safe. Coordinate so this terminology rename lands before the epic feature ships (otherwise the `Is Epic`/`Epic` properties would need a migration instead of a clean break).
- `feature_plan_20260701_remote-control-production-sequencing.md` — references `isEpicCandidate` and the Notion schema; remains valid because `isEpicCandidate` is deliberately NOT renamed (out of scope on churn grounds) and the Notion property rename is a clean break on unreleased work.

## Adversarial Synthesis
Key risks: (1) the slash-command/skill rename had four unenumerated hard runtime break points (`PlanningPanelProvider.ts:6231/6234`, `KanbanProvider.ts:10326/10333` incl. `.agent` singular fallbacks) and two agent-prompt script-path strings (`agentPromptBuilder.ts:519-520`, `KanbanProvider.ts:10341/10350`) — all now enumerated in Step 6d; (2) the `isEpicCandidate` TS field was wrongly bundled into the Notion clean break — removed from scope (internal identifier, churn avoidance); (3) the original plan over-stated migration risk for persisted state — corrected per maintainer confirmation that the entire epic feature is unreleased experimental, so the display-text-only boundary is a churn/risk choice, not a migration necessity. Mitigations: explicit per-call-site enumeration, identifier-boundary fence around endpoint keys + `isEpicCandidate`, and a sequencing dependency against the unreleased remote-epic-structure work.

## Proposed Changes

### `src/webview/kanban.html` (~30 display strings)
- **Context:** Highest-density webview for the parent-task concept. Display strings and internal ids/classes/message-types sit on adjacent lines.
- **Logic:** String-literal-only edits to visible labels/buttons/tooltips/placeholders/modals/worktrees-section copy. Example targets: `PROMOTE TO EPIC`→`PROMOTE TO FEATURE`, `SUGGEST EPICS`→`SUGGEST FEATURES`, `Create Epic`→`Create Feature`, `EPIC: N SUBTASKS`→`FEATURE: N SUBTASKS`, `ADD N TO EPIC`→`ADD N TO FEATURE`, `EPICS` header→`FEATURES`, `-- Choose an Epic --`→`-- Choose a Feature --`, `Create Epic Worktree`→`Create Feature Worktree`, `Please select an epic first.`→`Please select a feature first.`.
- **Implementation:** Per-hunk diff review confirming only text nodes changed — no `id=`, `class=`, `data-*`, or `postKanbanMessage({type:...})` altered.
- **Edge Cases:** Button whose label is "EPIC" but whose id is `btn-epic-action` — change only the label.

### `src/webview/project.html` (~15 display strings)
- **Context:** Epics tab + New-Epic modal. Internal ids `#epics-*` and classes `.epic-*` abound.
- **Logic:** Tab label `EPICS`→`FEATURES`, `+ New Epic`→`+ New Feature`, `Loading epics...`→`Loading features...`, `Select an epic to preview`→`Select a feature to preview`, modal `Create New Epic`/`Epic Name *`/`Enter epic name`/`Add Subtask to Epic`→feature forms, PRD explainer prose.
- **Implementation:** Leave `#epics-list-pane`, `.epic-card`, etc. untouched.
- **Edge Cases:** Same adjacent-identifier hazard as kanban.html.

### `src/webview/project.js` (~7 dynamic strings of 327 total matches)
- **Context:** JS with ~320 identifier/DOM-lookup matches and ~7 user-visible strings.
- **Logic:** Edit only the ~7 visible strings (`No epics found...`, `Delete Epic`, `+ Subtask`, `Refine`, `Select an epic to preview`).
- **Implementation:** Leave `isEpic`, `epicId`, `getElementById('epics-...')`, etc.
- **Edge Cases:** High identifier density — strict literal-only edits.

### `src/webview/implementation.html` + `src/webview/setup.html`
- **Context:** ~6 strings in implementation.html (verify visibility) + `setup.html:616` warning copy.
- **Logic:** Edit confirmed-visible copy only. In `setup.html` keep the literal `.switchboard/epics/` path token intact even while rewording surrounding prose (mixed display/contract token).
- **Edge Cases:** The `.switchboard/epics/` token is both shown and parsed — preserve it.

### `src/services/KanbanProvider.ts`, `TaskViewerProvider.ts`, `PlanningPanelProvider.ts` (~16 notification strings + 2 hard file-path reads)
- **Context:** `show*Message` literals are user-facing English (safe). Two `readFileSync` sites in PlanningPanelProvider are HARD runtime dependencies on renamed skill file paths.
- **Logic:** Edit the ~16 notification literals (e.g. "Epic already has worktree"→"Feature already has worktree", "Target is not a valid epic."→"Target is not a valid feature.", "Cannot add an epic as a subtask."→..., "Failed to create epic."→..., "Epic merge failed:"→..., TaskViewer "...requires a Planning Epic..."→"...requires a Planning Feature...", PlanningPanel "Missing workspace or epic file..."→"...feature file...", "Failed to copy refine-epic prompt"→"Failed to copy refine-feature prompt"). Update `PlanningPanelProvider.ts:6231` (`.agents/skills/refine_epic.md`→`refine_feature.md`) and `:6234` (the `.agent` singular fallback → `refine_feature.md`).
- **Implementation:** The two `readFileSync` path updates are mandatory (Refine button ENOENT otherwise). The `createEpic`/`assignToEpic` endpoint keys and `createEpicFromPlanIds`/`assignPlansToEpic` methods at `TaskViewerProvider.ts:1011-1034` are OUT OF SCOPE — do not rename.
- **Edge Cases:** Endpoint-key trap (see Complexity Audit).

### `src/services/KanbanProvider.ts` (Suggest-Epics wiring, ~10318-10350)
- **Context:** `readFileSync` of `group-into-epics/SKILL.md` + agent-prompt text emitting `create-epic.js`.
- **Logic:** Update `:10326` (`.agents/skills/group-into-epics/SKILL.md`→`group-into-features/SKILL.md`) and `:10333` (`.agent` singular fallback). Update prompt text `:10341` (`calling create-epic.js`→`create-feature.js`) and `:10350` (`node .agents/skills/kanban_operations/create-epic.js`→`create-feature.js`).
- **Edge Cases:** Both `.agents` and `.agent` singular fallback paths must move together.

### `src/services/agentPromptBuilder.ts` (high-low planner prompt, ~519-520)
- **Context:** Emits literal agent instructions to run `assign-to-epic.js`.
- **Logic:** Update `:519` and `:520` — `node .agents/skills/kanban_operations/assign-to-epic.js`→`assign-to-feature.js` (both the path and the second reference on `:520`).
- **Edge Cases:** If missed, the agent runs a non-existent script and silently fails to link subtasks.

### `src/services/ClaudeCodeMirrorService.ts` (slash-command registry, ~42-133)
- **Context:** Mirrors slash commands for Claude Code. Two rows (`:54` and `:133`) share the source `workflows/improve-epic.md`.
- **Logic:** Row `:54` `improve-epic`→`improve-feature` (source→`improve-feature.md`); row `:133` `switchboard-epic`→`switchboard-feature` (source→`improve-feature.md`); row `:66` `create-epic`→`create-feature` (source `skills/create_epic.md`→`create_feature.md`); row `:88` `refine-epic`→`refine-feature` (source→`refine_feature.md`); row `:92` `group-into-epics`→`group-into-features`.
- **Edge Cases:** Dual-row coupling — renaming the file once requires updating both `:54` and `:133`.

### `.claude/skills/` + `.agents/skills/` + `.agents/workflows/` (file moves + cross-refs)
- **Context:** Skill folders, skill files, workflow file, and `kanban_operations/*.js` scripts.
- **Logic:** `git mv` as enumerated in Implementation Step 6a-c. Update cross-refs in `improve-plan.md:15,17`, `switchboard-index.md:34,36,37,50`, `switchboard-split.md:9`, `sw-remote.md:215-216`, and the `CLAUDE.md`/`AGENTS.md` registry+skill tables.
- **Edge Cases:** No `.claude/skills/refine-epic/` folder exists — `refine-epic` is the `.agents/skills/refine_epic.md` file (Step 6b).

### `src/services/NotionBackupService.ts` + `src/services/remote/NotionRemoteProvider.ts` (2-property clean break)
- **Context:** Notion DB property names `Is Epic`/`Epic` added in unreleased commit `6d40d30`.
- **Logic:** Rename ONLY `'Is Epic'`→`'Is Feature'` and `'Epic'`→`'Feature'` (string literals, ~13 sites in NotionBackupService, ~3 in NotionRemoteProvider). Do NOT touch other shipped Notion property names. Do NOT rename `isEpicCandidate` TS field.
- **Edge Cases:** Clean break valid — entire epic feature is unreleased experimental (maintainer-confirmed). Fence off other `NotionBackupService.ts` property names (unrelated to this rename).

### `README.md` + `docs/*` + `AGENTS.md`/`CLAUDE.md` concept prose
- **Context:** User-facing docs.
- **Logic:** Rewrite "epic" prose → "feature" in user-manual/how-to/README + concept prose in AGENTS/CLAUDE. No runtime risk.
- **Edge Cases:** Preserve `.switchboard/epics/` path tokens and `**Epic Plan ID:**` markers where they appear as parsed contracts.

## Verification Plan

### Automated Tests
- **None required.** Per session directive, automated tests are skipped. Verified: `src/test/**` contains no references to any renamed token (`refine_epic`, `create_epic`, `group-into-epics`, `create-epic.js`, `assign-to-epic.js`, `isEpicCandidate`, `Is Epic`, `improve-epic`), so no test files need updating. Compilation is also skipped per session directive (`src/` is the source of truth; `dist/` is not audited).

### Manual Verification
- Load VSIX; open kanban + project views: the parent-task concept reads "Feature(s)" everywhere on screen — tab, buttons, modals, worktrees section, card meta.
- Trigger the renamed notifications (create a feature, invalid worktree, merge) and confirm wording.
- Confirm existing epics still load, group, and sync correctly (directory/DB/message-types unchanged → behavior identical).
- **Slash-command / skill-file rename wiring (high-risk surface):**
  - Run `/create-feature`, `/improve-feature`, `/refine-feature`, `/switchboard-feature`, and the Suggest-Epics / Refine board buttons — confirm none 500 / none throw ENOENT. Exercises `ClaudeCodeMirrorService.ts` rows 54/66/88/92/133, `PlanningPanelProvider.ts:6231/6234`, `KanbanProvider.ts:10326/10333`.
  - Run the high-low planner flow that emits the `assign-to-feature.js` prompt (`agentPromptBuilder.ts:519-520`) and the Suggest-Epics `create-feature.js` prompt (`KanbanProvider.ts:10350`) — confirm the agent is instructed to run the NEW script names.
  - Confirm the renamed `.js` scripts (`create-feature.js`, `assign-to-feature.js`) still POST to the LocalApiServer endpoint keys `createEpic`/`assignToEpic` (which must remain `epic`).
- **Notion clean-break check:** if `switchboard.notionBackup` is configured, run one backup and confirm the Notion DB now has `Is Feature`/`Feature` properties (not `Is Epic`/`Epic`); confirm no OTHER property names were altered.
- Grep confirms no remaining user-visible "epic" in the edited surfaces, and no internal identifier / path / column / endpoint-key / `isEpicCandidate` field was altered.

---

**Recommendation:** Complexity 5 → **Send to Coder**.

## Review Findings
Reviewed against the committed Phase 1 diff (`308da5b`); no material defects in this phase. Display-text, slash-command/skill-file, Notion-property, and the two HTTP-route renames all landed cleanly, the `createEpic`/`assignToEpic` endpoint keys correctly stayed `epic`, and all renamed webview↔extension message types match on both ends. Verified zero orphaned `epic` runtime references in the edited surfaces. No code fixes applied here — the two defects found by the full-feature review live in Agent Clarity (`splitFeature` atomicity) and Phase 2 (V46 DB migration crash); see those plan files. Remaining risk: none specific to Phase 1.
