# Remove the Agent File Open Guard from Switchboard

## Goal

Remove the entire "Agent File Opening Prevention" feature (a.k.a. the agent file-open guard) from Switchboard. This feature auto-closes any file that gets opened in the editor when `switchboard.preventAgentFileOpening` is enabled, and exposes a shield toggle ("Guard: On/Off") in the status bar plus an "Override Open" right-click command to bypass it.

### Problem Analysis & Root Cause

This is a **feature removal** task, not a bug fix. The user has decided the agent file-open guard is no longer wanted and has asked for it to be stripped out completely. The feature is spread across four layers, all of which must be removed together to avoid leaving dead UI, dead config, or dangling message handlers:

1. **The guard logic itself** — a `vscode.window.tabGroups.onDidChangeTabs` listener in `src/extension.ts` that closes any newly-opened text tab unless its URI is in an `allowedUrisToOpen` allowlist, plus the `switchboard.forceOpenFile` command that seeds that allowlist, plus the `switchboard.togglePreventAgentFileOpening` command, plus the module-level `allowedUrisToOpen` Set and the `preventAgentFileOpeningEnabled` VS Code context key.
2. **The status bar item** — `fileOpeningPreventionStatusBarItem` in `src/extension.ts` (creation, visibility wiring inside `updateStatusBarVisibility` / `updateHubTooltip` / the `openHub` quick-pick / the config-change listener).
3. **The Setup tab UI** — the "Agent File Opening Prevention" checkbox in the Setup tab (`src/webview/setup.html`), its hydration message handler, and the `getPreventAgentFileOpeningSetting` / `setPreventAgentFileOpeningSetting` request wiring.
4. **The Status Bar tab UI** — the "Show Agent Open Toggle" checkbox in the Status Bar tab (`src/webview/setup.html`), its hydration message handler, and the `getStatusShowAgentOpenSetting` / `setStatusShowAgentOpenSetting` request wiring.

The root cause of the sprawl is that the feature was bolted on in three places (guard logic, status bar item, two separate setup checkboxes) with parallel config keys (`switchboard.preventAgentFileOpening` and `switchboard.statusBar.showAgentOpenToggle`), so a partial removal would leave orphaned UI controls that post messages no backend handler answers, plus orphaned backend handlers that read a config key no UI sets.

### Background Context

- The feature ships in a **published extension with ~4,000 installs**, so per the workspace `CLAUDE.md` migration rules the two config keys (`switchboard.preventAgentFileOpening`, `switchboard.statusBar.showAgentOpenToggle`) and the two commands (`switchboard.forceOpenFile`, `switchboard.togglePreventAgentFileOpening`) **did ship in released versions**. However, this is a *removal* of a feature flag, not a rename of state that users have data in — the config values are booleans with no user-authored payload. The migration rule's intent (preserve user data) is satisfied by simply dropping the keys from `package.json` contributes; VS Code silently ignores unknown workspace settings, so leftover `switchboard.preventAgentFileOpening: true` entries in a user's `settings.json` become harmless no-ops. No `*.migrated.bak` archival is needed for boolean settings.
- The `switchboard.forceOpenFile` command is *only* meaningful when the guard is active (its sole purpose is to bypass the guard). Removing the guard means the command and its two `editor/context` + `explorer/context` menu contributions must also go, otherwise users get a useless "Override Open" right-click item that just calls `vscode.open`.
- The `preventAgentFileOpeningEnabled` VS Code context key is referenced only by the two menu `when` clauses for `forceOpenFile`; once those menus are removed the context key has no consumers and its `setContext` calls should be deleted too.

## Metadata

- **Tags:** refactor, ui, docs
- **Complexity:** 4/10
- **Files touched:** 7 source files + 2 docs + 1 dev-settings file
- **Risk:** Low–Medium. The change is mechanical (deletion), but touches the status bar visibility function which has many sibling controls — care is needed to not disturb the surrounding `showTerminalControls` / `showKanbanButton` etc. branches.

## User Review Required

No user review gate is required before implementation. This is a pure feature-removal with no data migration, no breaking API contract change, and no irreversible destructive operation. The user has already decided the feature should be removed. Proceed directly to implementation.

## Complexity Audit

### Routine
- Well-bounded deletion across a known, finite set of call sites (enumerated in Proposed Changes). No new logic, no new abstraction, and no data migration.
- No external API contracts change (the removed commands were internal Switchboard commands, not invoked by other extensions).
- No persisted user data depends on the feature.
- The `onDidChangeTabs` listener is self-contained and guarded by an early `return` when the config is off, so removing it cannot affect other tab-handling code.

