# Replace agent-authored project pinning with a sticky-project UI setting

## Goal

Stop asking agents to carry the project assignment. Add a board-level "sticky project for imports" toggle, have the importer consult it, and delete the PROJECT PIN directive and its ~2,785 chars of instructions from the block injected into every user's `CLAUDE.md` and `AGENTS.md`.

### Problem Analysis

**The current mechanism is a round trip through the agent for a value the extension already holds on both ends.**

`KanbanDatabase._resolveProjectForInsert` (`:2170`) is the single choke point for project assignment on plan INSERT, and its documented precedence is:

> 1. Explicit pin / caller-supplied `record.project` — always wins.
> 2. Active project at row-creation time (`kanban.activeProjectFilter` config), read ONLY on fresh INSERT — fallback when no pin.
> 3. Unassigned.

So the flow is: the extension reads `kanban.activeProjectFilter` at prompt-generation time → injects it as a PROJECT PIN directive (`agentPromptBuilder.ts:353`, restated at `TaskViewerProvider.ts:6551` and `SparkContextExporter.ts:202`) → the agent writes `**Project:** <name>` into the plan file → the plan watcher parses it back out → it lands as precedence #1. Meanwhile precedence #2 reads **the same config key** at `:2242`.

The agent's only contribution is carrying a value from one read of `kanban.activeProjectFilter` to another read of `kanban.activeProjectFilter`. The 2,785-char section in `AGENTS.md` exists to stop it corrupting the value in transit — don't pin the workspace name, don't emit a `<project>` placeholder, don't read the config yourself, say nothing when you omit the line. That is a large, permanently-resident instruction set guarding a data-transport step that need not exist.

**The two cases the mechanism actually serves are both better served by a UI setting.**

1. *The user is browsing another board and does not want plans auto-assigned to it.* This is the race the frozen-snapshot directive was invented for — the extension resolves the active project once, at prompt-generation time, so the user browsing away mid-run cannot change it. A sticky setting removes the race entirely rather than freezing it: the value changes only when the user changes it.
2. *The user wants a cloud agent to write a plan into a particular project.* Also solved: the user sets the sticky project, the cloud agent writes a plan with no project line at all, and the importer stamps it. No directive, no agent involvement, nothing for the agent to get wrong.

**And the existing fallback is itself racy.** `:2242` resolves the active filter via `getConfigSync`, the method `KanbanProvider.ts:515` documents as *"returns null while the DB is still loading at activation"* — which is why the constructor deliberately does not seed `_projectFilter` from it. A sticky value read at import time, after `dbReady`, is strictly more reliable than either the sync fallback or the agent round trip.

**The backstop already covers the failure mode the prose worries about.** `_resolveProjectForInsert` is resolve-only: an unknown pin does not auto-create a `projects` row, and on a miss the plan drops to fully unassigned. So the worst case has always been "plan lands unassigned", which the user fixes by reassigning the card. Two thousand seven hundred characters, resident on every turn of every session forever, guard an outcome that is both rare and recoverable by a drag.

### Root Cause

Project assignment was modelled as plan *content* because the plan file is the transport between the agent and the board. But project assignment is not a property of the plan the agent authored — it is a property of where the user wants it filed. Putting it in the file made the agent responsible for board state, and every subsequent rule was an attempt to constrain a responsibility it should never have had.

### Non-goals

- Removing `**Project:** <name>` *parsing*. It shipped in released versions, plans in the wild carry it, and a per-plan override is legitimate. The importer keeps reading it as precedence #1 — this plan stops *instructing agents to write it*, which is a different thing.
- Changing how projects are created. Only the user creates projects, on the board.
- Reassignment of existing plans. Unchanged — the board and the local API remain the way to move an imported plan.

## Metadata

**Complexity:** 5
**Tags:** ui, ux, backend, database, refactor, reliability

## User Review Required

Yes — two decisions.

