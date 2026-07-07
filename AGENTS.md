<!-- switchboard:agents-protocol:start -->
<!-- switchboard:agents-protocol:start -->
<!-- switchboard:agents-protocol:start -->
# AGENTS.md - Switchboard Protocol

## 🚨 STRICT PROTOCOL ENFORCEMENT 🚨

This project relies on **Switchboard Workflows** defined in `.agents/workflows`.

**Rule #1**: If a user request matches a known workflow trigger, you **MUST** execute that workflow exactly as defined in the corresponding `.md` file. Do not "wing it" or use internal capability unless explicitly told to ignore the workflow.

**Rule #2**: You MUST NOT call `send_message` with unsupported actions. Only `submit_result` and `status_update` are valid (see Code-Level Enforcement below). The tool will reject unrecognized or unauthorized actions.

**Rule #3**: The `send_message` tool auto-routes actions to the correct recipient based on the active workflow. You do NOT need to specify a recipient. If the workflow requires a specific role (e.g. `reviewer`), ensure an agent with that role is registered.

### Workflow Registry

| Trigger Words | Workflow File | Description |
| :--- | :--- | :--- |
| `/switchboard` | **`switchboard-index.md`** | Front door — detects local vs remote and routes the request to the right Switchboard skill. Start here when unsure which skill to use. |
| `/accuracy` | **`accuracy.md`** | High accuracy mode with self-review (Standard Protocol). |
| `/improve-plan` | **`improve-plan.md`** | Deep planning with optional dependency checks and adversarial review. Single plans only — for a feature use `/improve-feature`. |
| `/improve-feature` | **`improve-feature.md`** | Reconcile & restructure a feature's subtasks — improve each, then merge/delete/rewrite/split to make the set coherent. Authorised to cut. Supports a high/low complexity-tier mode. |
| `/switchboard-split` | **`switchboard-split.md`** | Split one plan into a Complex/Risky file + a Routine companion so the tiers can be coded separately. Remote-safe (file writes). |
| `/switchboard-chat` | **`switchboard-chat.md`** | Local consultative planning mode. (Reached via `/switchboard` in local mode; `/sw` retired. Avoid `/chat` — clashes with the native CLI reset command.) |
| `/memo`, "start memo capture" | **`memo.md`** | Memo capture mode — append-only, no analysis. Enter via `/memo` or by saying "start memo capture". Exit with `process memo`. Edit entries with `edit N: <text>`. |


### ⚠️ MANDATORY PRE-FLIGHT CHECK

Before EVERY response, you MUST:

1. **Scan** the user's message for explicit workflow commands from the table above (prefer `/workflow` forms).
2. **Do not auto-trigger on generic language** (for example: "review this", "delegate this", "quick start") unless the user explicitly asks to run that workflow or uses a recognized natural-language trigger listed in the table above (e.g. "start memo capture").
3. **If a command match is found**: Read the workflow file with `view_file .agents/workflows/[WORKFLOW].md` and execute it step-by-step. Do NOT improvise an alternative approach.
4. **Fast Kanban Resolution**: If the user asks about plans in specific Kanban columns (e.g. "update all created plans"), you MUST use the `query_switchboard_kanban` skill (read `.switchboard/workspace-id` for ID and DB path, then query with sqlite3) to instantly identify the target plans.
5. **If no match is found**: Respond normally.

### Execution Rules

1. **Read Definition**: Use `view_file .agents/workflows/[WORKFLOW].md` to read the steps.
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
User ──► Switchboard Operator (switchboard-chat.md)
              │  Plans captured in .switchboard/plans/
              │
              ├──► /improve-plan   Deep planning with optional dependency checks and adversarial review
              └──► Kanban Board    Plans moved through workflow stages (Created → Coded → Reviewed → Done)

