---
description: 'Orchestration Automation Mode — unattended coding + code-review batching via a system-woken orchestrator'
---

# Orchestration Automation Mode

**Complexity:** 7
**Tags:** backend, feature, automation, ui


## Goal

Add a fourth kanban automation mode — **Orchestration** — that runs a batch of work through the coding and code-review stages unattended, managed by an **orchestrator agent** that the *system* wakes on a fixed interval (never self-scheduling). The user picks Orchestration in the AUTOMATION tab, presses Start, and the orchestrator batches every eligible plan into features, fans the work out across per-feature worktrees and terminals, then sleeps. On each interval tick the system wakes it to check progress, triage agent requests, and advance or merge work — feature by feature — until the batch is done.

### Problem / background / root cause

Switchboard already automates dispatch, but only **reactively and per-card**: the autoban engine (`src/services/autobanState.ts`, modes `single-column | multi-column | antigravity-batch`) fires a column's agent as cards move, and `PipelineOrchestrator` advances one plan per tick. Neither expresses *managed batch execution* — "take everything in Plan Reviewed, code it, review it, and merge it back, coordinating across many worktrees." There is no actor that groups loose work, fans it out with a concurrency ceiling, verifies completion against ground truth, handles agent questions, and drives merges to conclusion. Today a human does that choreography by hand: grouping plans, creating worktrees, dispatching each terminal, checking in, and merging branch by branch.

The insight that makes this cheap to build: **almost every primitive already exists.** The autoban engine already has an interval tick with `lastTickAt` tracking (the wake mechanism), `group-into-features` already clusters loose plans into features, the worktree system already auto-creates per-feature integration/subtask worktrees and terminals, and the `merge-prompt` design already defines agent-driven, conflict-resolving merges (subtask → integration → main). What is missing is (a) a mode that wires these together, (b) one new comms primitive — a file-based agent→orchestrator request channel plus a session log — and (c) an orchestrator persona. The orchestrator operates the board through the same LocalApiServer operations a human clicks, and it trusts **git/board state**, not agent self-report, as the signal of truth.

**Scope discipline:** Orchestration automates **coding and code review only**. Planning stays human-in-the-loop — most agent questions/warnings/research needs arise at the planner stage, and those escalate to the human rather than being auto-resolved. If a user wants a planning pass or a curated grouping first, they do it manually before starting automation.

## Design overview

Orchestration is a new `automationMode: 'orchestration'` on the existing autoban engine, plus a small comms layer and an orchestrator workflow.

**Flow:**
1. **Select mode** — the AUTOMATION tab gains an *Orchestration* option and a **Start orchestrator** button. Selecting the mode **auto-enables worktree-per-feature** (`feature_worktree_mode`), because per-feature worktrees are the unit of parallelism and the merge topology. *(Correction from plan review: the concrete config value is `'per-subtask'` — valid values are `'none' | 'per-subtask' | 'high-low'` (`KanbanProvider.ts:9176`); there is no literal `'per-feature'`. `'per-subtask'` is what produces the per-feature integration branch + per-subtask worktree topology this feature merges through.)*
2. **Start → batch** — the orchestrator terminal launches and runs the existing `group-into-features` skill with the **confirm gate disabled** (unattended). Unlike the interactive skill, it also sweeps every remaining standalone plan into a single **`Miscellaneous`** feature, so nothing is left ungrouped. The system auto-creates each feature's worktrees and terminals.
3. **Fan out** — the orchestrator dispatches each feature's subtasks into their terminals by stage (code → code review), then **sleeps**. It does not hold the fleet in-context.
4. **Wake + triage** — on each interval tick the *system* wakes the orchestrator. It reads the agent request inbox, **verifies real progress against git and board state**, writes a triage summary to the session log, and acts: advance a subtask to the next stage, dispatch a research agent for a well-formed request, escalate a planner-stage question to the human, or — when a feature's subtasks are coded and reviewed — run the **merge-back**.
5. **Merge back (feature by feature)** — the orchestrator merges each feature's branches and resolves conflicts as it goes, following the agent-driven merge pattern (subtask → feature integration branch → main). One feature at a time keeps conflicts contained; the orchestrator is the agent that resolves them.
6. **Done** — when all features are merged (or escalated), the batch is complete and the orchestrator reports out.

**Reused, not built:** autoban interval tick + `lastTickAt` (`autobanState.ts`); `group-into-features` skill; worktree auto-creation + kind-aware merge targets; the `merge-prompt`/`worktree_cleanup` agent-driven merge pattern *(correction from plan review: design-reuse only — this exists as a reviewed plan, `merge-prompt-button-agent-driven-worktree-merge.md`, not shipped code; subtasks 2 and 5 carry the dependency explicitly)*; LocalApiServer board ops (`/kanban/move`, `/kanban/feature/*`); terminal dispatch.

**Newly built:** the `'orchestration'` mode + its config/UI + worktree-mode coupling; the file-based agent→orchestrator request inbox + session log; the orchestrator persona workflow; the batch-level fan-out/verify/merge orchestration logic.

## How the Subtasks Achieve This

