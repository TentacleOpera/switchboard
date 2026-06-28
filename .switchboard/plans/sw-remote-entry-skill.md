# Add /sw-remote Entry Skill for Remote Switchboard Sessions

## Goal

Create a `/sw-remote` skill that serves as the entry point for remote Switchboard planning sessions (Claude Code web, claude.ai). It orients the agent to the remote-mode workflow: plans live in Linear/Notion, MCP is the control surface, git is not used for planning, and `/improve-remote-plan` replaces `/improve-plan`.

### Problem & Background

The existing `/sw` (switchboard-chat) skill assumes the agent can read `.switchboard/plans/`, write plan files, and trigger column transitions — all of which require the local machine and VS Code extension to be active. There is also an existing stub plan `add-switchboard-remote-skill.md` that covers basic Linear orientation, but it only addresses the "dispatch" use case (writing a plan then triggering execution). It does not cover the async improvement workflow or the startup reconciler pattern.

`/sw-remote` is a full peer to `/sw` for remote contexts. It replaces the stub orientation approach with a complete entry-point skill that knows about the remote planning stack. `/sw` is unchanged — it remains the correct entry point for users without remote integration.

Per the parent Epic (`epic-remote-planning-infrastructure.md`), `/sw-remote` must **absorb/supersede** the already-shipped `switchboard_remote_notion.md` skill rather than parallel it, to prevent orientation drift. The existing skill's "how the loop works" + "pre-flight" + "steps" content is the source of truth for the Notion branch and should be folded into `/sw-remote`.

---

## Metadata

**Tags:** cli, infrastructure, feature, docs
**Complexity:** 3

---

## User Review Required

Yes — before implementation, the user should confirm:

1. **Workflow vs skill placement**: `/sw-remote` is listed in the Workflow Registry table (like `/sw`), so its source file lives in `.agents/workflows/sw-remote.md` and is mirrored to `.claude/skills/sw-remote/SKILL.md` via the `ClaudeCodeMirrorService`. Confirm this placement is acceptable vs. placing it as a skill in `.agents/skills/`.
2. **Notion skill supersession**: The already-shipped `switchboard_remote_notion.md` skill (in `.agents/skills/`, in the MIRROR_MANIFEST at line 57, in the AGENTS.md Available Skills table) will be absorbed into `/sw-remote` and removed from the MIRROR_MANIFEST. Its source file will be archived as `switchboard_remote_notion.md.migrated.bak` per migration policy. Confirm this consolidation is acceptable — users who currently invoke `/switchboard-remote-notion` will need to switch to `/sw-remote`.
3. **Stub plan supersession**: `add-switchboard-remote-skill.md` will be marked as superseded by this plan. Confirm.

---

## Complexity Audit

