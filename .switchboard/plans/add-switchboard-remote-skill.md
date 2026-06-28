# Add /switchboard-remote Orientation Skill for Claude Web Sessions

## Goal

Create a `/switchboard-remote` skill that orients Claude at the start of a web session on how to use the Linear Remote Control feature as a Switchboard control surface.

### Problem & Background

Switchboard's Linear Remote Control feature allows driving the Kanban board from any Linear client — moving a Linear issue between states dispatches the corresponding local Kanban column agent; comments are routed to the current column's agent. This makes Linear an async message bus between the remote world and the local machine, requiring no SSH or cloud session.

Three control surfaces exist:
1. **Linear app** — user moves cards manually, limited to status transitions
2. **Claude.ai web + Linear MCP** — Claude reads the repo (via GitHub MCP), writes rich implementation plans into Linear issue descriptions, and triggers execution via status changes
3. **Linear native agents** — natural language, but no code analysis capability

Surface #2 is the highest-value option for web sessions because Claude can analyse the codebase and author thorough plans before anything runs locally. The gap is that neither Claude nor users have a concise orientation document explaining this workflow — the information exists only in the README and how-to guide, not as an invocable skill.

A parallel skill already exists for Notion: `switchboard_remote_notion` (source at `.agents/skills/switchboard_remote_notion.md`, registered in AGENTS.md, mirrored via `ClaudeCodeMirrorService`). This plan creates the Linear analog following the same pattern.

---

## Metadata

**Tags:** docs, cli, infrastructure
**Complexity:** 2

---

## User Review Required

No user review required. This is a new documentation-only skill file with no backend changes. The content is derived from existing README and how-to documentation. The only decision point is whether the skill's orientation text accurately reflects the intended Linear Remote Control workflow — the user should skim the generated skill text before merging.

---

## Complexity Audit

### Routine
- Creating a single Markdown skill file (`.agents/skills/switchboard_remote.md`)
- Adding one entry to the `MIRROR_MANIFEST` array in `ClaudeCodeMirrorService.ts`
- Adding one row to the AGENTS.md skills table
- All content is derived from existing documentation (README, how-to guide)

### Complex / Risky
- None

---

## Edge-Case & Dependency Audit

**Race Conditions:** None — this is a static documentation file with no runtime behavior.

**Security:** No security implications. The skill text references Linear MCP operations but does not contain tokens, credentials, or sensitive configuration.

**Side Effects:** Adding the MIRROR_MANIFEST entry triggers `ClaudeCodeMirrorService` to create a mirrored copy at `.claude/skills/switchboard-remote/SKILL.md` on the next mirror run. This is the intended behavior and matches the existing notion variant.

**Dependencies & Conflicts:**
- The skill references the Linear Remote Control feature, which depends on `RemoteControlService` and `LinearRemoteProvider` being functional. The skill itself has no code dependency — it is pure documentation.
- The naming convention must match the existing `switchboard_remote_notion` pattern: underscore in source filename and AGENTS.md table, hyphen in MIRROR_MANIFEST `name` field.
- **No conflict with Plan 3 (mutual exclusivity):** This skill is orientation documentation; it does not affect the mode-enforcement logic. The skill's pre-flight section already notes that Remote Control must be enabled.

---

## Dependencies

No session dependencies. This plan is self-contained.

---

## Adversarial Synthesis

Key risks: (1) bypassing the `ClaudeCodeMirrorService` mirror system by writing directly to `.claude/skills/` would cause drift on the next mirror run; (2) registering in CLAUDE.md instead of AGENTS.md would duplicate or conflict with the embedded AGENTS.md protocol block; (3) using hyphen naming for the source file would break the mirror's filename convention. Mitigations: follow the existing `switchboard_remote_notion` pattern exactly — source in `.agents/skills/`, MIRROR_MANIFEST entry, AGENTS.md table row, underscore naming for source file.

---

## Proposed Changes

### `.agents/skills/switchboard_remote.md` (NEW FILE)

**Context:** This is the canonical source file for the skill, following the same pattern as `.agents/skills/switchboard_remote_notion.md`. The `ClaudeCodeMirrorService` will mirror it to `.claude/skills/switchboard-remote/SKILL.md` for Claude Code compatibility.

**Implementation:** Create the file with YAML frontmatter (matching the notion variant — `description` only, no `name` field; the name is derived from the filename):

```yaml
---
description: Orient Claude on using Linear MCP as a remote control surface for Switchboard
---
```

**Required content sections:**

**Architecture overview**
- Linear is a two-way sync message bus: Switchboard polls Linear every 30–120s (configurable) and mirrors state changes locally
- Moving a Linear issue to a new state → dispatches the Kanban column agent for that state on the local machine
- Comments posted on a Linear issue → routed to the current column's agent as input
- Plan content lives in the issue description; no special format is required — the dispatched agent reads whatever is there
- Config is stored in the Kanban DB under key `remote.config`, not in `settings.json`; toggle is in the toolbar remote control button; configuration is in the Kanban REMOTE tab (board selection, ping mode: manual/constant, frequency: 30–120s)