- **Orchestration mode — config, tab UI, worktree coupling**: Adds `'orchestration'` to the `automationMode` enum and its normalization (`autobanState.ts:275`), a config block (interval + any orchestration-specific settings paralleling `SingleColumnAutobanConfig`), the AUTOMATION-tab selector option and a **Start orchestrator** button (`src/webview/kanban.html` `createAutobanPanel`), and the coupling that flips `feature_worktree_mode` to per-feature when the mode is selected. Foundation for the rest.
- **Kickoff — group + fan out**: On Start, launches the orchestrator terminal and runs `group-into-features` with the confirm gate off and a **`Miscellaneous`** leftover sweep so no plan is ungrouped; the system auto-creates worktrees + terminals; the orchestrator dispatches each feature's subtasks by stage, then sleeps. Depends on the mode foundation.
- **Agent→orchestrator request channel + session log**: A file inbox convention (e.g. `.switchboard/orchestrator/inbox/…`) and a small agent skill that planners/reviewers/coders use to file a question, warning, or research request, plus the session log the orchestrator writes triage summaries to. The one genuinely new mechanic; the send path reuses "write a file," the read/verify path is the orchestrator's job on wake.
- **Wake + triage loop (incl. feature-by-feature merge-back)**: On each interval tick the system wakes the orchestrator; it reads the inbox, **verifies against git/board state** (truth, not self-report), summarizes to the session log, and acts — advance stages, dispatch a research agent, escalate planner-stage questions to the human, and run the agent-driven merge-back per feature (subtask → integration → main, resolving conflicts). Depends on all of the above.
- **Orchestrator persona workflow** (`.agents/workflows/orchestrator.md`): The agent definition the mode launches into the orchestrator terminal — its responsibilities, the wake/triage protocol, the "verify via git, never trust self-report" rule, the planner-escalation boundary, and the merge-back procedure. Cross-cuts the subtasks above; can be authored alongside the kickoff/triage work.

## Dependencies & sequencing

The mode foundation lands first (everything keys off the new `automationMode`). Kickoff (group + fan out) and the request-channel/session-log can proceed in parallel once the foundation exists. The wake+triage loop depends on both the channel and the fan-out being in place, and the merge-back step within it depends on the worktree topology from kickoff. The orchestrator persona workflow is authored across kickoff + triage since it encodes both behaviours.

## Key design decisions (settled during planning)

- **System-woken, not self-scheduling.** The orchestrator has no timer of its own; it relies entirely on the autoban interval tick to be re-invoked, re-hydrating state from git/board/inbox each wake. This is the durability strategy — no long-lived in-context fleet state to lose.
- **Grouping confirm gate is OFF in this mode.** Unattended operation can't block on approval. Users who want to review/curate groupings do so manually *before* starting automation.
- **`Miscellaneous` leftover feature.** The orchestrator's grouping differs from the interactive skill by sweeping all standalone plans into one `Miscellaneous` feature so the batch has no ungrouped remainder.
- **Merge-back is in scope, feature by feature.** The orchestrator merges and resolves conflicts one feature at a time (subtask → integration → main), which keeps the conflict surface contained; it is not a bulk `git merge`.
- **Ground truth over self-report.** Completion and progress are judged from git state (branch ahead of base, commits, tests) and board columns, not from an agent saying "done." Messaging/requests are for questions and nudges, not status of record.
- **Planners stay human-in-the-loop.** Planner-stage questions/warnings are escalated to the human via the session log, not auto-resolved. Orchestration is coding + code-review automation.

## Anchors / reuse map

- Automation mode enum + normalization: `src/services/autobanState.ts:275` (`automationMode`), `SingleColumnAutobanConfig` as the config-shape template (`:18`).
- AUTOMATION tab UI: `src/webview/kanban.html` `createAutobanPanel` (mode selector, per-mode config panels).
- Grouping skill to invoke: `.agents/skills/group-into-features/SKILL.md` (SCAN → cluster → `create-feature.js`); confirm gate at step 4 is the thing this mode disables.
- Feature/worktree ops via API: `src/services/LocalApiServer.ts` routes `/kanban/feature*` and `/kanban/move` (verified at `:1344-1355`). *(Correction from plan review: `/worktree/cleanup` does NOT exist yet — it is specified by the merge-prompt-button plan; until it lands, cleanup goes through the shipped `KanbanProvider` worktree paths.)*
- Merge pattern to follow: the `merge-prompt-button` design (agent resolves conflicts in the worktree; kind-aware target subtask → integration → main).
- Interval/wake substrate: autoban `intervalMinutes` + `lastTickAt` (`autobanState.ts` rules), and `PipelineOrchestrator`'s tick skeleton as reference.

## Out of scope

- The Notion command channel (natural-language directive in / status out) — a natural follow-on I/O layer on top of this engine, deliberately deferred. This feature is driven from the AUTOMATION tab.
- Remote / Claude-Code-on-web operation — Orchestration is local-only (it needs the running extension, terminals, and worktrees).
- Automating the planner stage — explicitly excluded; planning stays human-in-the-loop.
- Any new scheduler — the orchestrator is woken by the existing autoban tick, not a new timer.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Add an Orchestration Automation Mode (Config, AUTOMATION-Tab UI, Worktree-Mode Coupling)](../plans/orchestration-1-automation-mode-foundation.md) — **PLAN REVIEWED**
- [ ] [Orchestration Kickoff — Auto-Group into Features (+ Miscellaneous) and Fan Out to Worktrees](../plans/orchestration-4-kickoff-group-and-fan-out.md) — **PLAN REVIEWED**
- [ ] [Author the Orchestrator Persona Workflow (`.agents/workflows/orchestrator.md`)](../plans/orchestration-2-persona-workflow.md) — **PLAN REVIEWED**
- [ ] [Orchestration Wake + Triage Loop with Feature-by-Feature Merge-Back](../plans/orchestration-5-wake-triage-and-merge-back.md) — **PLAN REVIEWED**
- [ ] [Add a File-Based Agent→Orchestrator Request Channel and Session Log](../plans/orchestration-3-agent-request-channel-and-session-log.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->