### Complex / Risky
- The status bar visibility function (`updateStatusBarVisibility`) and the hub tooltip builder (`updateHubTooltip`) interleave the guard's branch with sibling branches, so the edits must be surgical rather than wholesale block deletes — care is needed to not disturb the surrounding `showTerminalControls` / `showKanbanButton` etc. branches.

## Edge-Case & Dependency Audit

| Edge Case / Dependency | Handling |
|---|---|
| Users with `switchboard.preventAgentFileOpening: true` left in their `settings.json` after upgrade | VS Code silently ignores unknown settings; the key is removed from `package.json` contributes so it no longer appears in the Settings UI. No migration needed (boolean, no user data). |
| Users with `switchboard.statusBar.showAgentOpenToggle: false` left in `settings.json` | Same — becomes a harmless unknown key. The other `statusBar.show*` keys remain valid. |
| The `allowedUrisToOpen` module-level Set | Deleted along with its only two consumers (`onDidChangeTabs` listener and `forceOpenFile` command). No other code references it (verified by grep). |
| The `preventAgentFileOpeningEnabled` VS Code context key | Only consumed by the two `forceOpenFile` menu `when` clauses; both menus are removed, so the `setContext` calls at extension.ts:68 and extension.ts:2111 are deleted. |
| `updateStatusBarVisibility` compact-mode `enabledCount` | Currently increments by 1 when `showAgentOpenToggle` is true. After removal, the count simply no longer includes that +1 — the hub dropdown still shows if any *other* action is enabled. No special handling. |
| `updateHubTooltip` markdown lines | The `[$(shield) Guard: ...]` line is removed; the `if (lines.length > 2) lines.push('---')` separator logic in subsequent blocks already guards against leading separators, so no cascade fix needed. |
| `openHub` quick-pick | The guard's quick-pick item is the first item pushed; removing it means the "Terminal Controls" separator logic (`if (items.length > 0)`) still works because terminal items may still be pushed first. Verify no leading-separator artifact. |
| Setup tab hydration (`postSetupPanelState` in TaskViewerProvider) | Removes two `postMessage` calls (`preventAgentFileOpeningSetting`, `statusShowAgentOpenSetting`); the webview message handlers for those types are also removed, so no dangling hydration. |
| Docs (`switchboard_user_manual.md`, `README.md`) | Remove the "Agent File Opening Prevention" section, the two settings-table rows, the "File Opening" command table, the FAQ entry, and the README status-bar settings line item. |
| Dev `.vscode/settings.json` | Remove the two dev-only setting lines (lines 26 and 36). This is repo-local dev config, not user-facing. |
| `dist/` | Per workspace `CLAUDE.md`, `dist/` is NOT used during dev/testing and must NOT be audited. Only `src/` is the source of truth. |

## Dependencies

- None. This plan is a self-contained feature removal with no prerequisite plans.

## Adversarial Synthesis

Key risks: (1) the original docs edit list omitted `switchboard_user_manual.md:1399` (the Setup Tab walkthrough bullet "Agent File Opening Prevention — Auto-close files opened by agents."), which would leave an orphan reference; (2) surgical edits inside `updateStatusBarVisibility` / `updateHubTooltip` / `openHub` must preserve sibling-control separator logic; (3) the `package.json` `menus` object becomes empty after removal and must be handled explicitly. Mitigations: line 1399 is now enumerated in §6; the post-edit grep sweep backstops any remaining orphans; the existing `items.length > 0` / `lines.length > 2` guards already handle the now-empty initial collections; the `menus` key is deleted entirely (cleaner than leaving `{}`).

## Proposed Changes

### 1. `src/extension.ts` — remove guard logic, commands, status bar item, context key

**1a. Module-level state (lines 45–46, 62–68):** delete the `fileOpeningPreventionStatusBarItem` declaration, the `allowedUrisToOpen` Set, the `preventAgentFileOpening` const, and the initial `setContext` call.

```ts
// DELETE lines 45-46:
// Status bar item for file opening prevention toggle
let fileOpeningPreventionStatusBarItem: vscode.StatusBarItem;

// DELETE lines 62-68:
// Agent File Opening Prevention: URIs explicitly allowed to stay open
const allowedUrisToOpen = new Set<string>();

// Sync context key for menu visibility. The context key name uses an "Enabled" suffix
// to distinguish it from the configuration property "switchboard.preventAgentFileOpening".
const preventAgentFileOpening = vscode.workspace.getConfiguration('switchboard').get<boolean>('preventAgentFileOpening', false);
void vscode.commands.executeCommand('setContext', 'switchboard.preventAgentFileOpeningEnabled', preventAgentFileOpening);
```

