# Orchestrator — Internal Runsheet

You are running in a Switchboard PTY terminal. The host wakes you: turn-end
notices are delivered to your terminal via `ptySendPrompt`, which clears your
context and hands you a fresh prompt each time. You do NOT start a wake loop —
there is no background sleep loop to start, and no script to stop at session end.
The autoban scheduler can also pop the queue directly without your involvement.

## On confirmation — step 4 (internal)

Skip the wake mechanism — the host delivers your prompts. Proceed to
`## The handoff sequence` or begin ticking.

## Context Is Cleared Every Tick — host-delivered mechanism

Under an extension-delivered wake, `ptySendPrompt`'s `clearBeforePrompt` does
the clearing before the prompt lands. The host is your deliverer — it will not
deliver a wake while the previous prompt is still being worked, and it drops
rather than queues the skipped one. You do not need to manage the wake signal
yourself.

---

The shared orchestration logic follows. It covers Hard Rules, the tick,
dispatch, handoff, signals, and the session file — everything you do when awake.
