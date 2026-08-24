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
> - To run a workflow, invoke its native slash command (e.g. `/switchboard`, `/switchboard-cloud`, `/switchboard-remote`, `/switchboard-memo`) or read the skill at `.claude/skills/<name>/SKILL.md`.
> - The ClickUp / Linear / kanban skills shell out via `.agents/skills/_lib/sb_api_call.sh` and work as-is, provided the Switchboard extension (and its API server) is running.

---

# AGENTS.md - Switchboard Protocol

## 🚨 STRICT PROTOCOL ENFORCEMENT 🚨

This project relies on **Switchboard Workflows** defined in `.agents/workflows`.

**Rule #1**: If a user request matches a known workflow trigger, you **MUST** execute that workflow exactly as defined in the corresponding `.md` file. Do not "wing it" or use internal capability unless explicitly told to ignore the workflow.

**Rule #2**: You MUST NOT call `send_message` with unsupported actions. Only `submit_result` and `status_update` are valid (see Code-Level Enforcement below). The tool will reject unrecognized or unauthorized actions.

**Rule #3**: The `send_message` tool auto-routes actions to the correct recipient based on the active workflow. You do NOT need to specify a recipient. If the workflow requires a specific role (e.g. `reviewer`), ensure an agent with that role is registered.

### Workflow Registry

| Trigger Words | Workflow File | Description |
| :--- | :--- | :--- |
| `/switchboard` | **`switchboard.md`** | **The launcher** — start the board if nothing is running, then start Mission Control into its pre-flight. The primary front door; start here when unsure. |
| `/switchboard-cloud` | **`switchboard-cloud.md`** | Cloud-VM planning brake — plan first, do not auto-code in a remote VM. |
| `/switchboard-remote` | **`switchboard-remote.md`** | Remote Switchboard control — drive plans via Linear or Notion when the local machine is off. |
| `/switchboard-memo`, "start memo capture" | **`switchboard-memo.md`** | Memo capture mode — append-only, no analysis. Enter via `/switchboard-memo` or by saying "start memo capture". Exit with `process memo`. Edit entries with `edit N: <text>`. |

These four are the ONLY user-typeable workflow commands. Internal, extension-dispatched workflows are no longer slash commands: `improve-plan`, `improve-feature`, `accuracy`, and `switchboard-mission-control` (shared logic, injected after a runtime-specific runsheet) live as protocols under `.switchboard/protocols/<name>/SKILL.md`, read by the extension by path (the Mission Control persona is system-launched from the Mission Control panel; never invoke it ad hoc).


### ⚠️ MANDATORY PRE-FLIGHT CHECK

Before EVERY response, you MUST:

1. **Scan** the user's message for explicit workflow commands from the table above (prefer `/workflow` forms).
2. **Do not auto-trigger on generic language** (for example: "review this", "delegate this", "quick start") unless the user explicitly asks to run that workflow or uses a recognized natural-language trigger listed in the table above (e.g. "start memo capture").
3. **If a command match is found**: Read the workflow file with `view_file .agents/workflows/[WORKFLOW].md` and execute it step-by-step. Do NOT improvise an alternative approach.
4. **Fast Kanban Resolution**: If the user asks about plans in specific Kanban columns (e.g. "update all created plans"), you MUST use the `query-kanban` skill (read `.switchboard/workspace-id` for ID and DB path, then query with sqlite3) to instantly identify the target plans.
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
User ──► Switchboard Console (/switchboard) or cloud plan-brake (switchboard-cloud.md)
              │  Plans captured in .switchboard/plans/
              │
              ├──► improve-plan protocol (.switchboard/protocols/improve-plan/SKILL.md, extension-dispatched)
              │                    Deep planning with optional dependency checks and adversarial review
              └──► Kanban Board    Plans moved through workflow stages (Created → Coded → Reviewed → Done)

