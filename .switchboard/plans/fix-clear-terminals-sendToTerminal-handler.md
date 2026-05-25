# Fix Clear Terminals Button - Missing sendToTerminal Handler

## Goal
Add a `sendToTerminal` message handler to TaskViewerProvider.ts so the clear terminals button can send `/clear` commands to terminals without depending on the deprecated MCP server.

## Metadata
- **Tags:** [bugfix, UI, infrastructure]
- **Complexity:** 3

## Problem
Two message types sent from implementation.html are missing handlers in TaskViewerProvider.ts:

1. **`sendToTerminal`** - The "CLEAR TERMINALS" button sends this message to send `/clear` commands to terminals
2. **`getDesignDocSetting`** - The Terminals tab sends this message to fetch design doc configuration

Both handlers exist in the deprecated MCP server process (extension.ts), but webview messages go to TaskViewerProvider, not the MCP server. This causes these features to fail silently.

## Root Cause
1. The clear terminals button click handler (implementation.html line 2075) sends messages with type `sendToTerminal` to the webview
2. Webview messages are handled by TaskViewerProvider.ts at line 7025 (`webviewView.webview.onDidReceiveMessage`)
3. TaskViewerProvider.ts has NO case handler for `sendToTerminal` (verified by grep search)
4. The `sendToTerminal` case handler exists in extension.ts line 807, but that's in the MCP server IPC bridge (`process.on('message')`), not the webview message handler
5. Since the MCP server is being deprecated, this dependency should be removed

## User Review Required
No — this is a deprecation migration fix with no product/UX implications.

## Complexity Audit

### Routine
- Single case handler addition to existing switch statement (line 7027)
- Reuses existing terminal resolution pattern from `_attemptDirectTerminalPush` (lines 14030-14045)
- Reuses existing `sendRobustText` utility (imported at line 12 from `./terminalUtils`)
- `getDesignDocSetting` handler calls existing method `handleGetDesignDocSetting()` (line 2968) and posts response to webview
- No new dependencies or state changes

### Complex / Risky
- Terminal resolution logic must be replicated inline rather than delegated to `_attemptDirectTerminalPush`, because that method has `clearBeforePrompt` side effects (lines 14062-14079) that would cause a double-clear when input is `/clear`
- None beyond the above clarification

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Terminal resolution is synchronous; `sendRobustText` is awaited per terminal. The implementation.html `forEach` loop (line 2075) fires all messages synchronously but each is handled sequentially by the webview message handler.
- **Security:** No impact. This is an internal UI-to-extension bridge. The webview is a trusted context; source validation from the MCP IPC bridge (extension.ts lines 820-830) is unnecessary here.
- **Side Effects:** None. Direct terminal send without MCP server fan-out checks (which are irrelevant for clear terminals — each message targets one specific terminal).
- **Dependencies & Conflicts:** Depends on `sendRobustText` (imported at line 12), `_registeredTerminals` (line 291), `_suffixedName` (line 1001), `_normalizeAgentKey` (line 993), `_stripIdeSuffix` (line 1006). All are existing private methods on `this`. No new imports needed.

## Dependencies
None.

## Adversarial Synthesis
Key risks: using `_attemptDirectTerminalPush` would cause double-clear when input is `/clear` and `clearBeforePrompt` is enabled, plus it logs misleading MCP dispatch events. Mitigations: replicate terminal resolution logic inline and call `sendRobustText` directly, matching the extension.ts handler behavior exactly.

## Proposed Changes

### TaskViewerProvider.ts (`src/services/TaskViewerProvider.ts`)

**Context:** The `webviewView.webview.onDidReceiveMessage` switch statement (line 7027) handles all webview messages. Two cases are missing: `sendToTerminal` and `getDesignDocSetting`. Add them after the existing cases (e.g., after the `resetDatabase` case at line 8211, before the switch closing).

**Logic:**
- `sendToTerminal`: Resolve terminal by name using the same 4-step lookup as `_attemptDirectTerminalPush` (exact match → suffix-aware → case-insensitive → VS Code fallback), then call `sendRobustText` directly. Do NOT use `_attemptDirectTerminalPush` because it has `clearBeforePrompt` side effects that would double-clear when input is `/clear`.
- `getDesignDocSetting`: Call existing `handleGetDesignDocSetting()` and post response back to webview as `{ type: 'designDocSetting', ...setting }`.

