# Bug: ClickUp Setup Button Throws API Key Error Instead of Prompting for Token

## Goal
Fix the ClickUp setup button in the Kanban board to prompt the user for their API token when clicked, instead of throwing an error that the token is not configured.

## Metadata
**Tags:** backend, ui, bugfix
**Complexity:** 3

## User Review Required
> [!NOTE]
> - No product scope changes: this is a bugfix, not a new ClickUp feature.
> - The shared `setup()` path is already used by both the webview button and the command palette entry.
> - Token input must remain password-masked and stored only in `context.secrets`.

## Background
When a user clicks the "☁️ Setup ClickUp" button in the Kanban board header, the button calls `ClickUpSyncService.setup()`. However, the `setup()` method immediately checks if an API token exists in VS Code SecretStorage. If no token is found, it returns an error:

```
"ClickUp API token not configured. Run 'Switchboard: Set ClickUp API Token' first."
```

This creates a broken user experience:
- The setup button is supposed to guide users through the entire setup flow
- Instead, it requires users to first run a separate command (`switchboard.setClickUpToken`) via the command palette
- This contradicts the intended flow documented in `make_integration_setup_buttons_discoverable.md`

## Root Cause Analysis

### Current Flow (Broken)
1. User opens Kanban board → sees "☁️ Setup ClickUp" button
2. User clicks button → `setupClickUp` message sent to `KanbanProvider`
3. `KanbanProvider` calls `ClickUpSyncService.setup()`
4. `setup()` calls `getApiToken()` which checks SecretStorage for `'switchboard.clickup.apiToken'`
5. Token is null → `setup()` returns error: "ClickUp API token not configured. Run 'Switchboard: Set ClickUp API Token' first."
6. User sees error message and must manually run command palette command

### Expected Flow (Per Design)
1. User opens Kanban board → sees "☁️ Setup ClickUp" button
2. User clicks button → prompted for token via input box
3. Setup completes automatically
4. UI state switches to "✅ ClickUp Synced"

## Complexity Audit
### Routine
- Add a missing-token prompt to the shared ClickUp setup flow in `src/services/ClickUpSyncService.ts`.
- Reuse the existing `vscode.window.showInputBox()` validation pattern already used by `switchboard.setClickUpToken` in `src/extension.ts`.
- Store the trimmed token in `context.secrets` and continue the existing setup flow without changing ClickUp resource creation logic.

### Complex / Risky
- None. The current setup path already owns UI prompts (`showQuickPick`), so adding one more prompt does not cross a new architectural boundary.

## Edge-Case & Dependency Audit
- **Race Conditions:** `setupInProgress` already blocks re-entry; the new prompt must still exit through the existing `finally` path so the flag always clears after cancel/failure.
- **Security:** The token must remain password-masked, trimmed before storage, never logged, and written only to `switchboard.clickup.apiToken`.
- **Side Effects:** No ClickUp workspace/folder/list changes should happen until the token prompt succeeds; canceling the prompt must leave config and remote resources untouched.
- **Dependencies & Conflicts:** `clickup_2_setup_flow.md` and `make_integration_setup_buttons_discoverable.md` also touch ClickUp setup behavior; this bugfix must preserve the shared token-prompt logic and not reintroduce the pre-prompt API-key error. `linear_2_setup_flow.md` also edits nearby Kanban/UI code, but it targets a separate integration.

### Code Location of Bug
**File:** `src/services/ClickUpSyncService.ts`
**Lines:** 209-212

```typescript
const token = await this.getApiToken();
if (!token) {
  return { success: false, error: 'ClickUp API token not configured. Run "Switchboard: Set ClickUp API Token" first.' };
}
```

The `setup()` method should prompt for the token if it doesn't exist, similar to how the `switchboard.setClickUpToken` command works in `extension.ts` (lines 1319-1337). Clarification: this prompt belongs in the shared `ClickUpSyncService.setup()` path because both `switchboard.setupClickUp` entry points already call that method.

