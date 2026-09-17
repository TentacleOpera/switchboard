# Typing on a Remote Board Should Not Wait on the Link

**Complexity:** 7

## Goal

Input latency, not output throughput. Every keystroke in a Switchboard terminal currently waits out a full network round trip plus two local frame boundaries before the character appears. On the operator's own link that is 53 ms mean with 64 ms of jitter, and the jitter is what makes typing feel broken rather than merely slow. This feature holds the two changes that address the keystroke path specifically: predicting the echo so the round trip stops being visible, and removing the frame quantization so the confirmation lands cleanly. The goal is a remote terminal that types like mosh over the same wifi.

## How the Subtasks Achieve This

- **A Remote Terminal Round-Trips Every Keystroke — Add Predictive Local Echo** (`1ee5b5fa`, Planned): renders a typed character locally the moment it is typed, marked unconfirmed, and reconciles against the PTY's authoritative echo when it arrives. The round trip still happens; the operator stops waiting on it. RTT-gated so a local board is unchanged, and explicitly blind in alternate-screen mode, at password prompts and mid-escape-sequence, where a guess would be visible garbage. This is the head of the path and the one that changes how typing feels.
- **A keystroke echo waits on two frame boundaries it does not need** (`a8f75f5d`, Backlog): delivers a small lone output frame straight to xterm instead of holding it for the next animation frame, and scales the gateway's coalescing window to the link rather than to a 60 Hz local renderer. Worth roughly 20-35 ms per keystroke. This is the tail of the same path.

They are complementary, not alternatives: prediction hides the network, de-quantization makes the confirmation land cleanly. Removing 30 ms from a 53±64 ms wait does not on its own change how typing feels, which is why the predictive layer is the one that answers the complaint.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [A keystroke echo waits on two frame boundaries it does not need](../plans/the-echo-path-pays-two-frames-of-quantization.md) — **BACKLOG** — ID: a8f75f5d-f377-482a-8ca0-99e4686b99cf
- [ ] [A Remote Terminal Round-Trips Every Keystroke — Add Predictive Local Echo](../plans/a-remote-terminal-round-trips-every-keystroke-add-predictive-local-echo.md) — **PLAN REVIEWED** — ID: 1ee5b5fa-9776-4c61-9bf9-808bafa379a1
<!-- END SUBTASKS -->

## Dependencies & sequencing

**No blockers. Both subtasks are dispatchable now.** They are independent of each other and can be executed in parallel.

**The CPU-attribution parking is lifted (2026-09-17).** `a8f75f5d` previously carried a PARKED banner holding it behind *Attribute Switchboard's CPU before optimising it* (`1023d997`). That plan is in Reviewed and the numbers exist, so the banner has been removed from the plan file. Do not re-park it.

**No RTT measurement, in either subtask.** `1ee5b5fa` predicts unconditionally — the RTT gate was removed from it on 2026-09-17, because a gate that hides a reconciliation bug on the local board and silently resolves to "prediction off" when unmeasured is worse than no gate. Its Proposed Change 3 now says so explicitly.

`a8f75f5d` still specifies building RTT probes, but **only** for its adaptive coalescing window — the throughput half of that plan. That is a different mechanism for a different purpose and it does not gate prediction. Read the two together as: *nothing decides whether to predict by measuring the link.* If the adaptive window is dropped or deferred, the RTT work goes with it, and `a8f75f5d`'s client fast path still stands on its own.

**Code references in both plan files are stale.** They target `src/webview/terminals.js` around lines 11084 / 11131 / 11293, but `scheduleBatchFlush` and both frame handlers moved into `src/webview/terminalViewport.js` during the viewport extraction (`a3a565fe`). The client fast path belongs in `terminalViewport.js`, alongside the prediction layer, which `1ee5b5fa` already names as its single home. `terminalViewport.js` also now has a `BATCH_FALLBACK_MS` timer next to the shared rAF that neither plan mentions — the fast path must not strand it.
