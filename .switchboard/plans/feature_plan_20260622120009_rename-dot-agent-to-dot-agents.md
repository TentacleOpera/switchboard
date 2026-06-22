# Rename `.agent` Directory to `.agents` (with Full Dependency Handling)

## Goal

Rename the bundled `.agent` directory to `.agents` everywhere — the in-repo source folder, the extension-bundled copy, all hardcoded path literals, and the scaffolding that writes `.agent` into user workspaces — while carefully handling every dependency and migrating existing workspaces so nothing breaks.

### Problem Analysis

`.agent` is a first-class asset directory: 55 files spanning `workflows/`, `personas/`, `rules/`, `skills/`, and `scripts/` (see `find .agent -type f`). It is:
- **Shipped with the extension** — `.vscodeignore` explicitly keeps it: `!.agent/**` ([.vscodeignore:25-26](.vscodeignore#L25)).
- **Scaffolded into user workspaces** — `extension.ts` copies it from the extension root to each workspace ([extension.ts:3242](src/extension.ts#L3242), [3255](src/extension.ts#L3255), [3263](src/extension.ts#L3263)) and references many specific files ([3148-3155](src/extension.ts#L3148), [3292-3299](src/extension.ts#L3292), [2867-2868](src/extension.ts#L2867)). The detection function `hasSwitchboardProtocolFiles` ([2866-2879](src/extension.ts#L2866)) checks `.agent/workflows` existence to decide if setup is needed.
- **Migrated/copied by ControlPlaneMigrationService** — `BUNDLED_AGENT_DIR = '.agent'` ([ControlPlaneMigrationService.ts:87](src/services/ControlPlaneMigrationService.ts#L87)) plus **five** `path.join(..., '.agent', ...)` sites at [611](src/services/ControlPlaneMigrationService.ts#L611), [666](src/services/ControlPlaneMigrationService.ts#L666), [684](src/services/ControlPlaneMigrationService.ts#L684), [818](src/services/ControlPlaneMigrationService.ts#L818), [836](src/services/ControlPlaneMigrationService.ts#L836). Also a warning message at [880](src/services/ControlPlaneMigrationService.ts#L880) and a comment at [975](src/services/ControlPlaneMigrationService.ts#L975).
- **Referenced by runtime paths** — personas/rules/skills/workflows in `agentPromptBuilder.ts` ([95](src/services/agentPromptBuilder.ts#L95) comment, [214](src/services/agentPromptBuilder.ts#L214) prompt string, [361](src/services/agentPromptBuilder.ts#L361) comment, [381](src/services/agentPromptBuilder.ts#L381), [1169](src/services/agentPromptBuilder.ts#L1169), [1312](src/services/agentPromptBuilder.ts#L1312) prompt string), `TaskViewerProvider.ts` ([14765](src/services/TaskViewerProvider.ts#L14765) prompt string, [16175](src/services/TaskViewerProvider.ts#L16175), [17353](src/services/TaskViewerProvider.ts#L17353)), `KanbanProvider.ts` ([2764](src/services/KanbanProvider.ts#L2764), [2797](src/services/KanbanProvider.ts#L2797)), `PlanningPanelProvider.ts` ([3143](src/services/PlanningPanelProvider.ts#L3143), [3156](src/services/PlanningPanelProvider.ts#L3156), [4484](src/services/PlanningPanelProvider.ts#L4484)).
- **Referenced by webviews & defaults** — `sharedDefaults.js` ([21](src/webview/sharedDefaults.js#L21)), `kanban.html` ([2653](src/webview/kanban.html#L2653), [2660](src/webview/kanban.html#L2660), [3107](src/webview/kanban.html#L3107), [3271](src/webview/kanban.html#L3271)), `implementation.html` ([1424](src/webview/implementation.html#L1424) display text), `setup.html` ([610](src/webview/setup.html#L610), [613](src/webview/setup.html#L613), [1253](src/webview/setup.html#L1253), [1861](src/webview/setup.html#L1861), [1939](src/webview/setup.html#L1939) display text).
- **Referenced by docs/config** — `AGENTS.md` ([6](AGENTS.md#L6), [29](AGENTS.md#L29), [35](AGENTS.md#L35), [95](AGENTS.md#L95)), `src/webview/switchboard/README.md` ([7](src/webview/switchboard/README.md#L7)).
- **Clarification (corrected):** The default `.agent/workflows/improve-plan.md` is a **hardcoded fallback** in `KanbanProvider.ts:2764,2797` via `config.get<string>('planner.workflowPath', '...')`. There is **no `switchboard.planner.workflowPath` setting declared in `package.json`** — the configuration section (line 178+) contains no such property. Users who changed the workflow path did so via the Switchboard webview UI (`workflowFilePath` input in `kanban.html:2653`), which stores the value in Switchboard's internal config, not in VS Code settings. A backward-compatible resolution fallback is still required for those internal config values.

A naïve find/replace will break Switchboard's internal config values that users have already set to point at `.agent/...` via the webview UI, so a backward-compatible resolution fallback is required.

### Why this matters (motivation)

**Antigravity only autoloads `.agents/` — a directory named `.agent/` is invisible to it.** That is the whole reason for this rename: today Switchboard scaffolds its workflows/personas/rules/skills into `.agent/`, which Antigravity never picks up, so all of that managed content is silently inert in the Antigravity environment. Renaming to `.agents/` makes it discoverable. (This resolves the earlier "external tool" question — it is Switchboard-owned *content*, but the *directory name* is exactly what Antigravity keys on.)

### Root Cause

`.agent` is a hardcoded literal in ~100 places plus a physical directory and a packaging rule, and the name does not match the directory Antigravity autoloads. The fix is a coordinated source/packaging rename — **not** a data migration of user files (see the non-destructive decision below).

## Metadata

**Complexity:** 7
**Tags:** refactor, infrastructure, ui

## User Review Required

Yes — this plan changes the extension's shipped directory structure, introduces a destructive (opt-in, guarded) cleanup button in the Setup tab, and affects all ~4,000 installed users on upgrade. The user must review and approve:
1. The non-destructive scaffolding decision (leave `.agent/` alone, scaffold `.agents/` fresh).
2. The opt-in cleanup button design and safety guards (§6a).
3. The backward-compatible fallback duration (at least one release).
4. The physical `git mv .agent .agents` rename of the in-repo directory.

## Complexity Audit

### Routine
- Renaming the physical `.agent/` → `.agents/` in the repo.
- Updating the `.vscodeignore` keep-rule.
- Path-scoped literal replacement of `.agent/` → `.agents/` and `'.agent'` → `'.agents'` in path-string contexts in source. **WARNING: replacement must be path-scoped only — see CSS class hazard below.**
- Updating display text in webviews (`implementation.html:1424`, `setup.html:610,613,1253,1861,1939`).
- Updating doc references (`AGENTS.md`, `src/webview/switchboard/README.md`).
- Updating test fixtures that hardcode `.agent/...` paths.

### Complex / Risky
- **CSS class collision hazard:** `implementation.html` contains CSS classes `.agent-description`, `.agent-list`, `.agent-row`, `.agent-name`, `.agent-input` (lines 417, 499, 510, 515, 520, 531, 593, 601-602, 730, 745-746). `kanban.html` has `.agent-description` (line 1128). These are **CSS selectors, not path references** — a bare global `s/\.agent/.agents/g` would corrupt them and silently break UI styling. The replacement must be path-scoped: only replace `.agent/` (with trailing slash) or `'.agent'` (in string-literal path contexts like `path.join(root, '.agent')`), never a bare `.agent` token that precedes a `-` or alphanumeric character.
- **No automatic deletion (decided):** Switchboard must NOT rename, move, or silently delete a user's existing `.agent/` directory on its own. Going forward it scaffolds its own content into `.agents/` and leaves any pre-existing `.agent/` untouched (it is inert, since Antigravity only autoloads `.agents/`). Removal is offered as an explicit, **user-clicked** opt-in button in the Setup tab (§6a) — guarded, confirmed, and never automatic.
- **Guarded opt-in delete:** the cleanup button performs a real recursive delete, so it needs the safety guards in §6a (sibling `.agents/` must exist, exact-path/symlink check, skip roots whose config references `.agent/`, per-root isolation) and a custom confirmation modal showing the exact paths.
- **Hardcoded fallback defaults:** `KanbanProvider.ts:2764,2797` hardcode `.agent/workflows/improve-plan.md` as the fallback for `config.get<string>('planner.workflowPath', ...)`. These must change to `.agents/...`. There is **no `package.json` setting to update** — the setting is undeclared in `package.json` (verified: zero `workflowPath` matches). Users who set a custom workflow path via the webview UI stored `.agent/...` in Switchboard's internal config; the §6b fallback handles those.
- **Detection logic (`hasSwitchboardProtocolFiles`):** `extension.ts:2866-2879` checks `.agent/workflows` existence to decide if setup is needed. After rename, this must check `.agents/workflows` first, with `.agent/` fallback — otherwise Switchboard will think every workspace needs setup on every activation.
- **Resolution fallback:** runtime path resolvers should try `.agents/` then fall back to `.agent/` so a workspace where the user kept (and possibly customized) the old folder still functions.

## Edge-Case & Dependency Audit

- **Race Conditions:** Fresh-scaffold of `.agents/` should complete (or be guarded) before code resolves `.agents/...` paths; run scaffolding early and `await` it. No user-file migration runs, so there is no rename-vs-read race against existing `.agent/` content.
- **Security:** Scaffolding writes only within the workspace; preserve the existing path-traversal guards. Switchboard never deletes user files automatically. The opt-in cleanup button is the only destructive path and is guarded by §6a safety checks.
- **Side Effects:** Git: only the in-repo `git mv .agent .agents` shows as a rename in the *Switchboard* repo; user workspaces are not modified (their `.agent/` is left alone, and a fresh `.agents/` is scaffolded). Note: `.cursorrules` does **not** reference `.agent/` (verified — no matches) and needs no update. Other AI-tool config files, if any mention `.agent/`, should be updated for consistency but are not functionally required by Switchboard.
- **Dependencies & Conflicts:** Touches `extension.ts` (scaffolding, detection, file lists, comments), `ControlPlaneMigrationService.ts` (constant, 5 path.join sites, warning message, comment), `agentPromptBuilder.ts` (2 prompt strings, 2 comments, 1 constant, 1 persona path), `TaskViewerProvider.ts` (1 prompt string, 2 path joins), `KanbanProvider.ts` (2 hardcoded fallbacks), `PlanningPanelProvider.ts` (2 prompt strings, 1 skill path), `SetupPanelProvider.ts` (new cleanup handlers), `src/webview/setup.html` (Setup-tab cleanup card + custom confirm modal), `src/webview/kanban.html` (4 path refs + CSS class hazard), `src/webview/implementation.html` (1 display ref + CSS class hazard), `src/webview/sharedDefaults.js`, `.vscodeignore`, and docs (`AGENTS.md`, `src/webview/switchboard/README.md`). Coordinate with any in-flight plan that references `.agent/skills/...` (e.g. the refine-ticket skill path). The cleanup confirm modal should reuse the custom-modal pattern from the tickets-delete-confirmation plan (no native VS Code dialog).

## Dependencies

None — this is a self-contained refactor. No `sess_` session dependencies.

## Adversarial Synthesis

Key risks: (1) CSS class corruption from a bare global replace — mitigated by path-scoped replacement only. (2) Missed prompt-string references in `agentPromptBuilder.ts:214,1312` and `TaskViewerProvider.ts:14765` that would send agents to a non-existent directory — mitigated by the complete reference list in §3. (3) The `hasSwitchboardProtocolFiles` detection function would cause perpetual re-setup if not updated — mitigated by explicit call-out in §3. (4) The plan's original §4 was based on a non-existent `package.json` setting — corrected: no package.json change needed, only hardcoded fallbacks in code. Mitigations: path-scoped replacement, complete reference enumeration, `.agents/`-first resolution fallback, and guarded opt-in cleanup.

## Proposed Changes

### 1. Physical rename
- `git mv .agent .agents` (preserves history for all 55 files). **Note:** the implementer should perform this; the planner does not execute git mutations.

### 2. Packaging — `.vscodeignore`
Replace the keep rule ([25-26](.vscodeignore#L25)):
```
# Keep .agents/ — workflow assets are shipped with the extension
!.agents/**
```

### 3. Constants & literals

**⚠️ CRITICAL: All replacements must be path-scoped.** Only replace `.agent/` (with trailing slash) or `'.agent'` (in string-literal path contexts). **Do NOT touch CSS class names** like `.agent-description`, `.agent-list`, `.agent-row`, `.agent-name`, `.agent-input` in `implementation.html` and `kanban.html` — these are CSS selectors, not path references.

**`ControlPlaneMigrationService.ts`:**
- Line 87: `const BUNDLED_AGENT_DIR = '.agents';`
- **Five** `path.join(..., '.agent', ...)` sites: [611](src/services/ControlPlaneMigrationService.ts#L611), [666](src/services/ControlPlaneMigrationService.ts#L666), [684](src/services/ControlPlaneMigrationService.ts#L684), [818](src/services/ControlPlaneMigrationService.ts#L818), [836](src/services/ControlPlaneMigrationService.ts#L836) → change `'.agent'` to `'.agents'`.
- Line [880](src/services/ControlPlaneMigrationService.ts#L880): warning message text mentioning `.agent/rules` → `.agents/rules`.
- Line [975](src/services/ControlPlaneMigrationService.ts#L975): comment mentioning `.agent/` → `.agents/`.

**`agentPromptBuilder.ts`:**
- Line [381](src/services/agentPromptBuilder.ts#L381): `DEFAULT_PLANNER_WORKFLOW = '.agents/workflows/improve-plan.md'`
- Line [1169](src/services/agentPromptBuilder.ts#L1169): persona path `.agent/personas/gatherer.md` → `.agents/personas/gatherer.md`
- Line [214](src/services/agentPromptBuilder.ts#L214): prompt string `.agent/workflows/accuracy.md` → `.agents/workflows/accuracy.md` (prompt text sent to AI agents — must match the new bundled path)
- Line [1312](src/services/agentPromptBuilder.ts#L1312): prompt string `.agent/workflows/accuracy.md` → `.agents/workflows/accuracy.md`
- Line [95](src/services/agentPromptBuilder.ts#L95): comment `.agent/workflows/improve-plan.md` → `.agents/workflows/improve-plan.md`
- Line [361](src/services/agentPromptBuilder.ts#L361): comment `.agent/workflows/switchboard-chat.md` → `.agents/workflows/switchboard-chat.md`

**`TaskViewerProvider.ts`:**
- Line [14765](src/services/TaskViewerProvider.ts#L14765): prompt string `.agent/workflows/accuracy.md` → `.agents/workflows/accuracy.md`
- Line [16175](src/services/TaskViewerProvider.ts#L16175): `path.join(workspaceRoot, '.agent', 'personas', ...)` → `'.agents'`
- Line [17353](src/services/TaskViewerProvider.ts#L17353): `path.join(workspaceRoot, '.agent', 'rules', ...)` → `'.agents'`

**`KanbanProvider.ts`:**
- Lines [2764](src/services/KanbanProvider.ts#L2764), [2797](src/services/KanbanProvider.ts#L2797): hardcoded fallback `.agent/workflows/improve-plan.md` → `.agents/workflows/improve-plan.md`

**`PlanningPanelProvider.ts`:**
- Line [3143](src/services/PlanningPanelProvider.ts#L3143): prompt string `.agent/skills/constitution_builder.md` → `.agents/skills/constitution_builder.md`
- Line [3156](src/services/PlanningPanelProvider.ts#L3156): prompt string `.agent/skills/constitution_builder.md` → `.agents/skills/constitution_builder.md`
- Line [4484](src/services/PlanningPanelProvider.ts#L4484): `path.join(workspaceRoot, '.agent', 'skills', 'refine_ticket.md')` → `'.agents'`

**`extension.ts`:**
- Line [2867](src/extension.ts#L2867): `path.join(workspaceRoot, '.agent')` → `'.agents'` (in `hasSwitchboardProtocolFiles` — add `.agent/` fallback check)
- Line [2868](src/extension.ts#L2868): `path.join(workspaceRoot, '.agent', 'workflows')` → `'.agents'` (add `.agent/` fallback)
- Lines [2872](src/extension.ts#L2872), [2876](src/extension.ts#L2876): comments mentioning `.agent` → `.agents`
- Lines [3148-3155](src/extension.ts#L3148): file list entries `.agent/rules/...`, `.agent/workflows/...` → `.agents/...`
- Line [3242](src/extension.ts#L3242): dirs array `'.agent'` → `'.agents'`
- Line [3255](src/extension.ts#L3255): `agentSourceUri = vscode.Uri.joinPath(extensionUri, '.agent')` → `'.agents'` (reads from bundled extension dir — must match the physical rename)
- Line [3263](src/extension.ts#L3263): `vscode.Uri.joinPath(workspaceUri, '.agent', relativePath)` → `'.agents'`
- Lines [3292-3299](src/extension.ts#L3292): file list entries `.agent/rules/...`, `.agent/workflows/...`, `.agent/personas/...` → `.agents/...`
- Line [3360](src/extension.ts#L3360): comment mentioning `.agent` → `.agents`

**Webviews/defaults:**
- `sharedDefaults.js:21`: `workflowFilePath: '.agents/workflows/improve-plan.md'`
- `kanban.html:2653`: input default value → `.agents/workflows/improve-plan.md`
- `kanban.html:2660`: display text → `.agents/workflows/improve-plan.md`
- `kanban.html:3107`: JS fallback default → `.agents/workflows/improve-plan.md`
- `kanban.html:3271`: placeholder text → `.agents/workflows/accuracy.md`
- `implementation.html:1424`: display text `.agent/` → `.agents/`
- `setup.html:610,613,1253,1861,1939`: display text `.agent/` → `.agents/`
- **DO NOT touch:** CSS classes `.agent-description` (kanban.html:1128), `.agent-list`, `.agent-row`, `.agent-name`, `.agent-input` (implementation.html:417,499,510,515,520,531,593,601-602,730,745-746)

### 4. Hardcoded fallback defaults (corrected — no `package.json` change needed)

**Clarification:** There is **no `switchboard.planner.workflowPath` setting declared in `package.json`** (verified: zero `workflowPath` matches in the configuration section at line 178+). The default `.agent/workflows/improve-plan.md` is a hardcoded fallback in `KanbanProvider.ts:2764,2797` via `config.get<string>('planner.workflowPath', '...')`. Since the setting is undeclared, `config.get` always returns the hardcoded fallback — no user has overridden it through VS Code settings.

**Action:** Update the hardcoded fallbacks in `KanbanProvider.ts` (already listed in §3) and the webview default values (already listed in §3). No `package.json` change is required. If a `switchboard.planner.workflowPath` setting is later declared in `package.json`, its default should be `.agents/workflows/improve-plan.md`.

### 5. Scaffold to `.agents/` — do NOT touch the user's existing `.agent/`
Switchboard only ever scaffolds its **own** managed content. After the rename, the scaffolding/migration code (`extension.ts`, `ControlPlaneMigrationService`) writes to `.agents/` going forward. It must **not** rename, move, copy-then-delete, or otherwise modify any pre-existing `.agent/` directory in a user's workspace — those are the user's files and may contain their own edits.

Behavior per workspace root:
- If `.agents/` is absent, scaffold it fresh from the bundled extension assets (same code path that previously created `.agent/`).
- If a stale `.agent/` exists, **leave it exactly as-is.** It is now inert (Antigravity only autoloads `.agents/`, so the old folder is invisible/harmless) and removing it is the user's decision, not ours.
- Optionally show a one-time, non-destructive informational notice ("Switchboard now uses `.agents/`. Your old `.agent/` folder is no longer used and can be removed if you wish.") — informational only, with no auto-delete action.

### 6. README note for users with a stale `.agent/`
Add a short section to `README.md` (and the in-workspace scaffolded README if one exists) explaining the rename: Switchboard moved its agent assets to `.agents/` because Antigravity only autoloads `.agents/`. Tell users they may have a leftover `.agent/` folder from a previous version that is now unused, and that they can review and delete it themselves — or use the one-click **Clean up old `.agent/` directory** button in the Setup tab (see §6a). The user decides — Switchboard never deletes it automatically.

### 6a. Opt-in "Clean up old `.agent/` directory" button (Setup tab)
Give upgraded users an explicit, discoverable, **user-initiated** way to remove the now-dead `.agent/` folder — so they understand what changed and can opt in, rather than Switchboard deleting silently.

**Placement:** the main **Setup** tab (`#startup-fields`, [setup.html:497](src/webview/setup.html#L497)) — the default tab every user lands on. The Control Plane is optional and not every Switchboard setup uses it, but the `.agent/` → `.agents/` rename affects **all** upgraded workspaces, so the cleanup must live where every user will see it. Add it as a self-contained card near the top of the Setup tab so it's visible on upgrade.

**Conditional visibility:** the card/button is shown **only when a stale `.agent/` actually exists** in at least one workspace root. On Setup load, the backend scans the workspace root(s); if none have `.agent/`, the card stays hidden so it never nags users who upgraded cleanly. Surface a short explainer: *"Switchboard now stores agent assets in `.agents/` (Antigravity only autoloads `.agents/`). A leftover `.agent/` folder from a previous version was found and is no longer used."*

**Click flow (destructive → must be guarded):**
1. Button posts e.g. `requestAgentDirCleanup` to the host.
2. Host shows a **custom confirmation modal** (consistent with the tickets-delete-modal pattern — not a native VS Code dialog), listing the exact absolute path(s) to be deleted so the user sees precisely what will be removed.
3. On confirm, the host deletes `.agent/` recursively **only if all safety guards pass** (see below), reports per-root success/failure, and the webview hides the card and shows a status (e.g. "Removed .agent/ from 1 workspace").

**Safety guards (host side) — refuse to delete if any fail:**
- A sibling `.agents/` exists for that root (never strand the user without assets).
- The resolved target is exactly `<workspaceRoot>/.agent` (path-traversal/symlink check; do not follow a symlinked `.agent`).
- The active `switchboard.planner.workflowPath` (or any agent-asset config) does **not** point into `.agent/` — if the user deliberately kept and references the old folder, skip it and tell them why.
- Multi-root: handle each workspace folder independently; a guard failure on one root must not block cleanup of others.

**New backend handlers (e.g. in `SetupPanelProvider` / `TaskViewerProvider`):** `getAgentDirCleanupState` (returns which roots have a deletable `.agent/`) and `performAgentDirCleanup` (runs the guarded recursive delete and returns results).

### 6b. Backward-compatible resolution (transition safety)
Where the code reads a known asset (workflows/personas/rules/skills), resolve `.agents/<rel>` first and fall back to `.agent/<rel>` if missing. Likewise accept a user-set `.agent/...` config value (stored in Switchboard's internal config via the webview UI). This means a user who deliberately kept their old `.agent/` (with custom edits) and pointed config at it still works. Keep this fallback for at least one release.

**Specific resolvers needing fallback:**
- `hasSwitchboardProtocolFiles` (extension.ts:2866-2879): check `.agents/workflows` first, fall back to `.agent/workflows`.
- `agentPromptBuilder.ts` persona/workflow path resolution.
- `TaskViewerProvider.ts` persona/rules path joins (16175, 17353).
- `PlanningPanelProvider.ts` skill path join (4484).
- `KanbanProvider.ts` workflow path resolution (2764, 2797): accept `.agent/...` from internal config, resolve against `.agents/` first.

### 7. Docs
Update `AGENTS.md` lines [6](AGENTS.md#L6), [29](AGENTS.md#L29), [35](AGENTS.md#L35), [95](AGENTS.md#L95) (`.agent/workflows` → `.agents/workflows`, `.agent/skills/` → `.agents/skills/`). Update `src/webview/switchboard/README.md:7` (`.agent/workflows/` → `.agents/workflows/`). Note: `.cursorrules` does **not** reference `.agent/` and needs no update.

### 8. Tests
Update tests referencing `.agent/...`:
- `src/test/minimal-prompt.test.js` (16 matches — all `plannerWorkflowPath: '.agent/workflows/improve-plan.md'` and assertion strings)
- `src/test/kanban-default-prompt-previews.test.js` (3 matches)
- `src/test/control-plane-migration.test.js` (5 matches — path joins and assertions)
- `src/test/agent-version-migration.test.js` (8 matches — path joins for test fixtures)
- `src/test/agent-prompt-builder-subagents.test.js` (2 matches)
- `src/services/__tests__/agentPromptBuilder.test.ts` (1 match — assertion for `.agent/workflows/accuracy.md`)

Add tests that: (a) scaffolding a fresh workspace creates `.agents/` with the expected content; (b) when a pre-existing `.agent/` is present, scaffolding leaves it byte-for-byte untouched and does not delete it; (c) asset resolution prefers `.agents/` but falls back to a user's `.agent/`; (d) the cleanup handler deletes `.agent/` only when guards pass, and refuses when `.agents/` is missing, when config references `.agent/`, or when the path is a symlink; (e) `getAgentDirCleanupState` reports the card hidden when no stale `.agent/` exists; (f) `hasSwitchboardProtocolFiles` returns true when only `.agents/workflows` exists (not `.agent/workflows`); (g) CSS class names in `implementation.html` and `kanban.html` are unchanged after the rename (regression guard against bare global replace).

## Verification Plan

### Automated Tests
- Run the full test suite (`npm test -- --forceExit`) including the new tests (cleanup-state, guard tests, detection-logic, CSS-regression). **Note: per session directives, the test suite will be run separately by the user — the plan specifies what to test, not when.**

### Manual Verification
1. `git mv` the directory; `grep -rn "\.agent\b" src` returns only intentional fallback references (in §6b resolution logic) and CSS class names (`.agent-description` etc.). No stray path references remain.
2. `vsce package` (or the project's package script) and confirm `.agents/**` is included in the VSIX and `.agent/**` is not.
3. Confirm Antigravity autoloads the scaffolded `.agents/` (the motivating fix): open the workspace in Antigravity and verify the workflows/skills/rules are now picked up where they previously were not.
4. Fresh workspace: trigger scaffolding → confirm `.agents/` is created with workflows/personas/rules/skills; planner/reviewer prompts resolve.
5. Existing workspace with a populated `.agent/`: activate → confirm Switchboard scaffolds `.agents/` and **leaves the old `.agent/` completely untouched** (byte-for-byte unchanged, not deleted, not moved).
6. Cleanup button — appears only when stale `.agent/` exists: open the Setup tab in a workspace with a leftover `.agent/` → confirm the **Clean up old `.agent/` directory** card is shown with the explainer and the exact path(s). In a clean (no `.agent/`) workspace → confirm the card is hidden. Verify it shows regardless of whether a control plane is configured.
7. Cleanup button — happy path: click it → confirm a custom confirmation modal (not a native VS Code dialog) lists the exact path(s); confirm → `.agent/` is removed, the card hides, and a success status shows. `.agents/` is untouched.
8. Cleanup button — guards: (a) remove `.agents/` first → confirm the button refuses/skips that root (won't strand assets); (b) set `switchboard.planner.workflowPath = .agent/...` → confirm that root is skipped with an explanation; (c) multi-root with one guarded and one deletable → confirm only the deletable root is cleaned.
9. User who kept their old `.agent/` and set `switchboard.planner.workflowPath = .agent/...` → confirm fallback resolution still finds the workflow.
10. CSS regression: visually inspect the Implementation and Kanban panels — confirm agent-row, agent-name, agent-description, agent-input styles are intact (no broken styling from accidental CSS class rename).
11. Accuracy mode: trigger accuracy mode on a plan → confirm the prompt references `.agents/workflows/accuracy.md` and the file exists at that path in the scaffolded workspace.

---

**Recommendation:** Complexity is 7 → **Send to Lead Coder**. This is a multi-file coordinated rename with a destructive UI feature, CSS class collision hazards, and backward-compatibility fallback requirements. A lead coder can manage the cross-file coordination and verify the safety guards.