## Proposed Fix

### Option 1: Add Token Prompt to `setup()` Method
Modify `ClickUpSyncService.setup()` to prompt for the API token via `vscode.window.showInputBox()` if the token is not already set, then store it in SecretStorage before proceeding with the setup flow. This is the preferred fix because it covers both the webview button and the command palette command without duplicating token logic.

**Pros:**
- Self-contained fix within the service
- Matches the Linear integration pattern (if it has the same issue)
- Single click experience for users

**Cons:**
- Requires passing `vscode` namespace or context to the service class
- Service layer would need UI dependencies (mixing concerns)

### Option 2: Handle Token Prompt in KanbanProvider
Modify the `setupClickUp` message handler in `KanbanProvider.ts` to check for the token first, prompt if missing, then call `setup()`.

**Pros:**
- Keeps UI logic in the provider layer
- Service remains pure (no UI dependencies)
- Easier to test

**Cons:**
- Duplicates token checking logic between provider and service

### Option 3: Separate Setup into Two Phases
1. "Set Token" phase: Prompt and store token
2. "Configure" phase: Run the actual ClickUp workspace/folder/list setup

**Pros:**
- Clearer separation of concerns
- Allows retry without re-entering token

**Cons:**
- More complex flow
- Requires additional UI state management

## Recommended Approach
**Option 1** is recommended because:
- `ClickUpSyncService.setup()` is already the shared path used by both `switchboard.setupClickUp` entry points.
- The service already uses VS Code UI prompts (`showQuickPick`) during setup, so prompting for a missing token does not introduce a new dependency boundary.
- One shared prompt avoids duplicating validation and storage logic in both `KanbanProvider.ts` and `extension.ts`.
- The command palette behavior becomes consistent with the webview button instead of remaining a separate failure mode.

## Implementation Steps (Legacy Sketch)

> [!NOTE]
> The items below are retained for context from the original plan draft. The authoritative implementation path is the clarified service-level flow in the section that follows.

### Step 1: Add Token Check to KanbanProvider Handler
**File:** `src/services/KanbanProvider.ts`
**Location:** Lines 2097-2113 (case 'setupClickUp')

Clarification: the final fix should be implemented in `ClickUpSyncService.setup()`, not by duplicating prompt logic here. Keep this handler as a thin caller that invokes the shared setup method after the service handles any missing-token prompt.

```typescript
case 'setupClickUp': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot) { break; }
    const syncService = this._getClickUpService(workspaceRoot);
    
    // Check if token exists, prompt if missing
    const token = await syncService.getApiToken();
    if (!token) {
        const inputToken = await vscode.window.showInputBox({
            password: true,
            prompt: 'Enter your ClickUp API token',
            placeHolder: 'pk_...'
        });
        if (!inputToken) {
            // User cancelled
            this._panel?.webview.postMessage({
                type: 'clickupState', setupComplete: false
            });
            break;
        }
        // Store the token
        await this._context.secrets.store('switchboard.clickup.apiToken', inputToken);
    }
    
    const result = await syncService.setup();
    if (result.success) {
        vscode.window.showInformationMessage('ClickUp integration setup complete!');
        this._panel?.webview.postMessage({
            type: 'clickupState', setupComplete: true
        });
    } else {
        vscode.window.showErrorMessage(`ClickUp setup failed: ${result.error}`);
        this._panel?.webview.postMessage({
            type: 'clickupState', setupComplete: false
        });
    }
    break;
}
```

### Step 2: Add Context to KanbanProvider Constructor
Clarification: no constructor change is required. `KanbanProvider` already has `this._context` and constructs `ClickUpSyncService` with `this._context.secrets`, so the shared prompt can use the existing secret storage path.

### Step 3: Apply Same Fix to Linear Integration
Check if the Linear setup button has the same issue and apply the same pattern if needed. Clarification: this is conflict-detection only; do not pull Linear requirements into this ClickUp bugfix.

