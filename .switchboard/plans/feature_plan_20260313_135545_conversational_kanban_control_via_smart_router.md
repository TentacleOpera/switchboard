Here is the complete, updated implementation plan incorporating the "Smart Router" approach. This ensures the AI agent can use conversational instructions (referencing either columns or roles) while preserving the backend's dynamic complexity routing.

***

# Conversational Kanban Control via Smart Router

## Goal
Enable AI agents to advance Kanban cards or dispatch tasks to specific agents conversationally using a new, flexible `move_kanban_card` MCP tool. A backend "Smart Router" will normalize the agent's input (handling both UI column names and agent roles) and automatically apply complexity routing before dispatching, avoiding the need to expose strict, brittle UI abstractions to the LLM.

## User Review Required
> [!NOTE] 
> This shifts the primary orchestration paradigm from manual `send_message` (legacy) to automated Kanban advancement. 
> [!WARNING] 
> Agents might still try to use `send_message` out of habit if workflow files are not explicitly updated. We are updating `AGENTS.md` as part of this plan to establish the new convention.

## Complexity Audit
### Band A — Routine
* Exposing the IPC listener in `src/extension.ts` to catch `triggerKanbanMove` events from the MCP server.
* Registering the new command `switchboard.mcpMoveKanbanCard` in the extension registry.
* Updating `AGENTS.md` to instruct agents on the new conversational tool.

### Band B — Complex / Risky
* Implementing `move_kanban_card` in `src/mcp-server/register-tools.js` and securely bridging the process gap.
* Implementing the "Smart Router" normalization layer in `src/services/KanbanProvider.ts` (`handleMcpMove`) that mimics the complexity-aware routing of the auto-move timers to ensure "Low" vs "High" plans still route to the correct Coder/Lead agent.

## Edge-Case Audit
* **Race Conditions:** An agent might call `move_kanban_card` and immediately complete its workflow before the extension finishes dispatching the target agent. The IPC bridge is asynchronous, so we will immediately return a success receipt to the agent while the extension finishes file reads and dispatching in the background.
* **Security:** `target` input could be an arbitrary string. The backend will fall back to safe, assigned roles using `_canAssignRole`, preventing injection of unsupported commands.
* **Side Effects:** Fuzzy matching for roles ("planner column" vs "planner") needs to reliably resolve to the correct core role string without failing silently.

## Adversarial Synthesis
### Grumpy Critique
You're expecting the LLM to understand and use a brand new MCP tool `move_kanban_card` instead of its hardcoded `send_message` tool just by putting a note in `AGENTS.md`?! LLMs are incredibly stubborn about their default tools. It's going to keep using `send_message` and bypassing the Kanban board entirely! Furthermore, returning a success message to the LLM immediately before the background routing finishes means if the routing fails, the LLM will never know and will think the task is done!

### Balanced Response
Grumpy's skepticism about LLM tool adoption is a known challenge. Updating `AGENTS.md` is the necessary first step, but we may also need to update the core system prompts (the agent personas) if they continue to default to `send_message`. Regarding the async disconnect, returning immediate success is required because VS Code command execution can take several seconds. If the routing fails (e.g., an invalid target), we surface a `vscode.window.showErrorMessage` to the human user. The human remains the ultimate overseer of the board state and can correct course if the agent hallucinates a valid tool call that fails in the background.

## Proposed Changes

### 1. The MCP Tool Definition
#### [MODIFY] `src/mcp-server/register-tools.js`
- **Context:** The MCP Server needs a tool to safely tell the VS Code Extension to move a Kanban card.
- **Logic:** Add a `move_kanban_card` tool that accepts `sessionId` and a flexible `target` string. Use `process.send` to trigger an IPC message to the parent extension process.

### 2. The IPC Bridge & Command Registry
#### [MODIFY] `src/extension.ts`
- **Context:** The extension host must listen to the MCP child process and execute the corresponding VS Code command when the tool is fired.
- **Logic:** Add a `case 'triggerKanbanMove'` block inside the `mcpServerProcess.on('message', ...)` listener. Register the new `switchboard.mcpMoveKanbanCard` command in the `activate` function so it can route to the `KanbanProvider`.

### 3. The Backend "Smart Router"
#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** The `KanbanProvider` receives the command but must dynamically resolve the target based on fuzzy matching and complexity.
- **Logic:** Expose `handleMcpMove(sessionId, target)`. Normalize the string. Map Kanban column names to explicit roles. If the destination resolves to `coded` or `team`, dynamically check the plan's complexity via `_getComplexityFromPlan` to override the role to `coder` (Low) or `lead` (High). Validate the assigned role and call `switchboard.triggerAgentFromKanban`.

### 4. Agent Protocol Documentation
#### [MODIFY] `AGENTS.md`
- **Context:** Agents need to know this tool exists and how to use it.
- **Logic:** Update the `Switchboard Global Architecture` section to introduce conversational routing.

## Verification Plan
### Automated Tests
- Run `npm run compile` to verify all TypeScript interfaces compile cleanly.
- Run `node src/test/workflow-contract-consistency.test.js` to ensure the tool registry hasn't broken schema loading.

### Manual Testing
1. Open the Switchboard side panel and initialize terminals.
2. Chat with an agent via the MCP connected interface.
3. Test Column Target: *"Please move plan 'sess_123' to the Coded column."* Verify the complexity routing correctly identifies Low/High and triggers the Coder or Lead Coder.
4. Test Role Target: *"Please send plan 'sess_123' to the Planner."* Verify it bypasses complexity routing and goes directly to the Planner terminal.
5. Test Fuzzy Target: *"Move it to the planner column."* Verify the system successfully strips " column", normalizes to "planner", and executes.

