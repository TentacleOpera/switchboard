# Replace agent-authored project pinning with a sticky-project UI setting

## Goal

Stop asking agents to carry the project assignment. Add a board-level "sticky project for imports" toggle, have the importer consult it, and delete the PROJECT PIN directive and its ~2,785 chars of instructions from the block injected into every user's `CLAUDE.md` and `AGENTS.md`.

### Problem Analysis

**The current mechanism is a round trip through the agent for a value the extension already holds on both ends.**

`KanbanDatabase._resolveProjectForInsert` (`:2170`) is the single choke point for project assignment on plan INSERT, and its documented precedence is:

> 1. Explicit pin / caller-supplied `record.project` — always wins.
> 2. Active project at row-creation time (`kanban.activeProjectFilter` config), read ONLY on fresh INSERT — fallback when no pin.
> 3. Unassigned.

So the flow is: the extension reads `kanban.activeProjectFilter` at prompt-generation time → injects it as a PROJECT PIN directive (`agentPromptBuilder.ts:353`, restated at `TaskViewerProvider.ts:6670` and `SparkContextExporter.ts:202`) → the agent writes `**Project:** <name>` into the plan file → the plan watcher parses it back out → it lands as precedence #1. Meanwhile precedence #2 reads **the same config key** at `:2242`.

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
- Deleting the PROJECT PIN directive emission from `agentPromptBuilder.ts:2400` and `TaskViewerProvider.ts:6683`, and the restatements at `TaskViewerProvider.ts:6670` and `SparkContextExporter.ts:202`.
- Deleting the Plan Project Pinning section from `AGENTS.md`.

### Complex / Risky

- **`AGENTS.md` is a governance file and needs explicit approval.** Deleting 2,785 chars changes every user's injected block on next sync.
- **Three independent restatements of the pinning rule will drift if only some are removed.** `agentPromptBuilder` emits the directive, `TaskViewerProvider:6670` restates the metadata contract for a different prompt path, and `SparkContextExporter:202` restates it again for the Spark export. All three must go together, and a grep-level test should assert no fourth copy exists.
- **The memo path has its own pin handling.** `TaskViewerProvider.ts:15347` logs *"dropping PROJECT PIN '<x>': not a project in <workspace>"* — so memo processing validates pins independently. That code becomes dead or changes meaning; check whether memo-created plans should honour the sticky setting (they should) and remove the bespoke validation.
- **The importer must keep honouring an explicit pin.** Existing plan files carry `**Project:** <name>`, and the sticky setting must not override them — precedence #1 stays #1. Getting this backwards would silently re-file every previously-pinned plan on re-import.
- **Remote and tracker-created plans.** A plan created as a Linear issue or Notion page has no `**Project:**` line and no local prompt, so today it lands via precedence #2. Under this change it lands via the sticky setting, which is the desired behaviour — but confirm `importRemotePlan.ts` routes through `_resolveProjectForInsert` rather than assigning project itself.

## Edge-Case & Dependency Audit

**Race conditions**
- The sticky value is read at import time, after `dbReady`, so it does not inherit the `getConfigSync` activation race that the current fallback has. The async `getConfig` method already exists at `KanbanDatabase.ts:5485` — use it, not `getConfigSync` (`:5541`).
- The user changing the sticky project while an import is in flight: last-write-wins on a single value is acceptable here, since the outcome is recoverable by reassignment.

**Security**
- Mildly positive: one less agent-writable field influencing board state.

**Side effects**
- Removing the directive shortens every dispatched planner prompt, independent of the injected-block reduction.
- The sticky setting is a new piece of board state that the `.switchboard/kanban-board.md` snapshot may want to show, so a user can see why plans are landing where they are.
- `kanban.activeProjectFilter` keeps its display role; only its import-fallback role is superseded.
- `.claude/skills/` mirrors (`switchboard-cloud`, `switchboard-memo`) are stale on existing installs until the next activation regenerates them from the edited `.agents/workflows/` sources. This is the standard mirror lifecycle — no special migration needed, but the grep-level test must not assert against `.claude/skills/` content.

**Migration**
- Additive config key, defaulting to unset, which preserves exactly today's behaviour (fall back to the active filter). No user-visible change until someone pins.
- `**Project:**` parsing is retained, so no existing plan file changes meaning. This is the migration-sensitive part: the line shipped, so it must keep being read.

## Dependencies

- **Improves** the injected-block reduction plan: that plan proposed cutting pinning to a single line honouring the directive. With the directive gone, the entire 2,785 chars go, and its target drops further.
- Otherwise independent.

## Adversarial Synthesis

Key risks: (1) incomplete directive removal — the blast radius is 12 source surfaces across code, workflows, protocols, and governance files, and a missed emission site silently leaves the directive in one prompt path; the grep-level test is the guard. (2) Precedence inversion — if the sticky key accidentally outranks an explicit `**Project:**` pin, every previously-pinned plan silently re-files on re-import; the contract test asserting "explicit pin wins over sticky" is load-bearing. (3) The `manifestProject` field must become vestigial, not deleted — two `KanbanProvider` callers thread it, and deleting the field breaks compilation. Mitigations: enumerated blast radius with emission call sites, vestigial-field precedent (`destinationColumn`), and the retained `**Project:**` parsing as precedence #1.

