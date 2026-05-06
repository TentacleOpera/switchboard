# Agent File Opening Prevention Feature

## Goal
Auto-close any file that gets opened in the editor. Provide a right-click "Override Open" command that opens a file without triggering the auto-close.

## Metadata
**Tags:** frontend, UX, workflow
**Complexity:** 3

## User Review Required
- The right-click menu item label: "Override Open" — confirm this wording.
- Default OFF for the global toggle — confirm this is acceptable.

## Requirements

### Core Requirements
1. **Auto-close opened files**: When the global toggle is ON, any file that opens in the editor is immediately closed.
2. **Override Open command**: Right-click context menu item that opens a file bypassing the auto-close.
3. **Global Toggle**: Setting `switchboard.preventAgentFileOpening` (boolean, default `false`).

## Technical Approach

### Mechanism
- Listen on `vscode.workspace.onDidOpenTextDocument`.
- When a document opens and the setting is ON, close it via `vscode.commands.executeCommand('workbench.action.closeActiveEditor')`.
- The "Override Open" command sets a module-level boolean flag `skipNextClose`, opens the file, then clears the flag on the next microtask. The listener checks this flag and skips the close if set.

### Architecture

#### 1. Global Setting — add to `package.json`
File: `/Users/patrickvuleta/Documents/GitHub/switchboard/package.json`

Insert inside the existing `"contributes.configuration.properties"` block (after line ~403, before the closing `}}`):
```json
"switchboard.preventAgentFileOpening": {
  "type": "boolean",
  "default": false,
  "description": "Auto-close any file that gets opened in the editor."
}
```

#### 2. Context menu + command — add to `package.json`

Add to the existing `"contributes.commands"` array (after line ~157):
```json
{
  "command": "switchboard.forceOpenFile",
  "title": "Override Open"
}
```

Add to the existing `"contributes.menus"` object (the `"explorer/context"` array already exists; add a new `"editor/context"` if not present):
```json
"editor/context": [
  {
    "command": "switchboard.forceOpenFile",
    "when": "switchboard.preventAgentFileOpening"
  }
],
"explorer/context": [
  {
    "command": "switchboard.forceOpenFile",
    "when": "switchboard.preventAgentFileOpening"
  }
]
```

#### 3. Listener + command — add to `extension.ts`
File: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts`

Add a module-level flag near the top of the file (after line ~28, alongside other module-level state):
```typescript
let skipNextClose = false;
```

Inside the `activate()` function, register the listener and command. Add after the existing command registrations (e.g., after line ~1757, before the closing of `activate`):
```typescript
// Auto-close opened files (Agent File Opening Prevention)
context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(async (document) => {
        if (skipNextClose) {
            skipNextClose = false;
            return;
        }
        const config = vscode.workspace.getConfiguration('switchboard');
        if (!config.get<boolean>('preventAgentFileOpening')) return;
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    })
);

