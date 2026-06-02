<!-- switchboard:agents-protocol:start -->
<!-- switchboard:agents-protocol:start -->
# AGENTS.md - Switchboard Protocol

### 📚 Available Skills

Skills provide specialized capabilities and domain knowledge. Invoke with `skill: "<name>"`.

> [!IMPORTANT]
> **Tool Preference Guidance**:
> - **Prefer skill-based invocations** for ClickUp, Linear, and diagram operations.
> - **Workflow tools** (`get_team_roster`, `start_workflow`, `complete_workflow_phase`, etc.) remain the primary interface for workflow and messaging coordination.

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
| `get_tickets` | Read-only cached ClickUp/Linear ticket access via LocalApiServer |
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

**Step 0 — Check for Antigravity Brain Environment**
If the directory `~/.gemini/antigravity/brain/` or `~/.gemini/antigravity-cli/brain/` exists on the filesystem, you are likely running inside an Antigravity sandbox session. In this case, you MUST write the implementation plan *only* to the `implementation_plan.md` file inside the active conversation subdirectory under whichever brain folder is present (the subdirectory you are currently operating within). Do NOT manually write a second copy of the plan to `.switchboard/plans/` — the Switchboard extension's brain watcher will automatically mirror the brain file into the plans directory for you. Proceed no further through this algorithm.

**Step 1 — Discover the Switchboard workspace**
Check each open workspace root for the existence of `.switchboard/plans/`. Not every repo in a multi-root setup has this — only Switchboard-managed workspaces do. Run: `ls {workspaceRoot}/.switchboard/plans/` for each root.

**Step 2 — If exactly one workspace has `.switchboard/plans/`**
Write the plan there. Period. Do not write it to the repo the task is *about* — that repo may not be Switchboard-managed. The plan content describes the work; the file location is always the Switchboard workspace.

**Step 3 — If multiple workspaces have `.switchboard/plans/`**
Use the active editor's workspace root as the tiebreaker. Write to the `.switchboard/plans/` directory in whichever Switchboard-managed workspace contains the currently active file. If the active file is not in any Switchboard-managed workspace, ask the user which workspace to use.

**Step 4 — If no workspace has `.switchboard/plans/`**
Ask the user where to write the plan. Never create `.switchboard/plans/` yourself.

**NEVER** skip the filesystem check and assume a workspace is Switchboard-managed based on file context alone.
<!-- switchboard:agents-protocol:end -->
<!-- switchboard:agents-protocol:end -->