**1b. `onDidChangeTabs` guard listener (lines 1733–1752):** delete the entire `// Auto-close opened files (Agent File Opening Prevention)` block.

**1c. `forceOpenFile` and `togglePreventAgentFileOpening` command registrations (lines 1757–1775):** delete both `vscode.commands.registerCommand` blocks. These are registered unconditionally outside `if (workspaceRoot)`, so the whole `context.subscriptions.push(...)` pair goes.

**1d. Status bar item creation (lines 1885–1893):** delete the `fileOpeningPreventionStatusBarItem` creation block.

**1e. `updateStatusBarVisibility` (lines 1951–2052):**
- Remove `const showAgentOpenToggle = ...` (line 1953).
- In the `compactMode` branch: remove `fileOpeningPreventionStatusBarItem.hide();` (line 1963) and the `if (showAgentOpenToggle) { enabledCount++; }` block (lines 1974–1976).
- In the non-compact branch: remove the `if (showAgentOpenToggle) { fileOpeningPreventionStatusBarItem.show(); } else { fileOpeningPreventionStatusBarItem.hide(); }` block (lines 2004–2008).

**1f. `updateHubTooltip` (lines 2056–2105):** remove `const showAgentOpenToggle = ...` (line 2061) and the `if (showAgentOpenToggle) { ... lines.push(...) }` block (lines 2071–2074).

**1g. `openHub` quick-pick (lines 2148–2210 area):** remove `const showAgentOpenToggle = ...` (line 2150) and the `if (showAgentOpenToggle) { ... items.push(...) }` block (lines 2164–2171). Verify the following `if (showTerminalControls) { if (items.length > 0) items.push({ separator }) }` still works — it will, because `items.length > 0` correctly handles the now-empty initial array.

**1h. Config-change listener (lines 2107–2133):** delete the entire `if (e.affectsConfiguration('switchboard.preventAgentFileOpening')) { ... }` block (lines 2109–2119), and remove `e.affectsConfiguration('switchboard.statusBar.showAgentOpenToggle') ||` from the multi-config `if` condition (line 2121).

### 2. `src/services/TaskViewerProvider.ts` — remove handlers and hydration

- **Delete** `handleGetPreventAgentFileOpeningSetting` (lines 4056–4058) and `handleSetPreventAgentFileOpeningSetting` (lines 4060–4063).
- **Delete** `handleGetStatusShowAgentOpenSetting` (lines 4074–4076) and `handleSetStatusShowAgentOpenSetting` (lines 4078–4081).
- **Delete** the two `postSetupPanelState` hydration `postMessage` calls for `preventAgentFileOpeningSetting` (lines 4525–4528) and `statusShowAgentOpenSetting` (lines 4533–4536).

### 3. `src/services/SetupPanelProvider.ts` — remove message handlers

- **Delete** the `case 'getPreventAgentFileOpeningSetting':` block (lines 556–561).
- **Delete** the `case 'setPreventAgentFileOpeningSetting':` block (lines 582–585).
- **Delete** the `case 'getStatusShowAgentOpenSetting':` block (lines 610–615).
- **Delete** the `case 'setStatusShowAgentOpenSetting':` block (lines 616–619).

### 4. `src/webview/setup.html` — remove both checkboxes and their JS

**4a. Setup tab checkbox (lines 607–613):** delete the `<label>` containing `prevent-agent-file-opening-toggle` and its "Agent File Opening Prevention" copy.

**4b. Status Bar tab checkbox (lines 1285–1291):** delete the `<label>` containing `status-show-agent-open-toggle` and its "Show Agent Open Toggle" copy.

**4c. Tab-load callbacks:**
- Remove `vscode.postMessage({ type: 'getPreventAgentFileOpeningSetting' });` from the `'setup'` tab callback (line 1823).
- Remove `vscode.postMessage({ type: 'getStatusShowAgentOpenSetting' });` from the `'status-bar'` tab callback (line 1865).

**4d. Event listeners (lines 3897–3903):** delete both the `prevent-agent-file-opening-toggle` and `status-show-agent-open-toggle` `change` listeners.

**4e. Message handlers (lines 4547–4553 and 4583–4589):** delete the `case 'preventAgentFileOpeningSetting':` and `case 'statusShowAgentOpenSetting':` blocks.

### 5. `package.json` — remove commands, settings, menus