context.subscriptions.push(
    vscode.commands.registerCommand('switchboard.forceOpenFile', async (uri: vscode.Uri) => {
        skipNextClose = true;
        await vscode.commands.executeCommand('vscode.open', uri);
    })
);
```

## Complexity Audit
### Routine
- Add one config property to `package.json` — follows existing pattern from 20+ other properties.
- Add one command + two menu contributions to `package.json` — follows existing pattern.
- Register one listener + one command in `extension.ts` — follows existing pattern used by 30+ other registrations.
- Single boolean flag for coordination between command and listener.

### Complex / Risky
- None.

## Edge-Case & Dependency Audit
- **Race Conditions**: The `skipNextClose` flag is set synchronously before `vscode.open` and cleared on the first `onDidOpenTextDocument` firing. If two "Override Open" commands fire in rapid succession, the second will clear the flag before the first document opens — but this is a user-initiated action and unlikely in practice. Acceptable.
- **Security**: No security surface. Reads a boolean config, closes editors.
- **Side Effects**: `workbench.action.closeActiveEditor` closes whichever editor is active. If the auto-opened file isn't the active editor (e.g., it opens in a background tab), the wrong editor may close. This is a VS Code API limitation — no workaround exists without deeper editor group manipulation. Acceptable for the stated use case.
- **Dependencies & Conflicts**: No conflicts with existing kanban plans (only architectural refactor plans in CREATED column — unrelated).

## Dependencies
- None.

## Adversarial Synthesis
**Risk Summary**: The only material risk is `closeActiveEditor` closing the wrong tab if the opened file isn't focused. Mitigation: this matches the user's stated requirements and the VS Code API offers no better primitive. Low impact, acceptable.

## Proposed Changes

### `package.json`
- **Context**: Add one config property, one command, and two menu contributions.
- **Logic**: Config property goes in `contributes.configuration.properties`. Command goes in `contributes.commands`. Menu items go in `contributes.menus.explorer/context` and `contributes.menus.editor/context`.
- **Implementation**: Insert JSON blocks as shown in Architecture sections 1 and 2 above.
- **Edge Cases**: The `when` clause uses the config key name directly — VS Code evaluates it as a context key. The config property name matches the context key convention.

### `src/extension.ts`
- **Context**: Add one module-level flag and two subscriptions inside `activate()`.
- **Logic**: `onDidOpenTextDocument` fires → check flag → check config → close editor. `forceOpenFile` command → set flag → open file.
- **Implementation**: Insert TypeScript blocks as shown in Architecture section 3 above.
- **Edge Cases**: Untitled/temporary files (scheme != 'file') will also be closed. This is intentional per the requirement "all files opened are auto closed". If this is undesirable, add a `document.uri.scheme === 'file'` guard.

## Verification Plan
### Manual Tests
1. **Default OFF**: Open any file → stays open. Right-click menu does not show "Override Open".
2. **Toggle ON**: Enable setting → open any file → immediately closes. Right-click menu shows "Override Open".
3. **Override Open**: Setting ON → right-click a file → "Override Open" → file opens and stays open.
4. **Toggle OFF again**: Disable setting → open any file → stays open normally.

## Recommendation
**Send to Coder.**

---

## Reviewer Findings & Execution

### Stage 1: Grumpy Principal Engineer Review
**CRITICAL**: `workspace.onDidOpenTextDocument` fires for background file reads (hovers, go to definition, git lens, etc.). You hooked into this and blindly call `workbench.action.closeActiveEditor`! This means ANY time an extension reads a file in the background, you nuke the user's currently focused, active editor tab! Catastrophic UX failure.
**MAJOR**: `skipNextClose` flag is a module-level boolean. A classic race condition. If two documents open at once, you clear the flag on the first one (which might be a background read), and then close the actual document you wanted to override!
**MAJOR**: `workbench.action.closeActiveEditor` closes whatever is focused. If the agent opens a file in a split group or background, you still just kill the active focus. 
**NIT**: `forceOpenFile` command passes the URI to `vscode.open`. If `preventAgentFileOpening` is off, `skipNextClose` is still set to true, leaking state to the next random file open.

### Stage 2: Balanced Synthesis & Action Plan
**What to keep**: 
- The config property `switchboard.preventAgentFileOpening` and context menu contributions in `package.json` are correct.
- The concept of intercepting document openings is correct, but the event used is wrong.

**What to fix now**:
- **Event Target**: Switch from `workspace.onDidOpenTextDocument` to `window.tabGroups.onDidChangeTabs`. This strictly monitors actual UI tabs opening, not memory document reads.
- **Close Target**: Use `window.tabGroups.close(tab)` to close the specific tab that opened, instead of blindly firing `closeActiveEditor` which kills the user's focus.
- **Race Condition**: Replace the boolean `skipNextClose` with a `Set<string>` of allowed URIs (e.g. `allowedURIsToOpen = new Set<string>()`). The `forceOpenFile` command should add the URI to this set, and the tab listener should check/delete it. This completely eliminates the race condition and state leakage.

**What can be deferred**:
- Nothing. The current implementation is dangerous and must be rewritten completely to avoid randomly closing user tabs.

### Validation Results
- **Files Modified**: `src/extension.ts`
- **Validation**: Compiled successfully with `npx tsc --noEmit` (no errors in `src/extension.ts`).
- **Remaining Risks**: VS Code `tabGroups` API was introduced in 1.68, which is well within our `^1.90.0` engine requirement. No remaining architectural risks.
