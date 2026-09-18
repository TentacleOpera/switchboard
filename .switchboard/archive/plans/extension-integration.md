# Wire Design Panel into Extension Host and Update Package Contributions

## Goal

Register the new `DesignPanelProvider` with the VS Code extension host by adding a command, a status bar button, a quick-action button in `implementation.html`, and updating `package.json` with commands, settings, and the `@google/stitch-sdk` dependency.

**Core Problem & Background:**

The new `DesignPanel` (created in `design-panel-creation.md`) needs to be accessible to users. This requires wiring it into `src/extension.ts` (instantiation, command registration, status bar), `src/webview/implementation.html` (quick-action button), `src/services/TaskViewerProvider.ts` (message routing), and `package.json` (command contributions, configuration properties, dependency).

## Metadata

**Tags:** frontend, backend, extension-host, configuration
**Complexity:** 4

## User Review Required

- The `switchboard.statusBar.showDesignButton` setting defaults to `false`; users must opt-in to see the status bar button.
- The `switchboard.stitch.defaultOutputFolder` setting uses `"resource"` scope; clarify that it resolves against the active workspace root at runtime.

## Complexity Audit

### Routine
- Import and instantiate `DesignPanelProvider` in `src/extension.ts`.
- Register `switchboard.openDesignPanel` command.
- Add a status bar item with conditional visibility.
- Add a quick-action button in `src/webview/implementation.html`.
- Add `openDesignPanel` message handler in `src/services/TaskViewerProvider.ts`.
- Add command and settings contributions to `package.json`.

### Complex / Risky
- Ensuring `updateStatusBarVisibility()` correctly toggles the new Design button without breaking existing status bar logic.
- Handling multi-root workspace settings scope for `switchboard.stitch.defaultOutputFolder`.
- Ensuring `DesignPanelProvider` is disposed correctly when the extension deactivates.

## Edge-Case & Dependency Audit

- **Dependencies:** This plan depends on `design-panel-creation.md` being completed first, so that `DesignPanelProvider` exists to be wired.
- **Settings scope:** `switchboard.stitch.defaultOutputFolder` has `scope: "resource"`. In a multi-root workspace, this resolves against the active workspace root at runtime. Document this behavior.
- **Disposal:** `DesignPanelProvider` must be pushed to `context.subscriptions` so it is disposed on extension deactivation.

## Adversarial Synthesis

Key risks: status bar item priority conflicts with existing items (setup, file opening prevention, terminal controls, kanban, artifacts); `package.json` commands/settings typos break activation; `TaskViewerProvider` message handler missing the `openDesignPanel` case. Mitigations: use priority 93 (right of artifacts at 94), copy-paste exact command ID strings across extension.ts, package.json, and TaskViewerProvider.ts, and validate with a grep for `openDesignPanel`.

## Proposed Changes

### Phase 4: Wire the New Panel into the Extension Host

#### 4.1 `src/extension.ts`
- **Import** `DesignPanelProvider` (add after line 24, after `import { PlanningPanelProvider } from './services/PlanningPanelProvider';`).
- **Instantiate** after `planningPanelProvider` (insert after the `planningPanelProvider` instantiation block):
  ```typescript
  const designPanelProvider = new DesignPanelProvider(
      context.extensionUri,
      () => kanbanProvider!.getCurrentWorkspaceRoot() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  );
  context.subscriptions.push(designPanelProvider);
  ```
- **Register command** (insert after existing command registrations, before `context.subscriptions.push(openDesignPanelDisposable);`):
  ```typescript
  const openDesignPanelDisposable = vscode.commands.registerCommand(
      'switchboard.openDesignPanel',
      async () => { await designPanelProvider.open(); }
  );
  context.subscriptions.push(openDesignPanelDisposable);
  ```
- **Status bar item:** Add `designStatusBarItem` (priority 93, right-aligned) with `$(paintcan)` icon, tooltip "Open Design Panel", command `switchboard.openDesignPanel`. Insert after `artifactsStatusBarItem` creation (line 1736) in the existing status bar item block.
- **Update** `updateStatusBarVisibility()` (lines 1738–1772): add `showDesignButton` read at the top, conditional `designStatusBarItem.show()/hide()` in the body, and `e.affectsConfiguration('switchboard.statusBar.showDesignButton')` in the config-change listener (around line 1791).
- **Add** configuration change listener: if `switchboard.stitch.apiKey` changes, post a message to the design panel to refresh the Stitch tab auth state.

