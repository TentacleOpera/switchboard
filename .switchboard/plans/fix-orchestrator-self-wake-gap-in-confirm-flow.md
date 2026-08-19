# Fix orchestrator self-wake gap in the confirm flow

## Metadata
**Complexity:** 2
**Tags:** docs, refactor
**Project:** Browser Switchboard

## Goal

Close the protocol gap that allowed an orchestrator agent to call `POST /orchestration/confirm`, interpret `{success: true}` as "monitoring is now self-sustaining," end its turn, and go dormant for over an hour while the coding team completed work and generated 11 unread report files.

The root cause is not a missing mechanism — `## Self-Wake` already specifies the background sleep loop and native scheduling options, and the design intention is that the orchestrator uses its own tools or the provided script. The root cause is that the **confirmation sequence in "On confirmation" never connects to the self-wake step**. The agent follows three steps (write session.md → call confirm → "begin"), and "begin" has no follow-on instruction telling it to start the wake timer before ending its turn.

## Problem analysis

The skill describes three things in three separate, non-adjacent sections:

1. **"On confirmation" (lines 213-228)** — the procedural step-by-step. Step 3 says "Only then begin." There is no step 4. The sequence ends with no instruction to start a wake mechanism.
2. **"Handoff, or arm?" (lines 240-250)** — describes the three session models (handoff, arm, self-wake). Descriptive, not procedural. Does not say "after confirm, if your model is self-wake, start the background loop now."
3. **"Self-Wake" (lines 301-331)** — the mechanism reference. Written as a how-to, not as a mandatory step in the confirmation flow.

The agent has to infer the connection across all three sections. Under time pressure or ambiguous phrasing ("armed" implies active and running), it skipped the inference and treated server-side arming as agent-side persistence.

The critical invariant is never stated anywhere in the skill: **`POST /orchestration/confirm` arms server-side session state only. It does not keep the agent process alive. Under self-wake, the agent's own background process is the only thing that wakes it — the server will not.**

## Changes

Single file: `.agents/skills/switchboard-orchestrator/SKILL.md`

### Change 1 — Add the invariant statement to "On confirmation"

After the existing step 3 ("Only then begin"), add a short invariant block that makes the agent-side vs. server-side distinction impossible to miss:

- `POST /orchestration/confirm` arms server-side session state (`orchestratorArmed`, worktree topology). It does **not** keep the agent process alive.
- Under self-wake mode, the agent itself must start the wake mechanism (per `## Self-Wake`) before ending its turn. The server will not wake it.
- Under handoff mode, proceed to the handoff sequence (which exits the agent by design).
- The agent must not end its turn without one of these two paths started.

### Change 2 — Add an explicit step 4 to the confirmation sequence

After step 3, add:

> 4. **Start the wake mechanism (self-wake mode only).** Before processing the first tick, start the background wake loop per `## Self-Wake` — either the provided `while true; do sleep N; done` script in a background terminal, or your runtime's native scheduling equivalent. If you end your turn without this running, the session is immediately dormant and no tick will ever fire.

This makes the self-wake startup a numbered step in the same procedural list the agent is already following, rather than a separate reference section it has to discover.

### Change 3 — Cross-link from "Self-Wake" back to the confirmation flow

At the top of `## Self-Wake`, add one line noting that this mechanism must be started as step 4 of the confirmation sequence ("On confirmation"), not discovered later — so an agent landing in the section via search or scroll still sees the procedural anchor.

## What does NOT change

- The self-wake mechanism itself (background sleep loop, native scheduling) — the design intention is that the orchestrator uses its own tools or the provided script. No new mechanism is introduced.
- The handoff sequence or its exit behavior.
- The server-side `POST /orchestration/confirm` endpoint or its response.
- Any code. This is a protocol/skill-documentation fix only.

## Edge cases and risks

- **Risk: over-specifying and making the skill longer than needed.** The additions are three short blocks (one invariant, one numbered step, one cross-link). The skill is already 644 lines; this adds roughly 15-20 lines. Acceptable for closing a gap that caused a real one-hour outage.
- **Risk: an agent in handoff mode misreads the new step 4 as applying to it.** The step is explicitly gated "self-wake mode only" and the handoff path is named as the alternative. The existing handoff sequence already ends with exit, so there is no ambiguity about which path the agent is on.
- **Risk: an agent uses native scheduling instead of the script and it behaves differently.** The `## Self-Wake` section already covers both options and their constraints. No change needed here.
- **Not a risk: existing sessions.** This is a skill documentation change, not a state migration. No installed data is affected.

## Verification plan

1. Read the edited `## On confirmation` section and confirm the invariant statement and step 4 are present and unambiguous.
2. Read the edited `## Self-Wake` section and confirm the cross-link back to the confirmation flow is present.
3. Simulate the agent's decision path: follow "On confirmation" step-by-step and confirm that after step 4, there is no way to end the turn without either (a) a wake mechanism running, or (b) being on the handoff path that exits by design.
4. Confirm no other section of the skill contradicts the new invariant (i.e., no other place implies the server keeps the agent alive).