## Grumpy Critique
> "The setup button is not 'failing elegantly'—it's just shoving the user into a dead-end because the shared setup path assumes the token already exists. We already ask the user to pick a space with `showQuickPick`, so the claim that one password-masked token prompt would contaminate the service layer is pure ceremony. Read the secret, prompt if missing, store it once, and stop making the same bug live in both the webview and the command palette."

## Balanced Synthesis
> Put the missing-token prompt in `src/services/ClickUpSyncService.ts` inside `setup()`, because that method is already the shared setup path used by both ClickUp entry points. Use the same validation rules as `switchboard.setClickUpToken`, persist the trimmed token in `context.secrets`, and then continue the existing setup flow unchanged.

## Agent Recommendation
Send to Coder

## Clarified Implementation Steps (Final)

### Low Complexity
#### MODIFY `src/services/ClickUpSyncService.ts`
- **Context:** `setup()` is the shared entry point for ClickUp setup, and it already performs UI work (`showQuickPick` for space selection). The missing-token error originates here, so this is the correct place to prompt.
- **Logic:** When `getApiToken()` returns `null`, open a password-masked `showInputBox()` with the same validation expectations as `switchboard.setClickUpToken`. If the user submits a token, trim it, store it in `this._secretStorage`, and continue with the existing workspace/space/folder setup path. If the user cancels, return a failure result and stop before any ClickUp API call.
- **Implementation:** Keep the current `setupInProgress` guard and `finally` reset intact. Do not change the workspace lookup, space selection, folder creation, or config persistence logic beyond the new token bootstrap branch.
- **Edge Cases Handled:** A missing token now triggers the setup prompt instead of the old API-key error; canceled prompts exit cleanly; the token remains secret-stored and reusable for later runs.

### High Complexity / Risky
- None.

## Verification Plan
1. Clear any existing ClickUp token from SecretStorage
2. Open Kanban board
3. Click "☁️ Setup ClickUp" button
4. Verify token input prompt appears
5. Enter valid ClickUp API token
6. Verify setup completes successfully
7. Verify button changes to "✅ ClickUp Synced"

## Related Issues
- Potential overlap with Linear setup behavior is noted for awareness only; do not expand scope in this plan.
- The `make_integration_setup_buttons_discoverable.md` plan assumed this flow would work, but the actual implementation never added the token prompt logic

## Reviewer Execution Update

### Stage 1 (Grumpy Principal Engineer)
> **NIT** At last, the setup button behaves like a setup button instead of a smug error dispenser. The missing-token bootstrap now lives in the shared service path, which is exactly where it belonged. The only remaining imperfection is structural duplication: the token prompt validation now exists in both `extension.ts` and `ClickUpSyncService.ts`, so a future token-format tweak could update one prompt and forget the other.

### Stage 2 (Balanced)
Keep the implementation. No CRITICAL or MAJOR defect was found, so no production code change was required during this reviewer pass. The service-level prompt fixes both entry points, keeps the token password-masked, trims it before storing, writes only to secret storage, and exits cleanly on cancel before any API work begins.

### Fixed Items
- No reviewer-applied production code fixes were needed.

### Files Changed
- Observed implementation files:
  - `src/services/ClickUpSyncService.ts`
  - `src/test/clickup-setup-token-prompt-regression.test.js`
- Reference parity file (unchanged but validated): `src/extension.ts`
- Reviewer update: `.switchboard/plans/clickup_setup_button_api_key_bug.md`

### Validation Results
- `node src/test/clickup-setup-token-prompt-regression.test.js` → passed
- `npm run compile` → passed
- `npx tsc --noEmit` → pre-existing TS2835 at `src/services/KanbanProvider.ts:2197` for `await import('./ArchiveManager')`

### Remaining Risks
- Token prompt validation is duplicated between `extension.ts` and `ClickUpSyncService.ts`; future prompt changes should keep them aligned or extract a shared helper.
- Full end-to-end setup still depends on manual/live ClickUp credentials and was not exercised in this source-level regression pass.