1. **Sticky states.** Two states ("follow active filter" as today, or "pinned to `<project>`") or three (adding an explicit "always unassigned")? Recommendation: **two**. "Unassigned" is reachable by pinning to no project, and a third state invites confusion about which wins.
2. **Scope of the sticky value.** Per workspace, or global across the machine? Recommendation: **per workspace**, stored in the `config` table beside `kanban.activeProjectFilter`. Projects are per-workspace concepts (`projects` is `UNIQUE(name, workspace_id)`), so a global sticky project could name something that does not exist in the current workspace.

## Complexity Audit

### Routine

- A `kanban.stickyImportProject` config key.
- A pin/lock toggle beside the board's project filter, writing that key.
- `_resolveProjectForInsert` precedence #2 changed from "read `kanban.activeProjectFilter`" to "read `kanban.stickyImportProject`, falling back to `kanban.activeProjectFilter` when unset".
- Deleting the PROJECT PIN directive emission from `agentPromptBuilder.ts:353` and its restatements at `TaskViewerProvider.ts:6551` and `SparkContextExporter.ts:202`.
- Deleting the Plan Project Pinning section from `AGENTS.md`.

### Complex / Risky

- **`AGENTS.md` is a governance file and needs explicit approval.** Deleting 2,785 chars changes every user's injected block on next sync.
- **Three independent restatements of the pinning rule will drift if only some are removed.** `agentPromptBuilder` emits the directive, `TaskViewerProvider:6551` restates the metadata contract for a different prompt path, and `SparkContextExporter:202` restates it again for the Spark export. All three must go together, and a grep-level test should assert no fourth copy exists.
- **The memo path has its own pin handling.** `TaskViewerProvider.ts:15191` logs *"dropping PROJECT PIN '<x>': not a project in <workspace>"* — so memo processing validates pins independently. That code becomes dead or changes meaning; check whether memo-created plans should honour the sticky setting (they should) and remove the bespoke validation.
- **The importer must keep honouring an explicit pin.** Existing plan files carry `**Project:** <name>`, and the sticky setting must not override them — precedence #1 stays #1. Getting this backwards would silently re-file every previously-pinned plan on re-import.
- **Remote and tracker-created plans.** A plan created as a Linear issue or Notion page has no `**Project:**` line and no local prompt, so today it lands via precedence #2. Under this change it lands via the sticky setting, which is the desired behaviour — but confirm `importRemotePlan.ts` routes through `_resolveProjectForInsert` rather than assigning project itself.

## Edge-Case & Dependency Audit

**Race conditions**
- The sticky value is read at import time, after `dbReady`, so it does not inherit the `getConfigSync` activation race that the current fallback has. Assert the read is async.
- The user changing the sticky project while an import is in flight: last-write-wins on a single value is acceptable here, since the outcome is recoverable by reassignment.

**Security**
- Mildly positive: one less agent-writable field influencing board state.

**Side effects**
- Removing the directive shortens every dispatched planner prompt, independent of the injected-block reduction.
- The sticky setting is a new piece of board state that the `.switchboard/kanban-board.md` snapshot may want to show, so a user can see why plans are landing where they are.
- `kanban.activeProjectFilter` keeps its display role; only its import-fallback role is superseded.

**Migration**
- Additive config key, defaulting to unset, which preserves exactly today's behaviour (fall back to the active filter). No user-visible change until someone pins.
- `**Project:**` parsing is retained, so no existing plan file changes meaning. This is the migration-sensitive part: the line shipped, so it must keep being read.

## Dependencies

- **Improves** the injected-block reduction plan: that plan proposed cutting pinning to a single line honouring the directive. With the directive gone, the entire 2,785 chars go, and its target drops further.
- Otherwise independent.

## Adversarial Synthesis

**"The directive exists to solve a real race — removing it reintroduces the bug."** It solves the race by freezing a value at prompt-generation time. A sticky setting has no race to freeze: the value changes only on user action. The frozen snapshot is a workaround for reading live board state; the fix is not to read live board state.