All file writes to .switchboard/ MUST use IsArtifact: false.
Plans are executed via Kanban board workflow, not delegation.
```

Kanban column transitions are handled automatically by the system/host. Execution agents must NEVER attempt to update kanban columns directly via SQL or any other method during normal workflow execution. The `query_switchboard_kanban` skill is for QUERYING kanban state only (e.g., identifying plans in specific columns). To manually move a card when explicitly requested by the user, use the `kanban_operations` skill.

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
| `clickup_move_task` | Move a ClickUp task to a different list via LocalApiServer |
| `linear_move_issue` | Move a Linear issue to a different project via LocalApiServer |
| `generate_diagram` | Generate architectural diagrams via LocalApiServer (replaces generate_architectural_diagram) |
| `review` | User asks to review code changes, a PR, or specific files |
| `query_switchboard_kanban` | Query kanban state via direct SQL access to kanban.db (read-only) |
| `kanban_operations` | Move kanban cards via move-card.js — MANUAL FALLBACK ONLY, use only when user explicitly requests a card move |
| `query_archive` | Query the DuckDB archive directly using duckdb CLI |
| `complexity_scoring` | Assess and assign numeric complexity scores (1-10) to plans and tasks |
| `linear_api` | Direct Linear API access via LocalApiServer proxy (replaces call_linear_api) |
| `notion_api` | Post a reply back to a Notion-driven Remote Control card via the `/comment` bridge (provider `notion`) |
| `web_research` | User asks to "research X", "investigate Y", or needs authoritative sources |
| `deep_planning` | User requests complex code changes requiring architecture understanding |
| `memo` | User invokes `/memo` or says "start memo capture" to enter progressive capture mode — agent appends each user message to `.switchboard/memo.md` without analysis. |
| `switchboard` | User types `/switchboard` or doesn't know which skill they need — front door that detects local vs remote and routes the request to the right skill. |
| `switchboard-chat` | Local consultative planning mode. Reached via `/switchboard` in local mode (the `/sw` alias was retired). Reads kanban state so you can reference columns and chain workflows. |
| `improve-feature` | User runs `/improve-feature` on a feature. Improves every subtask, then restructures the set — merge/delete/rewrite/split. Authorised to cut; git is the undo. Has a high/low complexity-tier mode. |
| `switchboard-split` | User runs `/switchboard-split` on one plan — splits it into a Complex/Risky file + a Routine companion. Remote-safe file writes; the local splitter's remote equivalent. |
| `refine_ticket` | User clicks "Refine" on a ticket card to copy a prompt that produces a complete, agent-actionable specification (backend-consumed skill — not invocable via `skill: "refine_ticket"`) |
| `refine_feature` | User clicks "Refine" on a selected feature in the Features tab to copy a prompt that fleshes out the feature description and proposes a subtask breakdown (backend-consumed skill — not invocable via `skill: "refine_feature"`) |
| `group-into-features` | User asks to "group plans into a feature", "organise loose plans into features", or "suggest feature groupings" — scans pre-coding columns, clusters by capability, proposes all groupings for one approval, then creates features via create-feature.js (model-invocable; also sourced by the Suggest Features board button) |
| `create-feature` | Create a Switchboard feature from a remote session by writing the feature file directly to `.switchboard/features/` — use when the VS Code extension is not running and `create-feature.js` is unreachable |
| `create-feature-from-plans` | Create a Switchboard feature from a known set of plans when the extension is running — runs create-feature.js |
| `improve-remote-plan` | Improve a plan stored in Linear via the LocalApiServer GraphQL proxy — reads, deepens, writes back, and advances status without touching git. Use in remote sessions. |
| `worktree_cleanup` | Mark a worktree merged and clean it up (kind-aware) via LocalApiServer. |

**Usage**: Call `skill: "archive"` before performing archive operations to access detailed tool documentation and examples.

**Skill Files Location**: `.agents/skills/` (distributed with plugin)

### 📌 Memo Capture Mode — Priority Rule

While `/memo` capture mode is active, capture mode takes precedence over the default "analyze and act" behavior. Capture mode is entered by `/memo` or the natural-language request "start memo capture" (host-independent, for chats without slash commands). The agent appends each user message to `.switchboard/memo.md` and does NOT analyze, plan, or write code. Every capture-mode reply begins with `[MEMO CAPTURE ACTIVE]` and ends by advising the command `process memo`. The sole exit trigger is the exact command `process memo` (case-insensitive, as the entire message) — it exits capture mode, processes all entries into plan files (one per entry) and clears the memo file on success. An in-place edit command `edit N: <text>` (where N is the 1-based entry number) replaces entry N without appending a new entry; it does not exit capture mode. To leave without processing, clear the conversation. The Memo sub-tab in the sidebar remains as an alternative processing path (backend-driven, immune to host system prompt overrides).
See `.agents/workflows/memo.md` for the full protocol.

### 📝 Plan Authoring & Problem Analysis Protocol

When creating or improving any implementation plan (including via `/improve-plan`):
- You MUST explicitly document the core problems, background context, and root cause analysis.
- This details should be placed directly inside or immediately below the `## Goal` section to ensure the plan remains self-contained without violating workflow section requirements.
- The `improve-plan` required section schema must never be used as a reason to drop the problem analysis.

