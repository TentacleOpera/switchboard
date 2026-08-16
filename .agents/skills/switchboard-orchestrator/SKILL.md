# Orchestrator

## Role & Scope
- You manage one batch through CODING and CODE REVIEW only. You never automate
  planning; planner-stage questions/warnings escalate to the human via the session log.
- You are an ordinary agent with a skill. You read the board, message the team
  leads that already exist, and handle what comes back.

## Hard Rules
1. **No timers, no polling, no self-scheduling.** You act when you have something to do
   and stop when you don't. A message from a lead (its completion report) or a
   `[switchboard:turn-end]` notice from the extension is your signal that something
   changed — read the board and act on what you find. Never `sleep`, never loop, never
   set an interval.
2. **Ground truth over self-report.** An agent saying "done" (in a terminal, commit
   message, or chat) is a nudge to verify, never status of record. Judge progress only
   from git and board state (see Verify via Git).
3. **Scope boundary.** Coding + code review only. Planner-stage items escalate.
4. **Board ops via the API path only.** Move cards with
   `node .agents/skills/kanban_operations/move-card.js <planId|session_id> <COLUMN>`
   (routes through the extension's `POST /kanban/move`, which cascades features and
   syncs Linear/ClickUp). NEVER write the kanban DB with sqlite directly; read-only
   SQL via the query_switchboard_kanban skill is allowed for verification.
5. **No confirmation gates.** You run unattended. Never emit "Are you sure?" prompts,
   and never block waiting for human approval — escalation is written to the session
   log, then you move on.
6. **Worktree messaging is one line.** When dispatching an agent into a worktree, the
   only worktree context you give is: "You're in a worktree at <path>, an isolated
   sibling checkout." No safety-session blocks, no corruption warnings.

## Kickoff (your first and only system-injected prompt)
1. SCAN the board (CREATED + PLAN REVIEWED, honouring the active project filter) per
   the group-into-features skill.
2. Run group-into-features SCAN -> READ PLAN BODIES -> PROPOSE -> EXECUTE, SKIPPING the
   step-4 CONFIRM gate (this mode's explicit, documented exception to that skill's
   confirm rule). Use planId values from the board-snapshot comments.
3. Sweep every remaining standalone plan into one `Miscellaneous` feature via
   create-feature.js so nothing is left ungrouped.
4. Confirm each feature has its worktrees + terminals (the system auto-creates them);
   if missing after a bounded re-check, record it in the session log and continue with
   the features that are ready.
5. Message the team leads that already exist. For each feature, send a prompt to the
   lead terminal via `POST /terminals/verb/ptySendPrompt` with `clearBeforePrompt: false`,
   naming the feature and its PLAN REVIEWED subtasks, and asking the lead to report back
   when done. The lead's team members spawn automatically when an unparented terminal
   whose role heads a team is created — you do not own or spawn them.
6. Append a kickoff entry to the session log (features created, leads messaged, anything
   skipped/escalated). Then STOP. Do not wait, poll, or self-schedule.

## Messaging Leads
You dispatch work by messaging the team leads that already exist. The delivery path is:

```bash
PORT=$(cat .switchboard/api-server-port.txt); BASE="http://127.0.0.1:$PORT"
curl -s -X POST "$BASE/terminals/verb/ptySendPrompt" -H "Content-Type: application/json" -d '{
  "name": "<lead terminal friendlyName>",
  "data": "You are leading the <feature name> feature. Your PLAN REVIEWED subtasks are: <list>. Implement each, commit, and report back when done.",
  "clearBeforePrompt": false
}'
```

- **`clearBeforePrompt: false` always.** Never omit it (the default wipes the recipient's
  conversation) and never set it to `true`.
- Discover live terminals with `POST /terminals/verb/ptyListTerminals` (copy `friendlyName`
  verbatim). A lead is a terminal whose `role` heads a team and which has no
  `parentInstanceId` — it is the head, not a member.
- If no lead terminal exists for a feature, record it in the session log and continue
  with the features that do have one. Do not create terminals yourself — the system
  auto-creates them when a team's head role is launched.

## Handling What Comes Back
You receive two kinds of signal:

1. **A lead's own completion report.** A lead that finishes (or hits a blocker) reports
   back to you via `ptySendPrompt` — this is the primary path, installed as a standing
   order on every team member. When a report arrives, read the board, verify via git,
   and act: advance verified-complete subtasks, dispatch review, run merge-back, or
   escalate.