**Implementation:**
```typescript
case 'sendToTerminal': {
    const { name, input, paced } = data;
    if (typeof name !== 'string' || !name.trim()) {
        console.error('[TaskViewer] sendToTerminal rejected: invalid terminal name');
        break;
    }
    if (typeof input !== 'string') {
        console.error('[TaskViewer] sendToTerminal rejected: invalid input');
        break;
    }

    // Resolve terminal: registered terminals first (exact → suffix-aware → case-insensitive),
    // then fall back to open VS Code terminals.
    // NOTE: Do NOT use _attemptDirectTerminalPush here — it has clearBeforePrompt
    // side effects that would double-clear when input is '/clear'.
    let terminal: vscode.Terminal | undefined;
    if (this._registeredTerminals) {
        terminal = this._registeredTerminals.get(name);
        if (!terminal) {
            terminal = this._registeredTerminals.get(this._suffixedName(name));
        }
        if (!terminal) {
            const normalized = this._normalizeAgentKey(this._stripIdeSuffix(name));
            for (const [n, t] of this._registeredTerminals.entries()) {
                if (this._normalizeAgentKey(this._stripIdeSuffix(n)) === normalized) {
                    terminal = t;
                    break;
                }
            }
        }
    }
    if (!terminal) {
        const openTerminals = vscode.window.terminals || [];
        const strippedTarget = this._normalizeAgentKey(this._stripIdeSuffix(name));
        terminal = openTerminals.find(t => {
            const tName = this._normalizeAgentKey(t.name);
            return tName === strippedTarget;
        });
    }

    if (!terminal) {
        console.error(`[TaskViewer] sendToTerminal failed: terminal '${name}' not found or not local`);
        break;
    }

    await sendRobustText(terminal, input, paced);
    console.log(`[TaskViewer] sendToTerminal: sent to '${name}' (paced: ${paced}, len: ${input.length})`);
    break;
}
case 'getDesignDocSetting': {
    const setting = this.handleGetDesignDocSetting();
    this._view?.webview.postMessage({ type: 'designDocSetting', ...setting });
    break;
}
```

**Edge Cases:**
- Terminal not found: logged to console, no error response needed (UI shows "CLEARING..." for 1 second then resets via `updateTerminalButtonState()`)
- Terminal not local: VS Code fallback also fails, logged to console
- Empty/invalid name or input: rejected by type guard before terminal resolution
- `_registeredTerminals` is undefined: skipped, falls through to VS Code terminal list
- Design doc setting: `handleGetDesignDocSetting()` always returns valid `{ enabled: boolean; link: string }`, no edge cases

**Design Decision — Why not `_attemptDirectTerminalPush`:**
The `_attemptDirectTerminalPush` method (lines 14021-14099) has two side effects that are inappropriate for the `sendToTerminal` handler:
1. **`clearBeforePrompt` logic** (lines 14062-14079): When the user config `terminal.clearBeforePrompt` is enabled, it pastes `/clear` via clipboard before sending the payload. If the payload itself is `/clear`, this causes a double-clear and the second `sendRobustText('/clear')` triggers slash-command concatenation in CLI agents.
2. **Dispatch event logging** (lines 14043-14051): Logs a `_logEvent('dispatch', ...)` entry, which is MCP-server-specific observability that would be misleading for direct webview-to-terminal sends.

The inline resolution logic replicates the same 4-step terminal lookup without these side effects, matching the extension.ts handler behavior exactly.

## Verification Plan

### Automated Tests
No automated tests exist for webview UI. Manual verification required.

### Manual Verification Steps
1. Open implementation.html in the webview
2. Navigate to the Terminals tab
3. Open agent terminals (ensure they have roles assigned)
4. Click the "CLEAR TERMINALS" button
5. Verify that `/clear` commands are sent to all agent terminals (terminals should clear)
6. Verify that after 1 second, the button re-enables and shows correct state
7. Check VS Code Output channel for "[TaskViewer] sendToTerminal" logs to confirm handler executed
8. Switch to the Terminals tab and verify the design doc URL input populates correctly (confirms `getDesignDocSetting` handler works)