### 📂 Workspace Detection for Plan Creation

When creating plan files in multi-workspace setups, use this decision tree to determine which workspace's `.switchboard/plans/` directory to target:

1. **Primary signal: Active IDE workspace** — If the user's active editor or focused workspace folder is within a specific workspace root, write plans to that workspace's `.switchboard/plans/` directory. This is the most reliable signal.

2. **Secondary signal: Task content keywords** — If the active workspace signal is ambiguous (e.g., the user is in a generic file), look for project-specific keywords in the task description. This is a hint, not a rule.

3. **Tertiary signal: `.switchboard/` existence** — Confirm the selected workspace has a `.switchboard/plans/` directory before writing. If it doesn't exist, the workspace may not be a Switchboard-managed project.

4. **Fallback: Ask the user** — If detection is ambiguous (multiple signals conflict or no signal matches), ask the user which workspace to use. Do NOT silently default to any workspace.

### 📌 Plan Project Pinning

**The workspace/repo name is NOT a project. Never pin it. Never emit a placeholder like `<project>`.** A workspace is a workspace; a project is a user-created board filter. They are not interchangeable.

When creating any plan file:
1. If the user named a target project in their request, pin that: write `**Project:** <name>` in the metadata block. The user's words always beat board state.
2. Otherwise, resolve the active project **once, at the start of the task** (read `kanban.activeProjectFilter` from the workspace's `kanban.db` config table) and pin that snapshot in every plan file written for the task. Do not re-read it at file-write time — the user may browse other boards while you work.
   - **Remote / DB-less sessions:** a remote agent cannot read `kanban.activeProjectFilter`. If the user named a project, pin it. Otherwise **ask** whether there's a project to stamp. If the user doesn't specify one (or the session can't ask), **write no `**Project:**` line** — never guess, never substitute the workspace/repo name, never leave a literal `<project>` placeholder. The plan lands unassigned and can be reassigned on the board.
3. State the pin in your reply ("Pinning to *<name>*") so a wrong snapshot is visible immediately.
4. If neither exists (no named project, empty config), omit the line — the plan lands unassigned and can be reassigned on the board.

Write the pin as `**Project:** <name>` — plain or as a `- ` list item; both parse. No manifest is needed for project pinning — the .md metadata is the carrier.

> **System backstop:** the importer is resolve-only. An unknown pin (or one equal to a workspace name / a literal `<...>` placeholder) leaves the plan unassigned instead of auto-creating a `projects` row. Only the user creates projects (on the board). The protocol above is the first line of defense; the import guard is the non-negotiable backstop.

<!-- switchboard:agents-protocol:end -->
<!-- switchboard:agents-protocol:end -->
<!-- switchboard:agents-protocol:end -->