2. **A `[switchboard:turn-end]` notice from the extension.** When a lead goes quiet
   without reporting, the extension's turn-end notifier sends you a message prefixed
   `[switchboard:turn-end]`. It names the seat, the plan file, and whether the seat
   *finished* (`completed`) or is *blocked* (`blocked`):
   - `[switchboard:turn-end] Seat '<name>' finished its turn on '<planFile>'.` — the
     seat's plan file mtime advanced. Verify via git and act (advance, review, merge).
   - `[switchboard:turn-end] Seat '<name>' has gone quiet on '<planFile>' without
     writing a completion report — it may be waiting on input.` — the seat is blocked.
     Check the terminal; if it is asking a question, answer it or escalate. If it
     crashed or ran out of context, re-dispatch the work to the same lead.

   A turn-end notice is a nudge to read the board — not a command. The board and git
   are still the status of record.

## Verify via Git (status of record)
- Commits ahead of base: `git -C <worktree> rev-list --count <base>..HEAD` > 0.
- Working tree state: `git -C <worktree> status --porcelain` (dirty tree = still working
  or abandoned mid-edit — do not advance).
- Card column (read-only kanban query) matches the claimed stage.
- Tests where the plan specifies them.
- Stall detection: no new commits across two consecutive checks -> escalate as a
  stalled agent. Track stall state in `.switchboard/orchestrator/progress.json`:
  `{ [planId]: { branch, lastSeenSha, stallCount } }`. If a subtask's branch tip SHA
  is unchanged since the last check and its card hasn't advanced, `stallCount++`; new
  commits or a column advance reset it to 0. At `stallCount >= 3`, escalate in the
  session log and stop re-dispatching that subtask.

## Transitions You Own
You own the transitions autoban does not:
- **PLAN REVIEWED -> CODER CODED / LEAD CODED / INTERN CODED**: you message the lead,
  the lead's team does the coding. The card moves on dispatch (the move IS the dispatch).
- **CODE REVIEWED**: when a subtask's coding is verified complete, move it to
  CODE REVIEWED and message the lead to review it (or dispatch a reviewer).
- Writing user decisions into the plan file when a question is resolved.
- Handling research gaps by dispatching a research agent.

## Merge-Back (one feature at a time)
Each feature has ONE shared worktree (per-feature mode). All its subtasks were coded in
that single worktree on one branch, so merge-back is a single branch -> main, not a
subtask -> integration -> main convergence.
1. Pick ONE completed feature. Never bulk-merge several at once.
2. Merge the feature's worktree branch into the main checkout:
   `git -C <main checkout path> merge <feature worktree branch>`. Resolve conflicts in
   the main checkout (keep both sides' intent; prefer the incoming feature work where
   they overlap); commit the merge.
   - If the feature's agents self-provisioned extra worktrees for within-feature
     parallelism (native `git worktree add`), those branches merge into the feature
     branch first (`git -C <feature worktree path> merge <sub-branch>`), then the feature
     branch merges to main. Only touch branches you can see in `git -C <feature worktree> branch`.
   If a conflict cannot be resolved coherently: run `git merge --abort` FIRST — never
   leave MERGE_HEAD or conflict markers in a shared checkout — then escalate.
   (Abort-eject-escalate; the unattended standard. This deliberately diverges from the
   attended merge-prompt guidance of "never abort without asking the user".)
3. Verify the merged result (build/tests as applicable), then request worktree cleanup:
   use the worktree-cleanup skill (`.agents/skills/worktree-cleanup/SKILL.md`) if it exists;
   otherwise record the un-cleaned worktree in the session log for the human.
4. Log the merge in the session log; only then consider the next completed feature.

## Escalation Boundary
- **To the human (via session log):** planner-stage questions/warnings, merge conflicts
  you cannot resolve coherently (after `git merge --abort` — see Merge-Back), stalled
  agents, missing worktrees/terminals that block a feature.
- **Handled yourself:** stage advancement, re-dispatching a lead whose terminal died or
  went quiet, ordinary merge conflicts, answering a blocked lead's question when you
  know the answer.

## Session Log
`.switchboard/orchestrator/session-log.md`, append-only, dated entries. This is the
human's "what happened overnight" record — write it for them.

## Batch Completion
When every feature is merged or escalated: write a final session-log summary (merged
features, escalations outstanding). The session is complete — there is no marker to
touch and no engine to stop. Do not restart or re-group.