## Proposed Changes

1. **`kanban.stickyImportProject` config key**, per workspace, unset by default. Written via `KanbanDatabase.setConfig` (async, same method `setProjectFilter` uses at `KanbanProvider.ts:8037`).
2. **Board UI**: a pin/lock toggle beside the project filter dropdown in `kanban.html` (beside `#kanban-project-filter`). Two states: "follow active filter" (unset) / "pinned to `<project>`". The toggle sends a new `setStickyImportProject` message via `postKanbanMessage`, handled in `KanbanProvider.handleServiceVerb` (alongside the existing `setProjectFilter` handler at `:9471`), which calls `setConfig('kanban.stickyImportProject', value)`. The board pushes the current sticky state to the webview in the refresh data cluster (like `projectFilter` at `kanban.html:10121`) so the toggle stays synced. The toggle must be visible enough that a user can tell why plans are landing where they are — a lock icon on the filter dropdown with a tooltip is the minimum.
3. **`_resolveProjectForInsert` precedence #2** reads the sticky key via async `getConfig` (`KanbanDatabase.ts:5485`), falling back to `kanban.activeProjectFilter` when unset. Precedence #1 (explicit pin) and #3 (unassigned) unchanged. Only `:2242` changes — the other `getConfigSync` calls at `:3863` (project deletion reset) and `:9259` (mirror serialization) are unrelated and stay sync.
4. **Delete the PROJECT PIN directive and every restatement.**

   > **Superseded:** nine authoring surfaces, ~11 statements.
   > **Reason:** Code investigation found two additional emission call sites and one import the original count missed. The actual blast radius is larger.
   > **Replaced with:** the enumerated list below — 12 source surfaces across code, workflows, protocols, and governance files.

   **Code — emission sites (the calls that produce the directive text):**
   - `agentPromptBuilder.ts:2400-2401` — `if (options?.manifestProject) { projectPinBlock = PROJECT_LINE_DIRECTIVE(...) }` — the main prompt builder emission
   - `TaskViewerProvider.ts:6683` — `prompt += '\n\n' + PROJECT_LINE_DIRECTIVE(projectName)` — the memo prompt builder emission (missed in the original count)
   - `TaskViewerProvider.ts:83` — the `PROJECT_LINE_DIRECTIVE` import (must be removed when the function is deleted)

   **Code — directive definition and planner rules:**
   - `agentPromptBuilder.ts:353-354` — the `manifestProject` field declaration
   - `agentPromptBuilder.ts:1438` — planner rule 5 (mentions `**Project:**` per PROJECT PIN directive)
   - `agentPromptBuilder.ts:1441` — planner rule 8 (Project Pinning rule)
   - `agentPromptBuilder.ts:1456-1457` — the `PROJECT_LINE_DIRECTIVE` function itself

   **Code — metadata template restatements:**
   - `TaskViewerProvider.ts:6670` — memo plan template metadata line referencing the PROJECT PIN directive
   - `SparkContextExporter.ts:202` — Spark context project-pinning convention

   **Workflows and protocols (content files, not code):**
   - `.agents/workflows/switchboard-cloud.md:15` and `:18` — plan artifact rule 5 and Project Pinning rule 8
   - `.agents/workflows/switchboard-memo.md:53` — memo plan creation step referencing PROJECT PIN directive
   - `.agents/protocols/improve-plan/SKILL.md:45` — Project Pinning subsection
   - `.agents/protocols/improve-feature/SKILL.md:33` — Project Pinning subsection

   **Derived mirrors (regenerate automatically — do NOT edit by hand):**
   - `.claude/skills/switchboard-cloud/SKILL.md` and `.claude/skills/switchboard-memo/SKILL.md` are generated from the `.agents/workflows/` sources by `ClaudeCodeMirrorService` (`src/services/ClaudeCodeMirrorService.ts`) at activation. Editing the `.agents/` sources suffices; the mirrors regenerate on next activation. The grep-level test must scope to `.agents/` + `src/`, not `.claude/skills/` (which is derived and stale until regeneration).

5. **Make `manifestProject` vestigial, not deleted.** The `manifestProject` field on the prompt-builder options (`agentPromptBuilder.ts:354`) is threaded from two caller sites: `KanbanProvider.ts:1491` and `KanbanProvider.ts:10998`. Deleting the field would break these callers (TypeScript compile error). Instead, follow the precedent of `destinationColumn` (`:355`, already vestigial with a doc-comment saying so): retain the field, stop emitting the directive (change 4 removes the emission at `:2400`), and update the doc-comment to say "Vestigial — formerly drove the PROJECT PIN directive, which was removed. Retained for caller compatibility." The two `KanbanProvider` callers continue passing `resolvedProject` harmlessly; a later cleanup can remove the threading. `resolveAuthoringProject` itself is NOT deleted — it still serves dispatch scoping (`analysisScope`), feature creation (`KanbanProvider.ts:14759`), and the memo/clipboard/Spark paths that need the active project for non-directive purposes.

