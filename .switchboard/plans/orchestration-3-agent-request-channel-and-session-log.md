# Add a File-Based Agent→Orchestrator Request Channel and Session Log

## Metadata
**Complexity:** 5
**Tags:** backend, feature, automation
**Project:** Switchboard

## Goal

Add the one genuinely new mechanic in this feature: an asynchronous, file-based channel for coding/review agents to raise questions, warnings, and research requests to the orchestrator, plus an append-only **session log** the orchestrator writes its triage summaries to. This is what lets the orchestrator sleep between wakes and still coordinate a fleet — agents drop requests to files; the orchestrator drains them on wake.

### Problem / background / root cause

The orchestrator is system-woken and does not hold the fleet in-context, so it cannot receive synchronous messages from the agents it dispatched. Coding and (especially) review agents legitimately need to surface things mid-run — a warning, an ambiguous requirement, "I need to run research first." There is no inter-terminal messaging primitive in the local extension (the Antigravity `send_message` is not reachable here), and synchronous REPL scraping is fragile. A **file inbox** sidesteps all of that: writing a file is trivial for any agent, survives the orchestrator being asleep, and is inspectable by the human. A **session log** gives the run an auditable narrative and a place for the orchestrator to record what it did and what it escalated.

## Detailed changes

### 1. Inbox convention (`.switchboard/orchestrator/inbox/`)

- One file per request, uniquely named (e.g. `<sortable-timestamp>-<agent-or-worktree>-<shortid>.md` or `.json`) so concurrent writers never collide.
- Fields: `from` (agent/terminal/worktree), `stage` (planner|coder|reviewer), `type` (question|warning|research|blocked), `planId`/`feature`, `body`, and optional `worktreePath`.
- Processed requests move to `inbox/processed/` (or gain a `handled` marker) so a wake never reprocesses them — mirrors the seen-set discipline used elsewhere for at-least-once handling.

### 2. Agent skill to file a request (`.agents/skills/orchestrator_request/`)

- A `SKILL.md` + a small shell script that writes a well-formed request file into the inbox (pure file write — no LocalApiServer dependency, so it works even if the API port file isn't found; optionally also offer an API path for consistency with other skills).
- Document **when** agents should use it (a real blocker/question/research need — not routine progress) and the field contract.
- Register in `CLAUDE.md`/`AGENTS.md` skills table and the mirror manifest if it should surface in `.claude/`.

### 3. Session log (`.switchboard/orchestrator/session-log.md`)

- Append-only markdown. The orchestrator writes a dated triage summary each wake: what it read, what it verified from git, what it advanced/dispatched/merged, and what it escalated to the human. Human-readable is the priority (this is the "what happened overnight" record).

## Edge cases & constraints

- **Directory bootstrap.** Create `.switchboard/orchestrator/inbox/` (and `processed/`) on first use; don't assume they exist.
- **Concurrent writes.** Unique filenames per request; never a single shared file the agents append to.
- **Idempotent drain.** Moving/marking processed must be safe to re-run if a wake is interrupted mid-drain.
- **Do not gitignore blindly.** Decide whether the inbox/log are committed or local-only; the session log is useful history, the inbox is transient — document the choice.

## Testing

- The skill writes a valid, parseable request file with all required fields; concurrent invocations produce distinct files.
- A simulated drain reads pending requests, moves them to `processed/`, and a second drain sees nothing.
- Session-log appends are well-formed and ordered.

## Out of scope

- The orchestrator's *consumption* of the inbox and its triage decisions (subtask 5) — this subtask provides the channel and log; subtask 5 acts on them.
