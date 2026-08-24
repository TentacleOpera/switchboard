# Plan Authoring Protocol — external-surface context source

Source of truth for the four protocol sections `SparkContextExporter` curates into
`.switchboard/switchboard-spark.md`, the one-shot context a user uploads to an
external AI surface (Gemini Spark et al.) that has no filesystem and therefore no
skill discovery.

These sections used to live inside the `AGENTS.md` managed block, which made them
resident in every agent's context on every turn. They are *action-local* — they
matter only while a plan is being written — so they were cut from the resident
block (see `shrink-the-injected-agent-protocol-block.md`) and moved here, where
the one consumer that genuinely needs them can still read them.

This file is NEVER scaffolded into a managed block and never injected into a
prompt. Edit it here; `AGENTS.md` and `CLAUDE.md` do not carry this content.

Headings must stay at level 3 (`###`) and their titles must match
`WANTED_AGENTS_SECTIONS` in `src/services/SparkContextExporter.ts` exactly —
the curator selects by literal title, and a renamed heading silently drops the
section from the artifact.

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