### Routine
- Creating a single Markdown workflow file (`.agents/workflows/sw-remote.md`) — prose/orientation content following the existing `switchboard-chat.md` pattern
- Adding one entry to the `MIRROR_MANIFEST` array in `ClaudeCodeMirrorService.ts` (line 41)
- Adding one row to the Workflow Registry table and one row to the Available Skills table in `AGENTS.md`
- Archiving one superseded skill file (`.agents/skills/switchboard_remote_notion.md` → `.migrated.bak`)
- Marking one stub plan as superseded
- All content is derived from existing documentation (the notion skill, the stub plan, the Epic's research findings)

### Complex / Risky
- Removing `switchboard_remote_notion` from the MIRROR_MANIFEST is a shipped-content change — the mirrored `.claude/skills/switchboard-remote-notion/SKILL.md` will no longer be regenerated on future mirror runs. Existing user setups may retain a stale copy until the mirror service cleans it up. This is low-risk (documentation only) but should be noted.

---

## Edge-Case & Dependency Audit

**Race Conditions:** None — this is a static documentation/orientation file with no runtime behavior.

**Security:** No security implications. The skill text references Linear/Notion MCP operations but does not contain tokens, credentials, or sensitive configuration. MCP tokens stay host-side (the existing `linear_api.md` / `notion_api.md` skills never expose tokens to the agent).

**Side Effects:**
- Adding the MIRROR_MANIFEST entry triggers `ClaudeCodeMirrorService` to create a mirrored copy at `.claude/skills/sw-remote/SKILL.md` on the next mirror run. This is the intended behavior and matches the existing workflow entries.
- Removing the `switchboard_remote_notion` MIRROR_MANIFEST entry stops regeneration of the old mirrored skill. The old `.claude/skills/switchboard-remote-notion/` directory may persist in existing setups until cleaned up by a future mirror run (the mirror service only writes entries in the manifest; it does not proactively delete removed entries).

**Dependencies & Conflicts:**
- Depends on the `/improve-remote-plan` sibling skill (`improve-remote-plan-skill.md`) — `/sw-remote` orients the agent to use it instead of `/improve-plan` for remote sessions.
- Depends on the already-shipped `RemoteControlService` + `LinearRemoteProvider` / `NotionRemoteProvider` and the persisted cursor keys. The skill itself has no code dependency — it is pure documentation.
- The naming convention must match the existing mirror patterns: underscore in `.agents/skills/` source filenames, kebab-case in MIRROR_MANIFEST `name` field and `.agents/workflows/` filenames.
- **No conflict with `/sw`**: `/sw-remote` is explicitly additive — `/sw` remains the entry point for local sessions.

---

## Dependencies

- `improve-remote-plan-skill.md` — sibling plan: new `/improve-remote-plan` skill (Complexity 3). `/sw-remote` orients agents to use it.
- `epic-remote-planning-infrastructure.md` — parent Epic. Provides research-confirmed MCP tool names and Notion write-safety caveats that `/sw-remote` must reference.
- `add-switchboard-remote-skill.md` — superseded stub plan. Its orientation content is folded into `/sw-remote`.
- `.agents/skills/switchboard_remote_notion.md` — shipped skill to be absorbed/superseded.

---

## Adversarial Synthesis

Key risks: (1) writing directly to `.claude/skills/sw-remote/SKILL.md` instead of the `.agents/workflows/` source would cause the file to be overwritten on the next mirror run — the source must go through the MIRROR_MANIFEST; (2) registering in CLAUDE.md instead of AGENTS.md would be overwritten by the embedded protocol block — AGENTS.md is the single source; (3) removing `switchboard_remote_notion` from the manifest without archiving the source violates the migration policy for shipped content. Mitigations: author in `.agents/workflows/sw-remote.md`, add a MIRROR_MANIFEST entry, register in AGENTS.md, archive the notion source as `.migrated.bak`.

---

## Proposed Changes

### `.agents/workflows/sw-remote.md` (NEW FILE)

**Context:** This is the canonical source file for the `/sw-remote` workflow, following the same pattern as `.agents/workflows/switchboard-chat.md`. The `ClaudeCodeMirrorService` will mirror it to `.claude/skills/sw-remote/SKILL.md` for Claude Code compatibility. **Clarification:** The original plan specified `.claude/skills/sw-remote/SKILL.md` as the creation path — this is incorrect per the mirror service invariant #1 (`.agents/` is the single source of truth; `.claude/` is generated). The source must be in `.agents/workflows/`.

**Frontmatter** (matching the workflow pattern — `description` only; `name` is derived from the MIRROR_MANIFEST entry):
```yaml
---
description: Entry point for remote Switchboard planning sessions — orients Claude to use Linear/Notion MCP instead of local files
---
```

**Implementation — Required content sections:**

**1. Confirm remote context**
- Check which MCP servers are connected (Linear, Notion, GitHub)
- Report what's available and note any missing connections (e.g., if neither Linear nor Notion is connected, warn the user that remote planning won't be possible)

