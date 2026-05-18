# AGENTS.md - Switchboard Protocol

## 🚨 STRICT PROTOCOL ENFORCEMENT 🚨

This project relies on **Switchboard Workflows** defined in `.agent/workflows`.

**Rule #1**: If a user request matches a known workflow trigger, you **MUST** execute that workflow exactly as defined in the corresponding `.md` file. Do not "wing it" or use internal capability unless explicitly told to ignore the workflow.

**Rule #2**: You MUST NOT call `send_message` with unsupported actions. Only `submit_result` and `status_update` are valid (see Code-Level Enforcement below). The tool will reject unrecognized or unauthorized actions.

**Rule #3**: The `send_message` tool auto-routes actions to the correct recipient based on the active workflow. You do NOT need to specify a recipient. If the workflow requires a specific role (e.g. `reviewer`), ensure an agent with that role is registered.

### Workflow Registry

| Trigger Words | Workflow File | Description |
| :--- | :--- | :--- |
| `/accuracy` | **`accuracy.md`** | High accuracy mode with self-review (Standard Protocol). |
| `/improve-plan` | **`improve-plan.md`** | Deep planning with optional dependency checks and adversarial review. |
| `/chat` | **`chat.md`** | Activate chat consultation workflow. |


### ⚠️ MANDATORY PRE-FLIGHT CHECK

Before EVERY response, you MUST:

1. **Scan** the user's message for explicit workflow commands from the table above (prefer `/workflow` forms).
2. **Do not auto-trigger on generic language** (for example: "review this", "delegate this", "quick start") unless the user explicitly asks to run that workflow.
3. **If a command match is found**: Read the workflow file with `view_file .agent/workflows/[WORKFLOW].md` and execute it step-by-step. Do NOT improvise an alternative approach.
4. **Fast Kanban Resolution**: If the user asks about plans in specific Kanban columns (e.g. "update all created plans"), you MUST use the `query_switchboard_kanban` skill (read `.switchboard/workspace-id` for ID and DB path, then query with sqlite3) to instantly identify the target plans.
5. **If no match is found**: Respond normally.

### Execution Rules

1. **Read Definition**: Use `view_file .agent/workflows/[WORKFLOW].md` to read the steps.
2. **Execute Step-by-Step**: Follow the numbered steps in the workflow.
   - If a step says "Call tool X", call it.
   - If a step says "Generate artifact Y", generate it.
3. **Do Not Skip**: Do not merge steps or skip persona adoption unless the workflow explicitly allows it (e.g. `// turbo`).
4. **Do Not Improvise**: If a workflow exists for the user's request, you MUST use it. Calling tools directly without following the workflow is a protocol violation and will be rejected by the tool layer.

### Code-Level Enforcement

The following actions are enforced at the tool level and WILL be rejected if misused:

| Action | Required Active Workflow |
| :--- | :--- |
| `submit_result` | *(no restriction — this is a response)* |
| `status_update` | *(no restriction — informational)* |

Sending to non-existent recipients is always rejected (even when auto-routed).

### 🏗️ Switchboard Global Architecture

```
User ──► Switchboard Operator (chat.md)
              │  Plans captured in .switchboard/plans/
              │
              ├──► /improve-plan   Deep planning with optional dependency checks and adversarial review
              └──► Kanban Board    Plans moved through workflow stages (Created → Coded → Reviewed → Done)

All file writes to .switchboard/ MUST use IsArtifact: false.
Plans are executed via Kanban board workflow, not delegation.
```

Kanban column transitions are handled automatically by the system/host. Execution agents must NEVER attempt to update kanban columns directly via SQL or any other method. The `query_switchboard_kanban` skill is for QUERYING kanban state only (e.g., identifying plans in specific columns). To advance a plan to the next stage, simply complete your assigned work — the system will move the card automatically.

### 📚 Available Skills

Skills provide specialized capabilities and domain knowledge. Invoke with `skill: "<name>"`.

| Skill | When to Use |
|-------|-------------|
| `archive` | User asks to "search archives", "query archives", "find old plans", "export conversation" |
| `clickup_api` | Direct ClickUp API access via LocalApiServer proxy (replaces call_clickup_api) |
| `clickup_attach` | Attach files to ClickUp tasks via LocalApiServer (replaces clickup_attach) |
| `clickup_create_subpage` | Create doc pages in ClickUp via LocalApiServer (replaces clickup_create_subpage) |
| `clickup_create_task` | Create ClickUp tasks with optional subtasks via LocalApiServer (replaces clickup_create_task) |
| `clickup_fetch` | Fetch ClickUp tasks/lists with name resolution (replaces clickup_fetch) |
| `clickup_modify_task` | Update ClickUp task properties via LocalApiServer (replaces clickup_modify_task) |
| `generate_diagram` | Generate architectural diagrams via LocalApiServer (replaces generate_architectural_diagram) |
| `review` | User asks to review code changes, a PR, or specific files |
| `query_switchboard_kanban` | Query kanban state via direct SQL access to kanban.db (read-only) |
| `query_archive` | Query the DuckDB archive directly using duckdb CLI |
| `complexity_scoring` | Assess and assign numeric complexity scores (1-10) to plans and tasks |
| `linear_api` | Direct Linear API access via LocalApiServer proxy (replaces call_linear_api) |
| `web_research` | User asks to "research X", "investigate Y", or needs authoritative sources |
| `deep_planning` | User requests complex code changes requiring architecture understanding |

**Usage**: Call `skill: "archive"` before performing archive operations to access detailed tool documentation and examples.

**Skill Files Location**: `.agent/skills/` (distributed with plugin)

### 📂 Workspace Detection for Plan Creation

**MANDATORY**: Before writing any plan file, you MUST verify where to write it using this algorithm:

**Step 1 — Discover the Switchboard workspace**
Check each open workspace root for the existence of `.switchboard/plans/`. Not every repo in a multi-root setup has this — only Switchboard-managed workspaces do. Run: `ls {workspaceRoot}/.switchboard/plans/` for each root.

**Step 2 — If exactly one workspace has `.switchboard/plans/`**
Write the plan there. Period. Do not write it to the repo the task is *about* — that repo may not be Switchboard-managed. The plan content describes the work; the file location is always the Switchboard workspace.

**Step 3 — If multiple workspaces have `.switchboard/plans/`**
Use the active editor's workspace root as the tiebreaker. Write to the `.switchboard/plans/` directory in whichever Switchboard-managed workspace contains the currently active file. If the active file is not in any Switchboard-managed workspace, ask the user which workspace to use.

**Step 4 — If no workspace has `.switchboard/plans/`**
Ask the user where to write the plan. Never create `.switchboard/plans/` yourself.

**NEVER** skip the filesystem check and assume a workspace is Switchboard-managed based on file context alone.