All file writes to .switchboard/ MUST use IsArtifact: false.
Plans are executed via Kanban board workflow, not delegation.
```

Kanban column transitions are handled automatically by the system/host. Execution agents must NEVER attempt to update kanban columns directly via SQL or any other method during normal workflow execution. The `query-kanban` skill is for QUERYING kanban state only (e.g., identifying plans in specific columns). To manually move a card when explicitly requested by the user, use the `kanban_operations` skill. The **Mission Control persona** is the sanctioned exception — it moves cards via `move-card.js`/`POST /kanban/move` (the API path a human's click takes), never via SQL.

### 📚 Available Skills

Skills provide specialized capabilities and domain knowledge. Invoke with `skill: "<name>"`.

| Skill | When to Use |
|-------|-------------|
| `manage-features` | Create, group, and rearrange Switchboard features — Create (remote file write), Create from Plans (create-feature.js), Group (scan/cluster/propose), Rearrange (split/move/merge subtasks without rewriting content). Merged from create-feature, create-feature-from-plans, group-into-features, rearrange-feature. |
| `query-kanban` | Query kanban DB via SQL (read-only). Includes schema reference, column label mapping, and ready-made query templates. Merged from query-switchboard-kanban + query-kanban-plans. |
| `kanban_operations` | Move cards via move-card.js, create features via create-feature.js — MANUAL FALLBACK ONLY, use only when user explicitly requests a card move |
| `worktree-cleanup` | Clean up worktrees after merge via LocalApiServer |

**Protocols** (not discoverable — delivered by path reference): improve-plan, improve-feature, accuracy, dispatch-analysis, advise_research, switchboard-mission-control(-external/-internal), switchboard-mission-control-http, switchboard-contracts, complexity-scoring, deep-planning, web-research, tuning, constitution-builder, external-team-lead, improve-remote-plan, design-system-builder, refine_feature, archive, clickup-api, clickup-fetch, clickup-create-task, clickup-modify-task, clickup-attach, clickup-create-subpage, clickup-move-task, linear-api, linear-move-issue, notion-api, get-tickets, generate-diagram. These live at `.switchboard/protocols/<name>/SKILL.md` and are read by path when a directive tells you to.

**Usage**: Invoke discoverable skills with `skill: "<name>"`. Protocols are read by path (e.g. `read .switchboard/protocols/improve-plan/SKILL.md`).

**Skill Files Location**: `.agents/skills/` (discoverable skills) and `.switchboard/protocols/` (path-delivered protocols).

### 📌 Memo Capture Mode — Priority Rule

While `/switchboard-memo` capture mode is active, capture mode takes precedence over the default "analyze and act" behavior. Capture mode is entered by `/switchboard-memo` or the natural-language request "start memo capture" (host-independent, for chats without slash commands). The agent appends each user message to `.switchboard/memo.md` and does NOT analyze, plan, or write code. Every capture-mode reply begins with `[MEMO CAPTURE ACTIVE]` and ends by advising the command `process memo`. The sole exit trigger is the exact command `process memo` (case-insensitive, as the entire message) — it exits capture mode, processes all entries into plan files (one per entry) and clears the memo file on success. An in-place edit command `edit N: <text>` (where N is the 1-based entry number) replaces entry N without appending a new entry; it does not exit capture mode. To leave without processing, clear the conversation. The Memo sub-tab in the sidebar remains as an alternative processing path (backend-driven, immune to host system prompt overrides).
See `.agents/workflows/switchboard-memo.md` for the full protocol.

### 📝 Plan Authoring & Problem Analysis Protocol

When creating or improving any implementation plan (including via the extension-dispatched `improve-plan` protocol at `.switchboard/protocols/improve-plan/SKILL.md`):
- You MUST explicitly document the core problems, background context, and root cause analysis.
- This details should be placed directly inside or immediately below the `## Goal` section to ensure the plan remains self-contained without violating workflow section requirements.
- The `improve-plan` required section schema must never be used as a reason to drop the problem analysis.
- **Plan Sizing — split before drafting.** Before writing any plan file, assess whether the work is one plan or multiple. Auto-split into separate plan files when EITHER signal is present:
  - **3+ distinct deliverables:** the work produces 3+ independent outputs (e.g. 3+ pages, 3+ components that don't share a root cause, 3+ API endpoints in different domains, 3+ unrelated bug fixes).
  - **2+ independently-shippable phases:** the work has sequential stages where each could be shipped on its own (e.g. "migrate framework" then "build new pages" then "set up deploy pipeline").
  When splitting: write each as a separate plan file with its own Goal, Metadata, and Verification Plan. Do NOT write one mega-plan covering all deliverables/phases — each plan must be independently codeable. If the user explicitly asks for a single plan, respect that and write one. If you wrote 3+ plans, group them into a feature via the `manage-features` skill (Create from Plans section) — if the user already asked for grouping or a feature, treat the original ask as confirmation and create it without a second confirm; if you are proposing grouping the user did not request, offer it and wait for confirmation.

### 📂 Workspace Detection for Plan Creation

When creating plan files in multi-workspace setups, use this decision tree to determine which workspace's `.switchboard/plans/` directory to target:

1. **Primary signal: Active IDE workspace** — If the user's active editor or focused workspace folder is within a specific workspace root, write plans to that workspace's `.switchboard/plans/` directory. This is the most reliable signal.

2. **Secondary signal: Task content keywords** — If the active workspace signal is ambiguous (e.g., the user is in a generic file), look for project-specific keywords in the task description. This is a hint, not a rule.

3. **Tertiary signal: `.switchboard/` existence** — Confirm the selected workspace has a `.switchboard/plans/` directory before writing. If it doesn't exist, the workspace may not be a Switchboard-managed project.

4. **Fallback: Ask the user** — If detection is ambiguous (multiple signals conflict or no signal matches), ask the user which workspace to use. Do NOT silently default to any workspace.

### 📌 Plan Project Pinning

**Scope — creation only.** This sets a *new* plan's project as it's authored; the `**Project:**` line resolves once, when the file is first imported. To move an *existing* (already-imported) plan to a different project, use the Switchboard board or its local API — editing the pin on an imported plan does **not** reassign it, by design. The pin is the file-based authoring path (and the only option for cloud / DB-less agents that can't reach the API).

**The workspace/repo name is NOT a project. Never pin it. Never emit a placeholder like `<project>`.** A workspace is a workspace; a project is a user-created board filter. They are not interchangeable.

When creating any plan file, resolve the project in this priority order:
1. If the user named a target project in their request, pin that: write `**Project:** <name>` in the metadata block. The user's words always beat everything else.
2. Otherwise, if your prompt carries a **PROJECT PIN directive**, write the exact `**Project:** <name>` it specifies. This directive is the authoritative source: the extension resolves the board's active project **once, at prompt-generation time**, and injects it — a frozen, race-free snapshot.
3. Otherwise, omit the line. **Do not read `kanban.activeProjectFilter` or open `kanban.db` yourself.** The extension already resolved the active project at prompt-generation time; re-deriving it in-session duplicates that work and races (the user may browse other boards while the agent runs), and remote / DB-less sessions cannot read it at all. Never guess, never substitute the workspace/repo name, never leave a literal `<project>` placeholder. The plan lands unassigned and can be reassigned on the board.

When you WRITE a pin (cases 1–2), name it in your reply ("Pinning to *<name>*") so a wrong snapshot is visible immediately. When you omit it (case 3), say **nothing** about the project — not that you omitted it, not which project the importer chose, not that the choice wasn't yours. The importer stamps the board's active project on import; that is the system working, and narrating it is noise. The only thing worth one line is a stamp that is actually wrong — equal to a workspace name, or a literal `<...>` placeholder.

Write the pin as `**Project:** <name>` — plain or as a `- ` list item; both parse. The .md metadata is the carrier — the plan watcher reads it directly on import.

> **System backstop:** the importer is resolve-only. An unknown pin (or one equal to a workspace name / a literal `<...>` placeholder) leaves the plan unassigned instead of auto-creating a `projects` row. Only the user creates projects (on the board). The protocol above is the first line of defense; the import guard is the non-negotiable backstop.
<!-- switchboard:claude-protocol:end -->