## Appendix: Implementation Patch

```diff
--- src/mcp-server/register-tools.js
+++ src/mcp-server/register-tools.js
@@ -... +... @@
         }
     );
 
+    // Tool: move_kanban_card
+    server.tool(
+        "move_kanban_card",
+        {
+            sessionId: z.string().describe("The session ID of the plan to move (e.g., 'sess_12345' or 'antigravity_abc123')"),
+            target: z.string().describe("The destination. Can be a Kanban column (e.g., 'PLAN REVIEWED', 'CODED') OR an agent role (e.g., 'planner', 'coder', 'lead', 'team').")
+        },
+        async ({ sessionId, target }) => {
+            if (process.send) {
+                process.send({ type: 'triggerKanbanMove', sessionId, target });
+                return { 
+                    content: [{ 
+                        type: "text", 
+                        text: `✅ Plan ${sessionId} routed to '${target}'. The system will dynamically construct the prompt and advance the board.` 
+                    }] 
+                };
+            }
+            return { isError: true, content: [{ type: "text", text: "IPC not available. Cannot communicate with Switchboard host." }] };
+        }
+    );
+
     // Tool: set_agent_status (unified — replaces set_terminal_status + update_chat_agent_status)
     server.tool(

--- src/extension.ts
+++ src/extension.ts
@@ -... +... @@
                         vscode.commands.executeCommand('switchboard.focusTerminalByName', message.terminalName);
                     }
                     break;
                 }
+                case 'triggerKanbanMove': {
+                    vscode.commands.executeCommand('switchboard.mcpMoveKanbanCard', message.sessionId, message.target);
+                    break;
+                }
                 case 'getMcpResource': {
                     const { uri, id } = message;
@@ -... +... @@
     context.subscriptions.push(viewPlanFromKanbanDisposable);
 
+    const mcpMoveKanbanCardDisposable = vscode.commands.registerCommand('switchboard.mcpMoveKanbanCard', async (sessionId: string, target: string) => {
+        await kanbanProvider.handleMcpMove(sessionId, target);
+    });
+    context.subscriptions.push(mcpMoveKanbanCardDisposable);
+
     let degradedMcpStreak = 0;

--- src/services/KanbanProvider.ts
+++ src/services/KanbanProvider.ts
@@ -... +... @@
     public async refresh() {
         if (this._panel) {
             await this._refreshBoard();
         }
     }
 
+    /** Called by the MCP server to programmatically route a plan and trigger the appropriate agent */
+    public async handleMcpMove(sessionId: string, target: string) {
+        const workspaceFolders = vscode.workspace.workspaceFolders;
+        if (!workspaceFolders) return;
+        const workspaceRoot = workspaceFolders.uri.fsPath;
+
+        // 1. Normalize fuzzy inputs (e.g., "planner column" -> "planner")
+        let normalized = target.toLowerCase().replace(' column', '').trim();
+        let targetRole = normalized;
+
+        // 2. Map formal Kanban UI columns to roles
+        if (normalized === 'plan reviewed') targetRole = 'planner';
+        if (normalized === 'code reviewed') targetRole = 'reviewer';
+        if (normalized === 'created' || normalized === 'plan created') targetRole = 'planner';
+
+        // 3. Dynamic Complexity Routing
+        // Triggered if they ask for the 'CODED' column OR generic 'team' delegation
+        if (normalized === 'coded' || targetRole === 'team') {
+            const log = this._getSessionLog(workspaceRoot);
+            const sheet = await log.getRunSheet(sessionId);
+            if (sheet && sheet.planFile) {
+                const complexity = await this._getComplexityFromPlan(workspaceRoot, sheet.planFile);
+                targetRole = complexity === 'Low' ? 'coder' : 'lead';
+            } else {
+                targetRole = 'lead'; // Fallback
+            }
+        }
+
+        // 4. Validate and Dispatch
+        if (!(await this._canAssignRole(workspaceRoot, targetRole))) {
+            vscode.window.showErrorMessage(`Agent for target '${target}' is not assigned or available.`);
+            return;
+        }
+
+        const instruction = targetRole === 'planner' ? 'enhance' : undefined;
+        await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', targetRole, sessionId, instruction);
+    }
+
     private _getSessionLog(workspaceRoot: string): SessionActionLog {

--- AGENTS.md
+++ AGENTS.md
@@ -... +... @@
 | `delegate_task` | `handoff` |
 | `submit_result` | *(no restriction — this is a response)* |
 | `status_update` | *(no restriction — informational)* |
 
 Sending to non-existent recipients is always rejected (even when auto-routed).
 
 ### 🏗️ Switchboard Global Architecture
 ```
 User ──► Switchboard Operator (chat.md)
 │  Plans captured in .switchboard/plans/features/
 │
 ├──► /challenge      Internal adversarial review (grumpy + synthesis)
 ├──► /handoff-lead   One-shot Lead Coder execution (large features)
 ├──► /handoff --all  Bulk terminal delegation (small features)
+
+Alternatively, for conversational progression, use `move_kanban_card(sessionId, target)` to automatically formulate prompts and route plans to columns (e.g. 'CODED') or roles (e.g. 'planner', 'team').
 
 All file writes to .switchboard/ MUST use IsArtifact: false.
 All inter-agent completion signals use the yield pattern (NO POLLING).
```