6. **Delete** the Plan Project Pinning section from `AGENTS.md` and `CLAUDE.md` (governance files — explicit approval required). The AGENTS.md section is ~2,831 chars; the CLAUDE.md section is ~2,606 chars (measured, not estimated).

7. **Memo path**: the bespoke pin validation at `TaskViewerProvider.ts:15336-15349` resolves the project name to pass to the memo planner prompt, which appends it as a `PROJECT_LINE_DIRECTIVE` (`:6683`). With the directive deleted (change 4), the memo prompt no longer needs a `projectName`, so the entire `:15336-15349` resolution block becomes dead code — remove it and drop the `projectName` parameter from `_buildMemoPlannerPrompt`. The memo plan template line at `:6670` currently says "include `**Project:**` ONLY if a PROJECT PIN directive is present below" — replace with: "include `**Project:** <name>` ONLY if the user explicitly named a project in the memo entry. Otherwise omit the line." This preserves the user-instructed pin without referencing the deleted directive. Memo-created plans (the `.md` files the agent writes) already honour the sticky setting via change 3: they land through the file watcher → `insertFileDerivedPlan` → `_resolveProjectForInsert`, which consults the sticky key. No bespoke memo-side resolution is needed.

8. **Retain** `**Project:** <name>` parsing as precedence #1, for existing files and for a user-instructed pin.

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
- **Directive removal is complete:** two grep assertions: (a) no `PROJECT_LINE_DIRECTIVE` symbol remains anywhere in `src/` (function, import, call — all gone); (b) no "PROJECT PIN" string in `src/services/` prompt-generating code. Scope the content-file grep to `.agents/` + `AGENTS.md` + `CLAUDE.md` — NOT `.claude/skills/` (derived mirrors, stale until regeneration) and NOT `src/test/` or `.github/workflows/` (test names legitimately reference the old contract). The two emission call sites (`agentPromptBuilder.ts:2400` and `TaskViewerProvider.ts:6683`) are in different prompt paths; a default-config test would miss at least one.
- **Remote plans:** import a plan created as a Linear issue with no project line; assert it honours the sticky setting, confirming `importRemotePlan.ts` routes through `_resolveProjectForInsert`.
- **Memo plans:** process a memo entry; assert the resulting plan honours the sticky setting, no bespoke validation path remains, and `_buildMemoPlannerPrompt` no longer takes a `projectName` parameter.
- **Block size:** assert the emitted managed block shrank by ~2,831 chars (AGENTS.md) and ~2,606 chars (CLAUDE.md), tying this to the reduction plan's size gate.

**Existing tests this plan must rewrite, not just satisfy.** Two contract tests already pin the current pinning behaviour and will fail by design:
- `src/test/project-pin-resolve-contract.test.js` (`npm run test:contract:project-pin-resolve`) — resolution precedence
- `src/test/project-pin-apply-if-empty-contract.test.js` (`npm run test:contract:project-pin-fill`) — apply-if-empty semantics

Two more reference the pinning prose and need updating in the same commit: `src/test/spark-context-exporter-contract.test.js` and `src/test/memo-panel-workspace-binding-contract.test.js`. Rewriting these is the honest signal that the contract changed; silently deleting them is not — the new sticky precedence deserves the same pinning the old one had.

## Outstanding Questions

- **Resolved — the remote path needs no second edit.** `importRemotePlan.ts:31` passes `project: ''`, but that is only the input: it calls `insertFileDerivedPlan` (`KanbanDatabase.ts:2387`), which invokes `_resolveProjectForInsert` at `:2403`. So remote-imported plans already resolve their project in the DB with no agent involvement — change 3 covers them for free. This is worth naming as precedent rather than scope: the remote path is already the architecture this plan is arguing for, and it has not caused a pinning bug.
- **Resolved — 12 source surfaces, not nine.** The contract is restated at 12 source surfaces (listed in change 4) plus two dedicated contract tests. Code investigation found two emission call sites the original count missed (`agentPromptBuilder.ts:2400` and `TaskViewerProvider.ts:6683`) plus the import at `TaskViewerProvider.ts:83`. This cuts both ways: it is a larger edit than estimated, and it is much stronger evidence for the plan's thesis — a rule needing twelve synchronised restatements across code, prompts, workflows, protocols and governance files is not a rule an agent should be carrying at all. The grep-level test stays the guard, since the count is exactly what drifts.
- Should the sticky project appear in `.switchboard/kanban-board.md` so agents and users can see the current filing target? Leaning yes for diagnosability, but it adds a field to a snapshot other things parse. Proceeding on the assumption that it should NOT be added in this plan — the snapshot is read by agents and parsed by tooling, and a new field risks breaking consumers. The board UI toggle (change 2) is the user-facing surface; the snapshot can be extended in a follow-up if diagnosability is needed.

## Recommendation

**Send to Coder.** Complexity 5 (mixed: routine config key + UI toggle, moderate multi-file directive sweep across 12 surfaces). The directive removal is mechanical but wide — the grep-level test and the two rewritten contract tests are the guardrails. The sticky-setting logic is a single precedence change in one method.
