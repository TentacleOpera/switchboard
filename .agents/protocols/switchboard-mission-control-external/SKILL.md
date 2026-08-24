# Mission Control — External Runsheet

You are an external agent. No host process wakes you — turn-end notices land in
`.switchboard/mission-control/reports/` and nobody delivers them to your terminal.
You MUST start the self-wake loop before your first tick, or the session dies on
arrival. Arming means you stay alive and self-wake.

## Self-Wake

> **This mechanism must be started as step 4 of the confirmation sequence** (see
> `## On confirmation` in the shared logic), not discovered later. Ending the
> confirmation flow without it running is the single most common way an
> Mission Control session dies silently.

When operating in self-wake or persistent Mission Control mode, Mission Control
manages its own wakeup cycle using one of two mechanisms:

### A. Background script (default)
Run a sleep loop in a background terminal or background process:

```bash
# Run in background to wake every N minutes (default 600s = 10m from missionControlConfig.intervalMinutes)
while true; do sleep 600; echo "WAKE $(date -u +%FT%TZ)"; done
```

When you see `WAKE`, re-read the board, drain reports, and act on what you find.

**The interval is 10 minutes** unless the user named a different one during the
pre-flight — write whichever you are using into `session.md` so it survives a restart.
Do not go hunting for the board's configured value: `missionControlConfig.intervalMinutes`
(default 10) lives in VS Code workspace state under the `autoban.state` key. There is no
`.switchboard/autoban.state` file, and `GET /health` does not carry it. No endpoint
exposes it to you.

### B. Native scheduling (alternative)
If your runtime supports background scheduling or tools (e.g. background bash/scheduling), use it to run the same sleep-and-signal loop: wake every N minutes, re-read the board, act on what you find.

**Constraints for self-wake:**
- Mission Control terminal stays alive for the duration of the session.
- On each wake, re-derive everything from the board and git fresh.
- A no-op wake (nothing to dispatch, nothing to advance) writes nothing to the session log.
- One dispatch per lane per wake.
- The wake is agent-side: your own background process or scheduling delivers the wake.

## On confirmation — step 4 (external)

After calling `POST /mission-control/confirm` (step 3 of the confirmation sequence
in the shared logic), start the wake mechanism before processing the first tick:

4. **Start the wake mechanism.** Before processing the first tick, start the
   background wake loop per `## Self-Wake` above — either the provided
   `while true; do sleep N; done` script in a background terminal, or your
   runtime's native scheduling equivalent. If you end your turn without this
   running, the session is dead on arrival.

## Context Is Cleared Every Tick — self-wake mechanism

Under self-wake there is no deliverer to do it for you — a `WAKE` line printed
by your own background loop clears nothing and hands you no prompt. The
obligation is identical either way; only the mechanism differs. Under self-wake
you perform it yourself: at the top of every pass, re-read `session.md`, the
board, and git from disk, and decide from those alone. Anything still sitting in
your context from the previous pass is a memory competing with the board — the
exact thing the rules tell you to distrust. Treat it as untrusted, not as state
you may carry forward.

Under self-wake you are the deliverer, so the drop-not-queue rule becomes yours
to keep: read the wake signal only between passes, never mid-pass, and collapse
every `WAKE` line that piled up in the background terminal while a pass was
running into a single pass. A backlog of five wake lines is one wake, never
five. A `while true; do sleep …; done` loop fires unconditionally — it has no
idea you are busy, so the drop has to happen at the reading end.

## Session Completion — stop the wake loop

When every feature is merged or escalated: write a final session-log summary
(merged features, escalations outstanding). Stop the self-wake background
script. The session is complete.

---

The shared Mission Control logic follows. It covers Hard Rules, the tick,
dispatch, handoff, signals, and the session file — everything you do when awake.
It does not mention wake; that is this runsheet's job.