#### 4.2 `src/webview/implementation.html`
In the Quick Actions section (exact lines 1895–1899), add a fourth button:
```html
<button id="btn-quick-design" class="secondary-btn is-teal" style="flex:1">design</button>
```
And its event listener (add alongside existing quick-action listeners):
```javascript
const btnQuickDesign = document.getElementById('btn-quick-design');
if (btnQuickDesign) btnQuickDesign.addEventListener('click', () => vscode.postMessage({ type: 'openDesignPanel' }));
```

#### 4.3 `src/services/TaskViewerProvider.ts`
Add a handler for the `openDesignPanel` message type (insert after the existing `openPlanningPanel` case at lines 7640–7642):
```typescript
case 'openDesignPanel':
    await vscode.commands.executeCommand('switchboard.openDesignPanel');
    break;
```

### Phase 5: Update `package.json` Contributions

#### 5.1 Commands
Add to `contributes.commands`:
```json
{
  "command": "switchboard.openDesignPanel",
  "title": "Switchboard: Open Design Panel",
  "category": "Switchboard"
}
```

#### 5.2 Settings
Add to `contributes.configuration.properties`:
```json
"switchboard.stitch.apiKey": {
  "type": "string",
  "default": "",
  "description": "Google Stitch API key. Falls back to STITCH_API_KEY environment variable if empty.",
  "scope": "application"
},
"switchboard.stitch.defaultProjectId": {
  "type": "string",
  "default": "",
  "description": "Default Stitch project ID to pre-select in the Design panel.",
  "scope": "application"
},
"switchboard.stitch.defaultOutputFolder": {
  "type": "string",
  "default": "",
  "description": "Default folder path for downloaded Stitch assets (PNG/HTML). Relative to workspace root.",
  "scope": "resource"
},
"switchboard.statusBar.showDesignButton": {
  "type": "boolean",
  "default": false,
  "description": "Controls visibility of the Open Design Panel button on the status bar.",
  "scope": "window"
}
```

#### 5.3 Dependency
Add `@google/stitch-sdk` to `dependencies` in `package.json`:
```json
"@google/stitch-sdk": "^0.3.5"
```

## Verification Plan

### Manual Verification Checklist
- [ ] Running `Switchboard: Open Design Panel` from the command palette opens the Design panel.
- [ ] The `implementation.html` sidebar shows the new Design quick-action button and opens the panel.
- [ ] The status bar Design button appears when `switchboard.statusBar.showDesignButton` is enabled.
- [ ] The status bar Design button hides when the setting is disabled.
- [ ] `package.json` validates without errors (commands, settings, and dependency entries are well-formed).
- [ ] `npm install` resolves `@google/stitch-sdk` to `^0.3.5`.
- [ ] `TaskViewerProvider` routes the `openDesignPanel` message to the correct command.

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Status bar priority collision | Low | Use priority 93 (right of `artifactsStatusBarItem` at 94). Test in a workspace with all status bar items enabled. |
| `package.json` typo breaks extension activation | Medium | Copy-paste exact command IDs and setting keys. Run `vsce package --dry-run` or validate JSON schema. |
| `switchboard.stitch.defaultOutputFolder` scope ambiguity | Low | Document that `"resource"` scope resolves against the active workspace root at runtime. |
| `DesignPanelProvider` not disposed on deactivation | Low | Always push the provider instance to `context.subscriptions` immediately after creation. |

## Files Changed

### Modified Files
- `src/extension.ts` — wire DesignPanelProvider, command, status bar, config listener
- `src/webview/implementation.html` — add Design quick-action button
- `src/services/TaskViewerProvider.ts` — add `openDesignPanel` message handler
- `package.json` — add command, settings, and `@google/stitch-sdk` dependency
- `package-lock.json` — updated by `npm install`

## Recommendation

**Send to Intern**

## Review Findings
Reviewed 2026-06-11 (commit 6b62378). All plan items verified present and correctly cross-referenced: command/settings/dependency in `package.json`, provider instantiation + disposal + command + status bar item (priority 93) + visibility toggle + `stitch.apiKey` config listener in `src/extension.ts`, `openDesignPanel` routing in `TaskViewerProvider.ts:7643`, and the quick-action button in `implementation.html`. No code fixes were needed for this plan; the only deviation is a third `context` constructor argument on `DesignPanelProvider` (benign extension of the planned two-arg signature). The auto-commit also swept in out-of-plan confirm-dialog removals in `kanban.html` and `TaskViewerProvider.ts` — these are correct per the repo's no-confirm-dialogs rule (confirm() is a silent no-op in webviews) and were left in place. Verification was static per session constraints (no compile/tests); `npm run compile` must be run before the extension picks any of this up.
