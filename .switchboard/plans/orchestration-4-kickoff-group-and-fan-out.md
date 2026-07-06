# Orchestration Kickoff — Auto-Group into Features (+ Miscellaneous) and Fan Out to Worktrees

## Metadata
**Complexity:** 7
**Tags:** backend, feature, automation
**Project:** Switchboard

## Goal

Implement what happens when the user presses **Start orchestrator**: the orchestrator batches all eligible plans into features (with the confirm gate off and a `Miscellaneous` sweep so nothing is left loose), the system auto-creates each feature's worktrees and terminals, and the orchestrator dispatches each feature's subtasks by stage, then goes to sleep.

### Problem / background / root cause

Grouping, worktree creation, and dispatch all exist as separate operations today, driven by a human. `group-into-features` (`.agents/skills/group-into-features/SKILL.md`) clusters loose plans but has a **load-bearing confirm gate** (step 4) that blocks unattended use, and it leaves genuinely standalone plans ungrouped by design. Worktree-per-feature creation and terminal provisioning already fire off feature/card operations. Kickoff's job is to sequence these into one unattended pass so a batch goes from "20 loose cards in Plan Reviewed" to "every card in a feature, worktrees up, coders dispatched" without a human clicking through each step.

## Detailed changes

### 1. Non-interactive grouping + `Miscellaneous` sweep

- The orchestrator (via its persona, subtask 2) runs `group-into-features`' SCAN → READ → PROPOSE → EXECUTE **without CONFIRM** — the gate-off decision is intentional and documented in the feature (users who want to curate group manually before starting). Reuse `create-feature.js` / `assign-to-feature.js` exactly as the skill documents.
- After real groups are created, **sweep all remaining standalone in-scope plans into a single `Miscellaneous` feature** so the batch has no ungrouped remainder. Handle the already-exists case (reuse the existing `Miscellaneous` feature and assign to it rather than creating duplicates).
- Scope matches the skill: pre-coding columns (CREATED, PLAN REVIEWED), respecting any active project filter.

### 2. Auto-create worktrees + terminals

- With `feature_worktree_mode` per-feature already on (subtask 1), ensure each new feature gets its integration + subtask worktrees and their terminals via the existing worktree-creation path. Confirm the trigger fires for features created programmatically during kickoff (not only via manual UI creation) — wire it if the programmatic path doesn't already provision worktrees.

### 3. Staged fan-out

- The orchestrator advances each feature's subtasks into the coding stage by moving cards via the board operations (`/kanban/move`), letting the established per-column dispatch send the coder into the worktree terminal — i.e. the orchestrator drives the board the way a human does, rather than inventing a separate dispatch path. Confirm the coding-column dispatch delivers the agent into the correct per-feature worktree terminal.
- After dispatching the batch, the orchestrator **stops and sleeps** — it does not poll. The system wakes it later (subtask 5).

## Edge cases & constraints

- **Empty / already-grouped board.** Nothing loose → no features created, `Miscellaneous` not created; kickoff is a clean no-op that still arms the wake loop.
- **Plans already in a feature or a subtask** are skipped by the grouping scan (respect the `feature` / `subtask-of:` tags).
- **Concurrency ceiling.** Fanning out N features × their subtasks must respect the existing terminal-pool / batch limits (`MAX_AUTOBAN_TERMINALS_PER_ROLE`, batch size) — don't spawn unbounded terminals. Document how many run at once and how the rest queue.
- **`Miscellaneous` naming collision** across runs → reuse, don't duplicate.

## Testing

- With several loose plans across CREATED/PLAN REVIEWED, kickoff creates coherent features plus a `Miscellaneous` feature covering the leftovers; no plan is left ungrouped.
- Each created feature has worktrees + terminals provisioned.
- Subtasks are dispatched into their feature worktree terminals; the orchestrator then reports sleeping.
- Empty board → clean no-op.

## Out of scope

- Wake, progress verification, triage, and merge-back (subtask 5). Kickoff ends at "dispatched and sleeping."