- **Commands (lines 144–152):** delete the `switchboard.forceOpenFile` and `switchboard.togglePreventAgentFileOpening` command declarations.
- **Settings (lines 512–516):** delete the `switchboard.preventAgentFileOpening` contribution.
- **Settings (lines 626–631):** delete the `switchboard.statusBar.showAgentOpenToggle` contribution.
- **Menus (lines 731–742):** delete the entire `editor/context` entry for `forceOpenFile` and the `explorer/context` entry for `forceOpenFile`. Verified: these are the *only* entries in the `menus` object, so after removal the whole `"menus"` key becomes empty — **delete the `"menus"` key entirely** (cleaner than leaving `{ "editor/context": [], "explorer/context": [] }` or `{}`; the schema treats a missing `menus` key as valid).

### 6. `docs/switchboard_user_manual.md` — remove all references

- **Line 477:** remove the `switchboard.statusBar.showAgentOpenToggle` bullet from the Status Bar Hub settings list.
- **Lines 521–525:** remove the entire "### Agent File Opening Prevention" subsection (heading + body + `Settings:`/`Command:` lines). The trailing `---` separator at line 527 is a section divider for "## 18. Quota Economics" and should be kept.
- **Line 608:** remove the `switchboard.preventAgentFileOpening` row from the settings table.
- **Line 623:** remove the `switchboard.statusBar.showAgentOpenToggle` row from the settings table.
- **Lines 785–790:** remove the entire "### File Opening" command table subsection.
- **Line 1399:** remove the "**Agent File Opening Prevention** — Auto-close files opened by agents." bullet from the Setup Tab walkthrough (this reference was missing from the original plan and is added after verification).
- **Line 1452:** remove the "Show Agent Open Toggle" bullet from the Status Bar Tab walkthrough.
- **Lines 1583–1585:** remove the "### Agent File Opening" FAQ entry.

### 7. `README.md` — remove the setting from the status-bar settings line

- **Line 268:** remove `` `switchboard.statusBar.showAgentOpenToggle`, `` from the comma-separated settings list (keep the rest of the line intact).

### 8. `.vscode/settings.json` — remove dev-only setting lines

- **Line 26:** delete `"switchboard.preventAgentFileOpening": false,`.
- **Line 36:** delete `"switchboard.statusBar.showAgentOpenToggle": true,`.

## Verification Plan

### Automated Tests

Automated tests and project compilation are NOT run as part of this plan session (per session directives — the test suite and `npm run compile` are run separately by the user). No new unit/integration tests are required for a pure feature-removal. The user should separately: (a) re-run the existing test suite to confirm no regressions in status-bar or setup-panel coverage, and (b) run `npm run compile` (webpack) to confirm there are no dangling references to the deleted `fileOpeningPreventionStatusBarItem` variable (the grep sweep below confirms this statically).

### Manual Verification

1. **Grep sweep for orphans:** After edits, run
   ```
   rg -n "preventAgentFileOpening|togglePreventAgentFileOpening|forceOpenFile|showAgentOpenToggle|fileOpeningPrevention|allowedUrisToOpen|preventAgentFileOpeningEnabled" src docs package.json README.md .vscode/settings.json
   ```
   Expected: **zero matches** outside `.switchboard/plans/` (historical plan files are allowed to reference the old feature).

2. **Manual smoke test in a VS Code dev host (installed VSIX):**
   - Open the Setup tab → confirm the "Agent File Opening Prevention" checkbox is gone and the tab still loads without console errors.
   - Open the Status Bar tab → confirm the "Show Agent Open Toggle" checkbox is gone and the remaining toggles (Terminal, Kanban, Artifacts, Design, Project, Memo) still hydrate and persist.
   - Confirm the status bar no longer shows a `$(shield) Guard: On/Off` item in either compact or non-compact mode.
   - Open the hub quick-pick (`switchboard.openHub`) → confirm no "Guard" entry appears and the "Terminal Controls" separator still renders correctly when terminal controls are enabled.
   - Right-click a file in the editor/explorer → confirm the "Override Open" context-menu item is gone.
   - Open a file while a workspace is open → confirm it opens normally and is **not** auto-closed (the guard listener is gone).

3. **Config-change listener sanity:** Toggle `switchboard.statusBar.showTerminalControls` at runtime and confirm `updateStatusBarVisibility` still re-renders the terminal buttons (proves the listener's `if` condition still fires after the `showAgentOpenToggle` clause was removed).

4. **No `dist/` audit:** Per workspace `CLAUDE.md`, do NOT check or rebuild `dist/`; testing is done via the installed VSIX only.

## Recommendation

Complexity 4/10 → **Send to Coder**.