**2. Orient on remote-mode rules**
Communicate the following to the agent's working context:
- Plans are stored in Linear/Notion — do NOT write `.md` files to `.switchboard/plans/` or commit to a branch for planning work
- Use `list_issues` (Linear) / Notion database queries to read the current kanban state (not local `kanban.db` or `kanban-board.md`)
- To improve a plan: use `/improve-remote-plan` (not `/improve-plan`)
- To create a new plan: write directly to a new Linear issue or Notion page, set status to "Created"
- Column transitions happen via status updates in Linear/Notion — the extension picks them up on next IDE startup via the startup reconciler
- To trigger local execution: set the Linear/Notion status to the execution-trigger state (confirm the name with `list_issue_statuses` first for Linear; read the `Kanban Column` select options for Notion)

**3. Read current board state**
- Query Linear/Notion for issues in the Switchboard-mapped project, grouped by status
- Present a brief summary: how many plans per column, any plans in a state that suggests remote action is needed (e.g., "Created" plans that could be improved)

**4. Prompt for intent**
After orientation, ask: "What would you like to work on?" — same consultative opening as `/sw`.

**5. Architecture overview (absorbed from `switchboard_remote_notion.md`)**
- Linear is a two-way sync message bus: Switchboard polls Linear every 30–120s (configurable) and mirrors state changes locally
- Moving a Linear issue to a new state → dispatches the Kanban column agent for that state on the local machine
- Comments posted on a Linear issue → routed to the current column's agent as input
- Notion equivalent: Switchboard polls the plans DB + Comments DB on a timer; `Kanban Column` property drives column mapping; "Switchboard Comments" database is the async message bus
- Config is stored in the Kanban DB under key `remote.config`, not in `settings.json`; toggle is in the toolbar remote control button; configuration is in the Kanban REMOTE tab

**6. Pre-flight (absorbed from `switchboard_remote_notion.md`)**
- Remote Control must be enabled with the correct provider (Linear or Notion) and the board mapped in the Switchboard Remote tab
- For Notion: the one-time "Run Notion setup sync" must have been run (creates the plans DB, Comments DB, and matches column options)
- For Linear: confirm the correct project is mapped

**Edge Cases (preserved from original plan):**
- **Neither Linear nor Notion connected**: Skill should degrade gracefully — explain the limitation and offer to fall back to `/sw` if the user has local access
- **Multiple boards mapped**: If multiple Switchboard projects exist in Linear, the skill must guide the user to identify the correct one using `list_projects`
- **User accidentally uses `/sw` in a remote session**: Not a hard error, but `/sw` will try to read local files that don't exist. The skill file for `/sw` could add a note pointing to `/sw-remote` for remote contexts
- **Status name drift**: Linear status names can be renamed by the user. The skill should always use `list_issue_statuses` rather than assuming names from prior sessions
- **Read-back latency**: Results written by the local agent appear in the Linear issue / Notion page after the next sync cycle (up to 30–120s depending on poll frequency). The skill should note this when checking results in a follow-up session

### `src/services/ClaudeCodeMirrorService.ts` (EDIT — MIRROR_MANIFEST, line 41)

**Context:** The `MIRROR_MANIFEST` array controls which `.agents/` files get mirrored to `.claude/skills/`. The existing `switchboard-chat` workflow entry is at line 46. The new `/sw-remote` workflow needs a parallel entry. **Clarification:** The original plan omitted this step entirely — without a MIRROR_MANIFEST entry, the skill file in `.agents/workflows/` would never be mirrored to `.claude/skills/`.

**Logic:** Add a new entry adjacent to the `switchboard-chat` workflow entry:

```typescript
{ source: 'workflows/sw-remote.md', name: 'sw-remote', invocation: 'default' },
```

**Also:** Remove the existing `switchboard_remote_notion` entry (lines 57–60) since its content is absorbed into `/sw-remote`:

```typescript
// REMOVE:
{
    source: 'skills/switchboard_remote_notion.md', name: 'switchboard-remote-notion', invocation: 'no-model',
    descriptionFallback: 'Orient a claude.ai session on driving a Switchboard board through Notion via the Notion MCP connector (Remote Control).'
},
```

**Edge Cases:**
- `invocation: 'default'` matches the `switchboard-chat` workflow — the skill is both slash-invokable and model-auto-invokable.
- Removing the notion entry means the mirrored `.claude/skills/switchboard-remote-notion/SKILL.md` will no longer be regenerated. Existing copies in user setups may persist until cleaned up by a future mirror run.