## Recommendation
Complexity 3 → **Send to Intern**

---

## Review Results (Grumpy Principal Engineer Pass)

### Stage 1: Adversarial Findings

| # | Finding | Severity | Details |
|---|---------|----------|---------|
| 1 | `paced` parameter not type-validated | NIT | `name` and `input` get `typeof` guards but `paced` does not. Safe in practice because `sendRobustText` defaults to `paced=true` for undefined, and HTML always sends `paced: false` (boolean). |
| 2 | `source` field silently ignored without comment | NIT | HTML sends `source: { actor, tool, allowBroadcast }` but handler only destructures `{ name, input, paced }`. No comment explains why. Plan says "source validation unnecessary" — correct, but future readers may be confused. |
| 3 | `/clear` via `sendText` vs clipboard paste | NIT | `_attemptDirectTerminalPush` uses `pasteTextViaClipboard` for `/clear` to avoid CLI slash-command concatenation. `sendRobustText` uses `terminal.sendText` for short inputs. However, concatenation risk only applies when `/clear` is followed by a subsequent prompt — which doesn't happen here. `/clear` is the sole payload. Safe. |
| 4 | Spread overwrite risk on `type` field | NIT | `postMessage({ type: 'designDocSetting', ...setting })` — if `setting` ever contained a `type` key, it would overwrite. Currently safe because return type is explicitly `{ enabled: boolean; link: string }`. |

**No CRITICAL or MAJOR findings.**

### Stage 2: Balanced Synthesis

| Finding | Action | Rationale |
|---------|--------|-----------|
| `paced` not validated | Keep | `sendRobustText` has safe default; HTML always sends boolean |
| `source` silently ignored | **Fix applied** | Added comment explaining intentional omission |
| `/clear` via sendText | Keep | No concatenation risk for standalone clear command |
| Spread overwrite risk | Keep | Return type contract prevents this; TypeScript would catch changes |

### Code Fixes Applied

**File:** `src/services/TaskViewerProvider.ts` (line 8277)
- Added comment block explaining that the `source` field from the webview is intentionally not destructured, since source validation is unnecessary in the trusted webview context.

### Verification

- **TypeScript check:** `npx tsc --noEmit` — 2 pre-existing errors in unrelated files (ClickUpSyncService.ts, KanbanProvider.ts). No new errors introduced by this implementation.
- **No compilation run** (per session skip-compilation directive).
- **No test run** (per session skip-tests directive).

### Implementation Verification Summary

| Requirement | Status | Notes |
|-------------|--------|-------|
| `sendToTerminal` case handler added | PASS | Lines 8277-8328, matches plan spec exactly |
| `getDesignDocSetting` case handler added | PASS | Lines 8330-8333, calls existing method and posts response |
| Terminal resolution: 4-step lookup | PASS | Exact → suffix-aware → case-insensitive → VS Code fallback, matches `_attemptDirectTerminalPush` |
| `clearBeforePrompt` side effect avoided | PASS | Inline resolution, no `_attemptDirectTerminalPush` call |
| `_logEvent` side effect avoided | PASS | No dispatch event logging |
| `sendRobustText` called directly | PASS | With `paced` parameter forwarded |
| Type guards on `name` and `input` | PASS | `typeof` checks with early break |
| `handleGetDesignDocSetting` return spread | PASS | Produces `{ type: 'designDocSetting', enabled, link }` matching HTML handler expectations |
| No new imports needed | PASS | All dependencies pre-existing |
| Comment about ignored `source` field | PASS | Added during review |

### Remaining Risks

- **Low:** If `handleGetDesignDocSetting()` return type is extended to include a `type` field in the future, the spread pattern at line 8332 would silently overwrite the explicit `type: 'designDocSetting'`. Mitigated by TypeScript return type contract.
- **Low:** `/clear` sent via `sendText` (not clipboard paste) to CLI agents. Currently safe because `/clear` is the sole payload with no subsequent prompt. If future use cases send non-clear commands to CLI agents via this handler, consider adding clipboard paste for slash commands.
