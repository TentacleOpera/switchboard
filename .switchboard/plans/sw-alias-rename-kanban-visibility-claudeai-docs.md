# Rename /Sw → /sw, Unignore kanban-board.md, and Add Claude.ai Usage Docs

## Goal

Three related improvements for the claude.ai / Claude Code on the web experience:

1. **`/Sw` → `/sw` rename** — The `/Sw` alias was created on the assumption that mobile autocorrect would capitalize `/sw`. In practice, `/sw` is not a dictionary word so mobile does not autocorrect it. The uppercase `/Sw` is therefore the worse UX. Swap them: delete the `Sw` skill dir, create `sw`.

2. **Unignore `kanban-board.md`** — The file `.switchboard/kanban-board.md` is auto-exported by the extension on every kanban change and already referenced in the `query_switchboard_kanban` skill as the fast-path board state read. It is currently caught by the blanket `.switchboard/*` gitignore rule. Unignoring it lets cloud agents (Claude Code on the web, Jules, etc.) read current board state from the repo without needing sqlite3 access. Two places need updating: `WorkspaceExcludeService.ts` (the source for the setup.html gitignore template) and the repo's own `.gitignore`.

3. **Claude.ai docs** — Users have no discoverable docs explaining that `/sw`, `/improve-plan`, and other Switchboard workflows are available on claude.ai. Add a "Using Switchboard with claude.ai" section to the README and a full top-level section to the user manual. The key insight to communicate: `/sw` surfaces kanban state so users can then chain other workflows across multiple plans in one session.

## Metadata
**Complexity:** 3
**Tags:** docs, cli, feature, mobile

---

## Changes (8 files)

### 1. Rename `/Sw` → `/sw`

**Delete** `.claude/skills/Sw/SKILL.md` (and the `Sw/` directory).

**Create** `.claude/skills/sw/SKILL.md`:
```
This is an alias for the `switchboard-chat` skill. Immediately invoke it now using the Skill tool with skill name `switchboard-chat`.
```

No other files reference `/Sw` in the codebase (confirmed by grep + git log of commit `3eca70f`).

---

### 2. Unignore `kanban-board.md`

**`src/services/WorkspaceExcludeService.ts`** — add one line to `TARGETED_RULES` immediately after `'!.switchboard/SWITCHBOARD_PROTOCOL.md'`:
```
'!.switchboard/kanban-board.md',
```

**`.gitignore`** — add the same exclusion in the Switchboard managed block, immediately after `!.switchboard/SWITCHBOARD_PROTOCOL.md`:
```
!.switchboard/kanban-board.md
```

---

### 3. Add kanban state section to both switchboard-chat skill files

Both files get an identical new `## Kanban State` section inserted after the `## Hard Rules` block.

**Files:**
- `.agents/workflows/switchboard-chat.md`
- `.claude/skills/switchboard-chat/SKILL.md`

**Content to add:**
```markdown
## Kanban State

When the user references plans, columns, or board state (e.g. "plans in the Created column", "what's in review", "show me the board"), read `.switchboard/kanban-board.md` before responding. This file is the auto-exported markdown snapshot of the full board, updated by the extension on every change. It is the fastest way to answer column-state questions without SQL.
```

---

### 4. AGENTS.md — two edits

**Workflow Registry table** — extend the `/switchboard-chat` description to note `/sw`:
```
| `/switchboard-chat`, `/sw` | **`switchboard-chat.md`** | Activate chat consultation workflow. `/sw` is the short alias for claude.ai. (Avoid `/chat` — clashes with the native CLI reset command.) |
```

**Skills table** — add a new row:
```
| `switchboard-chat` | Enter consultative planning mode on claude.ai — type `/sw` to activate. Reads kanban state so you can reference columns and chain workflows. |
```

---

### 5. CLAUDE.md — one edit

