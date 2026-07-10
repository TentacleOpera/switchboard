---
name: switchboard-contracts
description: "System behavior contracts for agents driving Switchboard — consult when unsure how the system behaves; never for invocation. This doc answers how the system behaves. It never answers how to invoke something — for invocation, use the switchboard-orchestration skill and GET /catalog."
user-invokable: false
---

# Skill: Switchboard Contracts — Agent-Facing Behavior Reference

> **Scope.** This is a *behavior* reference, not an *invocation* reference. It answers
> "how does Switchboard behave?" — never "how do I call endpoint X?" For invocation
> (endpoints, verbs, payload fields), use the **`switchboard-orchestration`** skill and
> `GET /catalog`. Consult this skill when you are unsure *why* something happens or
> *what* a system convention is. Every fact below cites its source-of-truth file so
> staleness is checkable; the contracts are slow-moving (conventions), not mechanics.

These are the behavioral contracts an agent driving Switchboard must know. They were
extracted from source because the user manual targets *human UI users* ("click the
button") and is useless to an agent — these facts had to be re-derived from source every
time a managing agent needed them.

## Contracts

1. **Cards move on coding *start*; they never move on finish.** The column move *is* the
   dispatch — moving a card to a coding column fires the agent prompt. There is no
   "move on completion" step. Completion is detected by a different mechanism (see #2).
   Source: `src/services/KanbanProvider.ts` (dispatch branches persist the move and then
   build the prompt; `// The move persists immediately and does not wait on dispatch.`).

2. **Completion signal = first plan-file `mtime` advance after dispatch.** The activity
   light's OFF-switch fires when the plan file is edited *after* `dispatched_at` is set.
   The dispatch flow does **not** write the plan file (it only runs SQL), so any mtime
   advance reaching the watcher while `dispatched_at` is set is the agent's completion
   edit. **No agent-authored text is trusted** as a control signal — only the mtime
   advance. Source: `src/services/GlobalPlanWatcherService.ts` (activity-light OFF-switch
   comment + `clearWorkingState` on edit while `dispatchedAt` set).

3. **Plan files are write-once-at-the-end by dispatched agents.** The
   `CODING_COMPLETION_REPORT_DIRECTIVE` instructs the coder to append a completion summary
   to the plan file *when finished*. Mid-work plan edits break completion detection for
   everyone (they trip the mtime gate early). Source:
   `src/services/agentPromptBuilder.ts` (`CODING_COMPLETION_REPORT_DIRECTIVE`). The
   directive is deliberately non-overridable for code-touching roles — a post-override
   guard re-appends it idempotently so a `replace`-mode prompt override cannot silently
   drop the completion handshake.

4. **Staleness backstop.** `switchboard.activityLight.timeoutMs` (default 10 min) drives a
   sweep that clears `dispatched_at` on cards older than the threshold — so a dispatched
   plan whose agent never edits the plan file still clears its working-state light
   eventually. Source: `src/services/GlobalPlanWatcherService.ts` (timeout sweep +
   `clearStaleWorkingState`).

5. **Persist a card move before firing its dispatch.** The move↔dispatch coupling is
   load-bearing: the column move is persisted first, then the prompt is built/dispatched.
   Never dispatch a card whose column move has not been persisted. Source:
   `src/services/KanbanProvider.ts` (`// The move persists immediately and does not wait
   on dispatch.`).

6. **Epic subtasks carry their own `kanban_column`.** A feature's subtasks have a column
   independent of the feature's column. Column sweeps (e.g. "Advance All in CREATED")
   **must exclude** subtasks, or a subtask nested under a BACKLOG feature but with
   `kanban_column='CREATED'` leaks into the batch operation even though the user only sees
   it rolled up under its feature. Selection-based operations (explicit session IDs) do
   not use this exclusion — there the user picked specific cards. Source:
   `src/services/KanbanProvider.ts` (subtask-exclusion comment + the
   `featureId`-filtering that mirrors `kanban.html`'s
   `displayCards.filter(card => !card.featureId)`).

7. **Every API call carries `workspaceRoot`; reads prefer local `kanban-state-*.md` files;
   the extension is the sole `kanban.db` writer.** You never write to `kanban.db`
   directly — you call the LocalApiServer endpoints. The board is the source of truth; the
   UI is one view of it. Source: `src/services/LocalApiServer.ts` + the
   `switchboard-orchestration` skill.

8. **Project pins are resolve-only on import; the workspace name is never a project.** A
   workspace is a workspace; a project is a user-created board filter. They are not
   interchangeable. Never pin the workspace/repo name as a project, and never emit a
   placeholder like `<project>`. Source: workspace-detection + plan-pinning rules in the
   Switchboard protocol (see `AGENTS.md` "Plan Project Pinning").

## When to consult this skill

- You are a managing/orchestrating agent unsure *why* a card did or did not move.
- You need to know how completion is detected (so you do not wait for a board move that
  will never come).
- You are about to edit a plan file mid-work and want to confirm whether that is safe
  (it is not — see #3).
- You are running a column sweep and need to remember the subtask exclusion (#6).

## When NOT to consult this skill

- To find an endpoint or verb payload → use `switchboard-orchestration` + `GET /catalog`.
- To learn the human-facing UI → read the user manual.