**"Agents sometimes should decide the project — they have context the UI doesn't."** They have the user's words, which is the one case worth keeping: if a user says "put this in the Backend project", the agent writing `**Project:** Backend` is right, and parsing stays. What is being removed is the agent transcribing board state, not the agent honouring an instruction.

**"A UI toggle is more work than a prompt line."** It is, once. The prompt line costs ~2,785 resident chars per turn per session per workspace forever, plus three restatements to keep in sync, plus a bespoke memo validation path, plus the class of bug where an agent invents a pin. The toggle is a config key and a button.

**"Just delete the prose and keep the directive."** Tempting and half-right — the prose is the expensive part. But the directive is what makes the prose necessary: once an agent is handed a value and told to write it, rules about not mangling it follow. Removing the responsibility removes the rules.

## Proposed Changes

1. **`kanban.stickyImportProject` config key**, per workspace, unset by default.
2. **Board UI**: a pin toggle beside the project filter — "follow active filter" / "pinned to `<project>`" — writing that key, and visible enough that a user can tell why plans are landing where they are.
3. **`_resolveProjectForInsert` precedence #2** reads the sticky key, falling back to `kanban.activeProjectFilter` when unset. Precedence #1 (explicit pin) and #3 (unassigned) unchanged. Read async, not via `getConfigSync`.
4. **Delete the PROJECT PIN directive** at `agentPromptBuilder.ts:353` and its restatements at `TaskViewerProvider.ts:6551` and `SparkContextExporter.ts:202`.
5. **Delete** the Plan Project Pinning section from `AGENTS.md` (governance file — explicit approval required).
6. **Memo path**: remove the bespoke pin validation at `TaskViewerProvider.ts:15191` and route memo-created plans through the same resolution.
7. **Retain** `**Project:** <name>` parsing as precedence #1, for existing files and for a user-instructed pin.

### Migration

Additive and behaviour-preserving until a user pins. `**Project:**` parsing retained so no existing plan file changes meaning.

## Verification Plan

### Goal Invariants

- No prompt emitted by any path contains the words "PROJECT PIN".
- `AGENTS.md` contains no Plan Project Pinning section, and the emitted managed block shrinks by ~2,785 chars.
- `**Project:** <name>` in a plan file still resolves to that project on import.

### Automated Tests

- **Sticky wins over active filter:** set sticky to A, active filter to B, import a plan with no project line; assert it lands in A.
- **Explicit pin still wins:** with sticky set to A, import a plan carrying `**Project:** B`; assert B. This is the regression that would silently re-file every previously-pinned plan if precedence were inverted.
- **Unset preserves today's behaviour:** sticky unset, active filter B, import; assert B.
- **Resolve-only intact:** sticky set to a non-existent project; assert the plan lands unassigned and no `projects` row is created.
- **No activation race:** import during DB load; assert resolution waits for `dbReady` rather than reading a null sync value.
- **Directive removal is complete:** grep-level assertion that no prompt-generating path emits "PROJECT PIN", covering the add-on matrix — the three known sites are in different prompt paths and a default-config test would miss at least one.
- **Remote plans:** import a plan created as a Linear issue with no project line; assert it honours the sticky setting, confirming `importRemotePlan.ts` routes through `_resolveProjectForInsert`.
- **Memo plans:** process a memo entry; assert the resulting plan honours the sticky setting and no bespoke validation path remains.
- **Block size:** assert the emitted managed block shrank, tying this to the reduction plan's size gate.

## Outstanding Questions

- Does `importRemotePlan.ts` assign project itself, or route through `_resolveProjectForInsert`? Determines whether change 3 covers the remote path or needs a second edit.
- Should the sticky project appear in `.switchboard/kanban-board.md` so agents and users can see the current filing target? Leaning yes for diagnosability, but it adds a field to a snapshot other things parse.
- Is there a fourth restatement of the pinning contract? Three were found; the grep-level test is the guard, but the count is worth confirming before deleting.