### `AGENTS.md` (EDIT — Workflow Registry + Available Skills tables)

**Context:** The Workflow Registry table and the Available Skills table in `AGENTS.md` are the registration surfaces. `CLAUDE.md` embeds `AGENTS.md` content via the `<!-- switchboard:agents-protocol:start -->` markers, so adding to `AGENTS.md` automatically surfaces it in `CLAUDE.md`. **Clarification:** The original plan said to register in CLAUDE.md — this is incorrect; CLAUDE.md's protocol block is generated from AGENTS.md and would be overwritten.

**Logic — Workflow Registry table:** Add a row:
```
| `/sw-remote` | **`sw-remote.md`** | Remote session entry point — Linear/Notion MCP planning mode |
```

**Logic — Available Skills table:** Add a row:
```
| `sw-remote` | Entry point for remote Switchboard sessions — orients Claude to Linear/Notion MCP workflow. Use instead of /sw when local machine is off. |
```

**Also:** Remove the `switchboard_remote_notion` row from the Available Skills table since it is superseded by `sw-remote`.

### `.agents/skills/switchboard_remote_notion.md` (SUPERSEDE — archive)

**Context:** This shipped skill's content is absorbed into `/sw-remote`'s architecture overview and pre-flight sections. Per the migration policy for shipped content, archive rather than delete.

**Logic:** Rename `.agents/skills/switchboard_remote_notion.md` → `.agents/skills/switchboard_remote_notion.md.migrated.bak`.

### `.switchboard/plans/add-switchboard-remote-skill.md` (SUPERSEDE — mark)

**Context:** The stub plan covered basic Linear orientation only. Its content is folded into `/sw-remote`.

**Logic:** Add a superseded marker at the top of the file:
```markdown
> **SUPERSEDED** by `sw-remote-entry-skill.md`. The orientation content has been folded into the `/sw-remote` workflow.
```

---

## Verification Plan

### Automated Tests

Per session directives, automated tests are **not run** in this planning pass — the suite will be run separately by the user. The following describes what to verify when implementation lands:

- **Skill existence check**: assert `.agents/workflows/sw-remote.md` exists and `.claude/skills/sw-remote/SKILL.md` is auto-generated from the source after a mirror run.
- **MIRROR_MANIFEST validation**: assert the `sw-remote` entry is present in `MIRROR_MANIFEST` and the `switchboard-remote-notion` entry is removed. A regression test that asserts the exact manifest contents (similar to `git-ignore-custom-default-regression.test.js`) should be updated.
- **AGENTS.md table check**: assert the Workflow Registry and Available Skills tables in `AGENTS.md` contain the `sw-remote` entries and no longer contain `switchboard_remote_notion`.
- **Archive check**: assert `.agents/skills/switchboard_remote_notion.md.migrated.bak` exists and `.agents/skills/switchboard_remote_notion.md` does not.

### Manual Verification

1. Invoke `/sw-remote` in a remote session (claude.ai with Linear or Notion MCP connected) — confirm orientation text appears, board state is queried, and the "What would you like to work on?" prompt is shown.
2. Invoke `/sw-remote` with no MCP connected — confirm graceful degradation message and fallback suggestion to `/sw`.
3. Confirm the absorbed Notion content (loop description, pre-flight, steps) is accurate and consistent with the archived `switchboard_remote_notion.md.migrated.bak`.

---

## Out of Scope

- Modifying `/sw` (switchboard-chat) — it stays unchanged for local sessions
- ClickUp support (follow-on after Linear/Notion)
- Auto-detecting remote vs local context (user explicitly invokes `/sw-remote`)
- The `/improve-remote-plan` skill itself (covered by sibling plan `improve-remote-plan-skill.md`)
- The startup reconciler (covered by sibling plan `kanban-startup-reconciler.md`)

---

## Recommendation

Complexity 3 → **Send to Intern**
