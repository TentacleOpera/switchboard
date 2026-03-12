# Native MCP Tool for Kanban State Resolution

## Goal
Port the existing `kanban-list.js` logic into a native MCP tool (`get_kanban_state`) inside the bundled Switchboard server. This will allow AI agents to instantly resolve the Kanban board state natively without having to spawn an external Node.js shell process, reducing overhead and improving reliability.

## User Review Required
> [!NOTE]
> This plan deprecates the use of the `node .agent/scripts/kanban-list.js` script in favor of the new MCP tool. We will update `AGENTS.md` and the `SKILL.md` file so agents immediately switch to the new method.

## Complexity Audit
### Band A — Routine
- Adding the `get_kanban_state` tool definition to `src/mcp-server/register-tools.js`.
- Updating the prompt instructions in `AGENTS.md` and `.agent/skills/get_kanban_state/SKILL.md` to instruct agents to use the MCP tool rather than the script.
### Band B — Complex / Risky
- Migrating the Kanban path-hashing and derivation logic from `kanban-list.js` into the MCP server safely, ensuring `fs` and `path` resolutions correctly target the active `workspaceRoot`.

## Edge-Case Audit
- **Race Conditions:** Reading `plan_registry.json` and session runsheets while they are being written by the extension could result in partial JSON reads. The script's existing `try/catch` wrappers around `JSON.parse` will handle this safely by dropping the malformed file for that specific tick.
- **Security:** We must resolve the workspace path using the MCP server's built-in `getWorkspaceRoot()` rather than `process.cwd()` to ensure correct path boundaries.
- **Side Effects:** Agents relying strictly on the old command-line skill might fail if the skill isn't updated concurrently. We will update the skill definitions alongside the code to prevent drift.

## Adversarial Synthesis
### Grumpy Critique
You are copying 60 lines of complex file-parsing logic from `kanban-list.js` straight into `register-tools.js`! That file is already nearly 3,000 lines long! Why isn't this logic centralized in `state-manager.js` or somewhere else? Also, if you don't update `AGENTS.md`, the agents will still blindly try to run the `.agent/scripts/` file.

### Balanced Response
Grumpy has a fair point about file bloat in `register-tools.js`, but extracting the logic requires a larger refactor of how the MCP server shares logic with the extension (they currently duplicate runsheet parsers). To keep this implementation focused and safe, we will port the logic directly into a new tool registration block, matching the existing pattern for things like `check_inbox` and `get_team_roster`. Grumpy is completely right about `AGENTS.md` and the `SKILL.md`; they are explicitly included in the Proposed Changes and Appendix patch to prevent agent hallucination.

## Proposed Changes
### `src/mcp-server/register-tools.js`
#### [MODIFY] `src/mcp-server/register-tools.js`
- **Context:** Agents need a native way to query the Kanban state.
- **Logic:** Add a new `server.tool("get_kanban_state", ...)` block. Port the `deriveColumn` logic and the directory scanning loop directly from `.agent/scripts/kanban-list.js`. 
- **Implementation:** Use `getWorkspaceRoot()` to anchor the paths. Ensure the JSON output structure exactly matches the legacy script (`{ "CREATED": [], "PLAN REVIEWED": [], ... }`).

### `AGENTS.md`
#### [MODIFY] `AGENTS.md`
- **Context:** The pre-flight checklist currently tells agents to run the bash script.
- **Logic:** Update step 4 under "MANDATORY PRE-FLIGHT CHECK" to point to the `get_kanban_state` MCP tool.

### `.agent/skills/get_kanban_state/SKILL.md`
#### [MODIFY] `.agent/skills/get_kanban_state/SKILL.md`
- **Context:** The skill documentation provides the actual command.
- **Logic:** Replace the `node .agent/scripts/kanban-list.js` bash instruction with an instruction to call the `get_kanban_state` tool.

## Verification Plan
### Automated Tests
- Run `node src/test/workflow-contract-consistency.test.js` to ensure the tool changes don't break existing parsing (they shouldn't, as no workflows are directly altered).
### Manual Testing
1. Restart the Switchboard MCP Server (`Switchboard: Connect MCP`).
2. Ask the planner or operator agent: "What plans are currently in the Coded column?"
3. Verify the agent successfully calls `get_kanban_state` as a native tool instead of calling `run_command` with the node script.
4. Verify the output correctly lists the plans in that column.

## Appendix: Implementation Patch
Apply the following changes:

```diff
--- src/mcp-server/register-tools.js
+++ src/mcp-server/register-tools.js
@@ -... +... @@
+    // Tool: get_kanban_state
+    server.tool(
+        "get_kanban_state",
+        {},
+        async () => {
+            const workspaceRoot = getWorkspaceRoot();
+            const sbDir = path.join(workspaceRoot, '.switchboard');
+            const registryPath = path.join(sbDir, 'plan_registry.json');
+            const identityPath = path.join(sbDir, 'workspace_identity.json');
+            const sessionsDir = path.join(sbDir, 'sessions');
+
+            if (!fs.existsSync(registryPath) || !fs.existsSync(identityPath)) {
+                return { isError: true, content: [{ type: "text", text: "Error: Not a switchboard workspace or missing registry." }] };
+            }
+
+            const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
+            const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
+            const workspaceId = identity.workspaceId;
+
+            function deriveColumn(events) {
+                for (let i = events.length - 1; i >= 0; i--) {
+                    const e = events[i];
+                    const wf = (e.workflow || '').toLowerCase();
+                    if (wf.includes('reviewer') || wf === 'review') return 'CODE REVIEWED';
+                    if (wf === 'lead' || wf === 'coder' || wf === 'handoff' || wf === 'team' || wf === 'handoff-lead') return 'CODED';
+                    if (wf === 'planner' || wf === 'challenge' || wf === 'enhance' || wf === 'accuracy' || wf === 'sidebar-review' || wf === 'enhanced plan') return 'PLAN REVIEWED';
+                }
+                return 'CREATED';
+            }
+
+            const files = fs.readdirSync(sessionsDir);
+            const columns = {
+                'CREATED': [],
+                'PLAN REVIEWED': [],
+                'CODED': [],
+                'CODE REVIEWED': []
+            };
+
+            for (const file of files) {
+                if (!file.endsWith('.json') || file === 'activity.json') continue;
+                try {
+                    const sheet = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
+                    if (sheet.completed) continue;
+
+                    let planId = sheet.sessionId;
+                    if (sheet.brainSourcePath) {
+                        const normalized = path.normalize(path.resolve(workspaceRoot, sheet.brainSourcePath));
+                        const stable = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
+                        const root = path.parse(stable).root;
+                        const stablePath = stable.length > root.length ? stable.replace(/[\\\/]+$/, '') : stable;
+                        planId = crypto.createHash('sha256').update(stablePath).digest('hex');
+                    }
+
+                    const entry = registry.entries[planId];
+                    if (!entry || entry.ownerWorkspaceId !== workspaceId || entry.status !== 'active') continue;
+
+                    const col = deriveColumn(sheet.events || []);
+                    columns[col].push({
+                        topic: sheet.topic || sheet.planFile || 'Untitled',
+                        sessionId: sheet.sessionId,
+                        createdAt: sheet.createdAt
+                    });
+                } catch (e) {}
+            }
+
+            return { content: [{ type: "text", text: JSON.stringify(columns, null, 2) }] };
+        }
+    );
+
     // Tool: set_agent_status (unified — replaces set_terminal_status + update_chat_agent_status)
     server.tool(

--- AGENTS.md
+++ AGENTS.md
@@ -... +... @@
 ### ⚠️ MANDATORY PRE-FLIGHT CHECK
 Before EVERY response, you MUST:
 1. **Scan** the user's message for explicit workflow commands from the table above (prefer `/workflow` forms).
 2. **Do not auto-trigger on generic language** (for example: "review this", "delegate this", "quick start") unless the user explicitly asks to run that workflow.
 3. **If a command match is found**: Read the workflow file with `view_file .agent/workflows/[WORKFLOW].md` and execute it step-by-step. Do NOT improvise an alternative approach.
-4. **Fast Kanban Resolution**: If the user asks about plans in specific Kanban columns (e.g. "update all created plans"), you MUST use the `Get Kanban State` skill (`node .agent/scripts/kanban-list.js`) to instantly identify the target plans.
+4. **Fast Kanban Resolution**: If the user asks about plans in specific Kanban columns (e.g. "update all created plans"), you MUST use the `get_kanban_state` MCP tool to instantly identify the target plans.
 5. **If no match is found**: Respond normally.

--- .agent/skills/get_kanban_state/SKILL.md
+++ .agent/skills/get_kanban_state/SKILL.md
@@ -... +... @@
 - When you need to find the oldest pending plan to work on.
 - When verifying the current state of a specific session.
 
 ## Usage
-Run the following command in the workspace root:
-```bash
-node .agent/scripts/kanban-list.js
-```
+Call the `get_kanban_state` MCP tool.
 
 ### Response Format
-The script outputs a JSON object where keys are Kanban columns and values are arrays of plan metadata:
+The tool outputs a JSON object where keys are Kanban columns and values are arrays of plan metadata:
 ```json
```

## Review Feedback
- **Grumpy Review:** You call this a "native MCP tool"? You're blindly porting an outdated script's logic and calling it a day! Did you even look at how the real Kanban board works in `src/services/KanbanProvider.ts`?! You completely forgot to filter out `plan_tombstones.json` and `brain_plan_blacklist.json`! Without those, your shiny new MCP tool is going to resurrect deleted plans and blacklisted items like a zombie apocalypse! And what about the `require('crypto')` import? Are you sure it's available in `register-tools.js`? Try again, but this time, actually read the real source of truth instead of copying an old script!
- **Balanced Synthesis:** Grumpy makes a critical observation: the proposed port misses the tombstone and blacklist filtering logic that the true Kanban UI relies on to hide completed, deleted, or blacklisted plans. While moving this logic into a native MCP tool is a strong architectural improvement that reduces IPC overhead, we must ensure it achieves perfect feature parity with `KanbanProvider.ts`. The implementation patch needs to be updated to load and evaluate the tombstone and blacklist JSON sets. Otherwise, the plan is sound.