Same Workflow Registry row update as AGENTS.md (the two files maintain identical tables):
```
| `/switchboard-chat`, `/sw` | **`switchboard-chat.md`** | Activate chat consultation workflow. `/sw` is the short alias for claude.ai. (Avoid `/chat` — clashes with the native CLI reset command.) |
```

---

### 6. `README.md` — new section after "Getting Started"

Add a new `## Using Switchboard with claude.ai` section:

```markdown
## Using Switchboard with claude.ai

All Switchboard planning workflows are available directly in [claude.ai](https://claude.ai) — no VS Code required for the planning phase.

### Quick start

Type `/sw` in any claude.ai chat to enter Switchboard's consultative planning mode. The skill reads your committed `kanban-board.md` snapshot so you can reference your board by column name:

> "What's in the Created column?"
> "Review all plans in Backlog and tell me which ones have missing dependencies."

### Chaining workflows

Once you've identified plans with `/sw`, you can run other Switchboard workflows across them in the same session:

- **`/improve-plan`** — deep-plan with adversarial review. Ask Claude to run it on every plan in a given column at once, rather than one at a time.
- **`/memo`** — capture a burst of new ideas as plan stubs without interrupting your flow.

**Example:** Open claude.ai, type `/sw`, ask "show me everything in Created", then say "run `/improve-plan` on each of those" — Claude will work through all of them in one session.
```

---

### 7. `docs/switchboard_user_manual.md` — new top-level section

Add a new section (after the existing last section, before any appendix) titled `## Using Switchboard with claude.ai`.

```markdown
## Using Switchboard with claude.ai

Switchboard's planning workflows are not limited to VS Code. You can drive the planning phase — kanban triage, plan authoring, improvement runs — entirely from [claude.ai](https://claude.ai), with the extension running locally to execute the resulting plans.

### Prerequisites

- The Switchboard extension must be open in VS Code so that `kanban-board.md` stays up to date (it is written on every board change).
- `kanban-board.md` must not be gitignored (Switchboard manages this automatically from Setup → Git Ignore Strategy → `targetedGitignore`).

### Entering planning mode: `/sw`

Type `/sw` in any claude.ai chat. This loads the Switchboard Operator persona: a consultative planner that gathers requirements, challenges assumptions, and produces implementation plans — but does not write code until you approve a plan.

Once active, the skill reads `.switchboard/kanban-board.md` so you can address your board by column:

> "What's in the Created column?"
> "Which plans in Backlog have no complexity score?"
> "Summarise everything currently in Code Reviewed."

### Available workflows on claude.ai

All slash-command workflows work on claude.ai:

| Command | What it does |
|---------|--------------|
| `/sw` | Enter consultative planning mode (Switchboard Operator) |
| `/improve-plan` | Deep-plan a draft with dependency checks and adversarial review |
| `/memo` | Capture a burst of ideas as plan stubs — exits with `process memo` |
| `/accuracy` | High-accuracy mode with self-review for precision tasks |

### Chaining: triage then bulk-improve

The most powerful pattern is to chain `/sw` with `/improve-plan` across a whole column:

1. Type `/sw` and ask Claude to list everything in a column (e.g. "show me all Created plans").
2. Claude reads `kanban-board.md` and lists the plans with titles and file paths.
3. Say "run `/improve-plan` on each of those" — Claude works through all of them in the same session, one after another, producing improved plan files it commits back to `.switchboard/plans/`.

This lets you queue up a full planning sprint from your phone or a browser tab while the local extension handles execution.
```

---

## Implementation notes

- The `kanban-board.md` gitignore exclusion only matters for the `targetedGitignore` strategy. Users on `localExclude` or `custom` manage their own rules and are unaffected.
- No migration needed — `kanban-board.md` is an auto-generated runtime file; adding it to git tracking just means cloud sessions can now see it.
- The `/sw` rename has no macOS case-collision risk: `.claude/skills/sw/` and `.claude/skills/switchboard-chat/` are distinct directory names on any filesystem.
