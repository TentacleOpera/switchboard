# Orchestration Starts as a Conversation, Not a Button Press

## Goal

Pressing Start does not start orchestration. It brings up the orchestrator in a terminal, where the agent runs a pre-flight check, tells you what is missing, proposes a goal for the session, and waits. Orchestration begins only when you answer it.

### Why

**An unattended run that begins on a click begins against a board that may not be ready.** No coding agents seated, a research prompt active with no researcher to serve it, plans sitting loose that you meant to group first, a worktree strategy that does not match what you are about to do. Today the kickoff simply proceeds and writes escalations into a log you read in the morning — the failures are discovered after the night is spent.

**The one moment a human is guaranteed present is the moment they press the button.** That is the moment to ask. Everything after it is unattended by design.

**The orchestrator is an ordinary agent.** It is not special machinery — it is a terminal running a CLI with a skill, exactly like a lead or a planner. So the way to talk to it before it starts is the way you talk to any agent: in its terminal.

## The sequence

**1. Start brings up the orchestrator and stops.** It seats the terminal, launches the CLI, and hands the agent the pre-flight instruction. It arms nothing and installs no timer.

**2. The agent runs a pre-flight and reports.** It checks what this session will actually need and names anything missing, in plain terms:

- **Is there a coding *team* for the features in scope** — not merely a coding agent? See below; this is the check that most often decides whether a night is productive.
- Is there a planner or planning team?
- If the research prompt is active, is there a researcher to serve it?
- What is the worktree strategy, and does the board match it?
- Is there anything to do at all — plans in CREATED, features in PLAN REVIEWED?
- Are there loose plans that were probably meant to be grouped?

Missing things are reported, not fixed. The agent does not create teams, group plans, or change settings to make itself runnable — it says what it found and lets you decide.

**3. The agent proposes a goal for the session.** One short statement of what it intends to accomplish overnight, and the scope it will work within. You can alter it — narrow it to a subset of plans, exclude a feature, cap it at one lane.

**4. You confirm in the terminal, and only then does it begin.** The agent writes the agreed goal and scope to the session file and starts ticking.

**Start is user input, always.** No cron, no scheduled fire, no browser-load autostart may skip steps 2 and 3. A startup team (see `teams-start-themselves-on-load.md`) may seat the orchestrator's terminal on load — that seats an agent, it does not start orchestration.

### A feature needs a team, not an agent

A lone coder terminal is enough for a standalone plan. It is usually **not** enough for a feature: a feature is a set of subtasks, and one agent works them serially with no lead to hand off to and no reviewer to catch what it missed. The `Coding` team type exists precisely for this shape — a lead, coders, and a shared reviewer — and the review handoff described in `coding-team-sends-the-feature-to-review-not-each-subtask.md` has no head to perform it if there is no team.

So when features are in scope and only a single coding agent is seated, the pre-flight must say so plainly and **strongly recommend starting a coding team** before the session begins. Name the features it is worried about, so the recommendation is concrete rather than generic advice.

It remains a recommendation, not a gate. You may proceed with a lone agent — but you will have been told, before the night is spent, rather than after.

The same sequence runs when you simply ask the orchestrator about orchestration in its terminal. There is one entry path, and the button is a shortcut to it rather than a second mechanism.

## The session file

Confirmation produces `.switchboard/orchestrator/session.md`, in two parts:

- **Rules** — the agreed goal, the scope, the worktree strategy, which lanes are active. Written once at confirmation, then read-only for the session.
- **Log** — append-only, what actually happened. Only real actions; idle ticks write nothing.

This file is the session's memory (see `orchestrator-persona-becomes-a-tick.md`), which is why it is written before the first tick rather than discovered along the way.

## Metadata

**Complexity:** 4
**Tags:** ux, backend, reliability

## Verification Plan

1. Press Start with no coding team seated: the agent says so and waits. No card moves, no timer is installed.
2. Press Start with features in scope and only a **single coding agent** seated: the pre-flight strongly recommends a coding team and names the features at risk. Confirming anyway proceeds — it is advice, not a gate.
3. Press Start with features in scope and a coding team seated: no such recommendation appears.
4. Press Start with a research prompt active and no researcher: it is named in the pre-flight.
5. Press Start on an empty board: the agent says there is nothing to do rather than starting a session that will idle all night.
6. The agent proposes a goal and stops. Nothing runs until a reply is typed.
7. Reply narrowing scope to two plans: the session file records that scope, and the ticks stay inside it.
8. Kill and restart the terminal mid-session: the agent picks up the existing session file rather than re-running pre-flight from scratch.
9. A cron fire or a browser-load startup team seats the orchestrator's terminal but does not begin orchestration.