**The three control surfaces** (brief table or list)
Surface #2 note: Claude's value here is reading the repo via GitHub MCP, writing a detailed implementation plan into the issue description, and setting the trigger status — giving the local agent far richer instructions than a manually written Linear ticket.

**Linear MCP workflow for Claude**
Step-by-step orientation:
1. Use `list_projects` / `list_teams` to locate the synced Switchboard project
2. Use `list_issues` to find the target issue (or `save_issue` to create one)
3. Use `list_issue_statuses` to identify the status name that triggers local execution
4. Read the repo / analyze code as needed (GitHub MCP)
5. Write the implementation plan into the issue description via `save_issue`
6. Set the trigger status via `save_issue` to dispatch the local agent
7. On a future session: use `get_issue` to read results written back by the local agent

**Configuration pre-flight**
Remind Claude to confirm remote control is enabled (toolbar button) and the correct board is mapped in the REMOTE tab before attempting to trigger via status change.

**Reference links**
- `README.md` §"Linear Remote Control" (lines 188–189)
- `README.md` §"ClickUp & Linear Sync" (lines 167–174)
- `docs/how_to_use_switchboard.md` §"Automated Triage & Remote Control" (lines 69–70)

**Edge Cases** (preserve from original plan)
- **Remote not enabled:** The skill should remind Claude to verify the remote toggle is on and the board is mapped before attempting status-driven dispatch. A status change on an unmapped board is a no-op.
- **Status name mismatch:** Linear status names must match what Switchboard expects. The skill should instruct Claude to use `list_issue_statuses` rather than guessing names.
- **Multiple boards:** If the user has multiple Switchboard boards synced to Linear, Claude needs to identify the right project. The skill should guide using `list_projects` first.
- **Plan format:** The local agent reads whatever is in the description — no special format is enforced — but the skill should recommend using the standard Switchboard plan structure (Goal, Tasks, etc.) for consistency with local plans.
- **Read-back latency:** Results written by the local agent appear in the Linear issue after the next Kanban → Linear sync cycle (up to 30s). Claude should note this when checking results in a follow-up session.

### `src/services/ClaudeCodeMirrorService.ts` (EDIT — MIRROR_MANIFEST)

**Context:** The `MIRROR_MANIFEST` array (line 41) controls which `.agents/skills/` files get mirrored to `.claude/skills/`. The existing `switchboard_remote_notion` entry is at lines 57–60. The new Linear skill needs a parallel entry.

**Logic:** Add a new entry adjacent to the notion variant, following the same structure:

```ts
{
    source: 'skills/switchboard_remote.md', name: 'switchboard-remote', invocation: 'no-model',
    descriptionFallback: 'Orient a claude.ai session on driving a Switchboard board through Linear via the Linear MCP connector (Remote Control).'
},
```

**Edge Cases:**
- `invocation: 'no-model'` matches the notion variant — the skill is user-invoked (via `/switchboard-remote` or by pasting content into a claude.ai session), not auto-invoked by the model.
- The `descriptionFallback` provides the skill description if the source file's frontmatter is missing or malformed.

### `AGENTS.md` (EDIT — skills table)

**Context:** The `### 📚 Available Skills` table in AGENTS.md lists all invocable skills. The existing `switchboard_remote_notion` entry is at line 91. CLAUDE.md embeds this table via the `<!-- switchboard:agents-protocol:start -->` markers, so adding to AGENTS.md automatically surfaces it in CLAUDE.md too.

**Logic:** Add a row adjacent to the notion variant:

```
| `switchboard_remote` | Orient Claude on using Linear MCP as a remote control for Switchboard — use at session start when working from Claude.ai web |
```

**Edge Cases:**
- The skill name in the AGENTS.md table uses underscores (`switchboard_remote`), matching the `switchboard_remote_notion` convention. The MIRROR_MANIFEST `name` field uses hyphens (`switchboard-remote`), which is the mirrored Claude Code skill name. Both are correct — they serve different consumers.

---

## Verification Plan

### Automated Tests

No automated tests required — this is a documentation-only change with no runtime logic.

### Manual Verification

1. Confirm `.agents/skills/switchboard_remote.md` exists with correct frontmatter and all required content sections.
2. Confirm the `MIRROR_MANIFEST` entry in `ClaudeCodeMirrorService.ts` is syntactically valid (no trailing comma issues, matches the existing entry structure).
3. Confirm the AGENTS.md skills table row is well-formed and renders correctly.
4. If the mirror service is running, confirm `.claude/skills/switchboard-remote/SKILL.md` is auto-generated from the source.
5. Skim the skill text to verify it accurately describes the Linear Remote Control workflow (three surfaces, MCP steps, pre-flight, edge cases).

---

## Out of Scope

- No changes to the Switchboard extension backend
- No changes to the Linear sync logic
- No new UI or configuration options

---

## Recommendation

Complexity 2 → **Send to Intern**
