# Switchboard — agent rules

## NEVER add confirmation dialogs. NO EXCEPTIONS.

Delete buttons delete immediately. No `confirm()`, no `window.confirm()`, no modal `showWarningMessage`, no two-click patterns, no "Are you sure?". The user has demanded this repeatedly. Buttons are deliberately hard to misclick.

Also a hard technical reason: `window.confirm()` is a **silent no-op in VS Code webviews** (sandboxed iframe without `allow-modals` — it always returns `false`). Any confirm gate added to `src/webview/planning.js`, `src/webview/kanban.html`, etc. makes the button do *literally nothing*. This exact bug broke the kanban delete-plan button (fixed 2026-06-11).

If you find a confirm gate in this codebase, it is a bug — remove it. Multi-choice decision dialogs (e.g. 3-way conflict resolution) are allowed; plain confirm gates are not.

## Build

- `npm run compile` (webpack) builds to `dist/`, but **`dist/` is NOT used during development or testing**. All testing is done via an installed VSIX — nothing is served from the repo's `dist/` directory. Do NOT audit, check, or flag `dist/` staleness during reviews or verification. Treat `src/` as the source of truth. `npm run compile` is only needed when producing a VSIX for release.

## Users & migrations

- **Published extension, ~4,000 installs**, many on much older versions. The dividing line is whether the state **shipped in a released version**:
  - State/files/settings that exist in any released version MUST be migrated on change: import before deleting, archive legacy files as `*.migrated.bak` rather than unlinking, preserve unknown/legacy keys instead of dropping them, and never assume a prior migration "already ran" for the install base.
  - Features that have only ever existed in unreleased dev work can take clean breaks — no migrations, no compat shims.
- When unsure whether something shipped, assume it did and migrate — a no-op migration costs nothing; a missing one destroys user data.

<!-- switchboard:claude-protocol:start -->
# CLAUDE.md - Switchboard Protocol

> **Claude Code note.** The Switchboard protocol below was authored for the Antigravity host. In Claude Code:
> - `view_file <path>` → use the **Read** tool.
> - `send_message` and role-routing (reviewer, lead, etc.) are **Antigravity-only** — ignore them here.
> - To run a workflow, invoke its native slash command (e.g. `/memo`, `/improve-plan`, `/switchboard-chat`) or read the skill at `.claude/skills/<name>/SKILL.md`.
> - The ClickUp / Linear / kanban skills shell out via `.agents/skills/_lib/sb_api_call.sh` and work as-is, provided the Switchboard extension (and its API server) is running.

---

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
| `/accuracy` | **`accuracy.md`** | High accuracy mode with self-review (Standard Protocol). |
| `/improve-plan` | **`improve-plan.md`** | Deep planning with optional dependency checks and adversarial review. |
| `/switchboard-chat`, `/sw` | **`switchboard-chat.md`** | Activate chat consultation workflow. `/sw` is the short alias for claude.ai. (Avoid `/chat` — clashes with the native CLI reset command.) |
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
| `switchboard_remote_notion` | Orient a claude.ai session on driving a Switchboard board through Notion via the Notion MCP connector |
| `web_research` | User asks to "research X", "investigate Y", or needs authoritative sources |
| `deep_planning` | User requests complex code changes requiring architecture understanding |
| `memo` | User invokes `/memo` or says "start memo capture" to enter progressive capture mode — agent appends each user message to `.switchboard/memo.md` without analysis. |
| `switchboard-chat` | Enter consultative planning mode on claude.ai — type `/sw` to activate. Reads kanban state so you can reference columns and chain workflows. |
| `refine_ticket` | User clicks "Refine" on a ticket card to copy a prompt that produces a complete, agent-actionable specification (backend-consumed skill — not invocable via `skill: "refine_ticket"`) |

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

When a chat or memo dispatch prompt carries a PROJECT PIN directive, write `**Project:** <name>` into each plan file's metadata block. The watcher prefers this field over the board's active project at import time, preventing the project race when the user switches projects between copying and running the prompt. No manifest is needed for project pinning — the .md metadata is the carrier.

<!-- switchboard:agents-protocol:end -->
<!-- switchboard:agents-protocol:end -->
<!-- switchboard:claude-protocol:end -->
