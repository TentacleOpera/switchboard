# Screen-State Idle Detection: Render the PTY Stream Server-Side So Output Can Signal Turn-End for Agents With No Hook Mechanism

## Goal

Run a headless VT emulator over the PTY output stream Switchboard already receives, and derive a per-terminal idle signal from *rendered screen stability* rather than from raw byte silence — giving a completion signal for agent CLIs that expose no lifecycle hooks, without touching the agent's configuration at all.

### Problem

For agents with a hook mechanism, the sibling plan `agent-emitted-completion-via-cli-hooks` is strictly better and this plan should not be used. This plan exists for the remainder: agent CLIs with no hook or notification facility, custom roles, and wrapper scripts. For those, the only completion signal available today is the plan file's mtime advancing (`PlanIngestionEngine.ts:853`), backed by a blind 10-minute timer (`:250`) — so an agent that finishes a turn without writing to the plan file produces no signal at all, and the seat reads as busy for the remainder of the window.

### Root cause, and why the obvious approach fails

The intuitive fix — "an active agent produces constant output, so silence means done" — is unreliable on raw bytes, but the reason is narrower than this plan originally claimed, and the correction materially weakens the case for building it.

> **Superseded:** "Claude Code and comparable TUI agents repaint continuously: a spinner frame, a status line, an elapsed-seconds counter, a token counter. Bytes therefore **never stop flowing while the CLI is open**, including at a fully idle prompt awaiting input. A raw-byte silence timer … reports 'busy' permanently. It is not a matter of tuning the threshold; the signal carries no information about the agent's state at that layer."
> **Reason:** Web research (Aug 2026) shows this was true of mid-2025 releases — which did re-render status chips at ~5 Hz while idle — and is **no longer true**. Claude Code v2.1.170+ explicitly eliminated idle terminal re-renders to reduce idle CPU. So on current versions bytes *do* stop at an idle prompt, and a raw-byte silence timer would carry real information. The absolute claim ("never", "no information") was a generalisation from one CLI at one point in its history, and it happens to be the CLI that has hooks and will therefore never use this code path.
> **Replaced with:** Raw-byte silence is unreliable *in general* because whether a given TUI repaints at idle is a per-CLI, per-version property that the host cannot know in advance. It is not universally broken; it is unpredictable. That is a weaker premise, and it is the honest one.

The consequence for this plan is significant and points away from building it. Its entire justification is serving agent CLIs with no hook mechanism — and for those CLIs, nobody has measured whether they repaint at idle. If they do not (as current Claude Code does not), a raw-byte silence timer is a few dozen lines and needs no emulator, no masking profile, and no version coupling. **Measure raw-byte silence against the specific hookless CLIs in use before building any of what follows.** If silence works for them, this plan should be closed unbuilt.

Where the emulator genuinely earns its cost is the case where a hookless CLI *does* repaint at idle. There, what carries information is the rendered screen: an idle agent's terminal renders a stable frame — the same prompt box, the same last message — modulo a small number of animated cells, while a working agent's render changes materially with new lines, scrolled content, and changing tool output. Distinguishing those requires interpreting the escape stream rather than counting it, which means an emulator. That is a real scenario, but it is now a **conditional** one rather than the default, and the plan's priority should reflect that.

## Metadata

- **Complexity:** 7
- **Tags:** backend, terminals, reliability, performance

## User Review Required

None.

## Complexity Audit

### Routine

- A periodic snapshot timer and a hash comparison.
- One new `package.json` setting, default off.

### Complex / Risky

- **Whole-buffer hashing may not stabilise, but whether it does is a per-CLI, per-version property — not a given.**

  > **Superseded:** "Claude Code's status line carries a live elapsed-time counter and a token count that tick every second at genuine idle. A whole-buffer hash therefore never stabilises, and the detector reports 'busy' forever."
  > **Reason:** Same correction as the root-cause section: idle re-rendering was removed in Claude Code v2.1.170+, so on current versions the status line does not tick at a genuine idle prompt and a whole-buffer hash *would* stabilise. The claim was accurate for mid-2025 builds and was carried forward as though it were a permanent property of TUI agents.
  > **Replaced with:** Masking is required only for CLIs that *do* animate at idle. Build the masking layer as opt-in per agent profile, with the **default profile masking nothing but the cursor cell** — and confirm empirically, per CLI, whether any masking is needed at all before writing a rule for it.

  Where masking is needed, the volatile cells are not confined to a spinner: exclude the cursor cell, exclude the final N rows occupied by a status line, and normalise runs of digits. Each exclusion is a per-CLI, per-version assumption and must be recorded as such, not buried. A masking rule written speculatively for a CLI that does not need it is pure liability — it can only ever hide real activity.
- **Every masking rule is a version coupling to the CLI's rendering**, which changes far more frequently than a hook contract. This is the core reason this plan ranks below the hook plan rather than beside it. Isolate all masking behind a per-agent profile object so a CLI redesign is a data change.
- **The coalescing path this plan must tap is private to the gateway, and the gateway is conditional.** Today the gateway does deliberately little per pty read: `trackTerminalData` (`terminalWsGateway.ts:386-406`) only appends to a `pendingOutput` accumulator and calls `scheduleFlush`, deferring everything expensive to a shared `OUTPUT_FLUSH_MS = 6` interval (`:91`, `:414`), with scrollback capped at `MAX_SCROLLBACK_BYTES = 256 * 1024` (`:5`, evicted at `:463`). The correct place to feed an emulator is that flush, not the raw chunk handler — but `flushAllPending` / `flushOutput` are private members of `TerminalWsGateway`, which is constructed **only when `ptyReady`** (`bootstrap.ts:1509-1510`), while the fleet exists regardless.

  The original draft assigned the tap to `ptyFleetService` while describing it as "the same coalesced path the gateway flushes on". Those are different objects in different files, and building a coalescer in the fleet would put a **second** accumulator on the hot read path — exactly the cost this plan claims to avoid. Resolve it explicitly: the gateway exposes a flush observer (`onFlush(cb: (terminal: string, data: string) => void)`) that the detector subscribes to, and screen-state detection is therefore only available when the gateway exists. That is an acceptable limitation — no gateway means no browser terminal, which means no PTY seat being watched — but it must be stated rather than discovered.
- **New runtime dependency, and it is not currently present — but it is confirmed safe.** `package.json` `dependencies` carries `@xterm/addon-canvas`, `@xterm/addon-fit`, `@xterm/addon-webgl` and `@xterm/xterm` (`:914-917`) — **`@xterm/headless` is not among them** and must be added to `dependencies` (not `devDependencies`; the VSIX ships with no `node_modules` and webpack must bundle it). Research confirms `@xterm/headless` is 100% pure JavaScript/TypeScript with **zero DOM dependencies and zero native code**, maintained by the VS Code core team, ~300–400 KB. The standalone webpack config declares `externals: { 'node-pty': 'commonjs node-pty' }` and nothing else (`webpack.config.js:161-163`) and aliases `vscode` → `src/standalone/vscodeShim.ts` (`:150`), so it bundles into both `dist/standalone/ptyHost.js` and the extension bundle with no externals change.
- **Reject the native alternative outright.** `libvterm` wrappers require C compilation via node-gyp/prebuilds. In a VSIX that ships with no `node_modules`, a native dependency is a cross-platform installation hazard on every platform the extension supports, for a default-off heuristic feature. The lightweight pure-JS options (`vt10x`, `node-vt100`, `ansiparser` + a hand-rolled grid) are 15–30 KB but stagnant or abandoned, which is the wrong trade for code whose entire risk profile is "silently goes stale". `@xterm/headless` is the correct choice and its size is not a concern in a bundle that already carries `sql.js` and `mermaid`.
- **Idle is not completion.** A stable screen means the agent stopped rendering, which covers "finished", "asked a question and is waiting", "crashed leaving its last frame", and "backgrounded". Treating stability as completion moves cards on crash and on question-asking. The signal must be combined with the same plan-file evidence the hook plan uses.
- **No migration.** This plan adds no schema. The sibling plans take V58 (`last_liveness_at`) and V59 (`blocked_at`) respectively, and this plan consumes both columns without adding a third. If implementation finds a need to persist screen state, stop and reconsider — a per-tick hash belongs in memory, and a persisted one would be a third writer racing the other two.

## Edge-Case & Dependency Audit

### Race conditions

- **Interaction with the sibling hook plan.** If the hook plan has landed and the agent emits events, this detector must not run for that terminal at all — two signals racing to clear the same card produce exactly the double-broadcast the completion seam is designed to avoid (`setOnWorkingStateCleared`, `PlanIngestionEngine.ts:144`, gating on the non-null→null transition). Gate on "this terminal has a hook file and has delivered at least one event", not merely on "the agent looks like Claude".
- **Scrollback replay on attach.** The gateway replays buffered scrollback to newly attached clients from `setupClient` (`terminalWsGateway.ts:832-868`), which resolves a replay frame from the ring buffer before sending `hello`. The emulator must be fed the live flush stream only, once — not from the replay path, or a second browser tab attaching will look like a burst of agent activity.

  > **Superseded:** "The gateway replays buffered scrollback to newly attached clients (`terminalWsGateway.ts:463`)."
  > **Reason:** `:463` is the scrollback *eviction* loop (`while (buffer.totalBytes > MAX_SCROLLBACK_BYTES …)`), not the replay path. The replay is assembled in `setupClient` around `:832-868`. The hazard the edge case describes is real; the citation pointed at unrelated code.
  > **Replaced with:** `setupClient` (`~:832-868`) as the replay site.

- **Resize.** A pane resize reflows and changes the render with no agent activity, producing a false "busy" and resetting the stability clock. `ptyFleetService` handles resize; feed the same dimensions to the emulator and suppress the stability reset for one interval after a resize.

### Security

- No new surface. No route, no token, no user input. The emulator consumes bytes the process already holds and emits only a boolean and a hash.

### Side effects

- **Per-terminal emulator instances cost memory and CPU on every flush.** A parser on the hot read path is a direct regression to interactive latency in every browser terminal, including seats with no dispatched card. Construct at most one emulator per *dispatched* terminal, and none at all when the setting is off.
- **Orphaned emulators on terminal death.** Every construction needs a matching teardown on both death paths (`onExit` at `ptyFleetService.ts:103-111` and `kill()` at `:147-157`), or the map leaks an emulator plus its screen buffer per terminal for the host's lifetime.

### Dependencies & conflicts

- **Alternate screen buffer — an edge case, not the main path.** Research confirms Claude Code operates predominantly in the **normal** screen buffer during ordinary conversation, writing into scrollback while issuing cursor-movement and line-erase sequences (`\x1b[1A`, `\x1b[2K`) to re-render streaming blocks in place. It switches to the alternate buffer (`\x1b[?1049h`) only for transient full-screen views — `/config`, `/hooks`, visual diffs. The emulator must still track which buffer is active and snapshot the visible one (snapshotting the wrong one yields a permanently stable frame and a permanent false-idle), but the **main-path** hazard is the opposite of what this plan originally emphasised: it is in-place rewriting of the normal buffer via aggressive erase/reposition sequences, where a frame can change materially without the row count changing at all. A snapshot strategy that only diffs line *count* or scrollback *length* will see nothing happening during exactly the busiest moments. Diff rendered cell content, not buffer extent.
- **Terminal exited, and the operator-kill case is worse here than the draft assumed.** An exited pty renders a frozen frame, i.e. maximally stable, so `status` must be checked before idle is reported or every dead terminal reports "done". But `PtyFleetService.kill` (`:147-157`) does `this.terminals.delete(name)` **before** killing the process, so an operator-killed terminal has no handle and therefore no `status: 'exited'` to check — while its emulator instance survives in the detector's own map holding the last frozen frame, which is the worst possible combination: maximally stable, no status to veto it. Only a self-exit (`onExit`, `:103-111`) leaves the handle in place with `status: 'exited'`. This is a **hard** dependency on the prerequisite plan's `recentlyClosed` tombstone, not a nice-to-have.
- **Terminal renamed.** `rename` (`ptyFleetService.ts:159-171`) rekeys the fleet map and updates both `friendlyName` and `name`; the emulator map needs the same rekey the gateway already performs (`rekeyTerminal`, `terminalWsGateway.ts:634`).

  > **Superseded:** "the emulator map needs the same rekey the gateway already performs (`terminalWsGateway.ts:653`)."
  > **Reason:** `rekeyTerminal` is declared at `:634`; `:653` is inside its body (one of the `moveMap` calls). Minor, but a coder reading `:653` lands mid-function and misses the doc comment at `:614-633` explaining exactly why every name-keyed collection must be listed there — which is the part that matters for adding a new one.
  > **Replaced with:** `rekeyTerminal` at `:634`, and note its comment: "Keep this list in sync with `untrackTerminalData` — a name-keyed collection" is a standing instruction that a new emulator map must follow.

- **Non-agent seats.** A plain shell at a bash prompt is stable by definition. Only run detection for terminals that hold a live dispatched card; idle-detecting every seat is pure cost.
- **The "live dispatched card" predicate must be the widened one.** After the prerequisite liveness plan, a card's liveness basis is `MAX(dispatched_at, last_liveness_at)`, not `dispatched_at` alone. Gating on bare `dispatched_at IS NOT NULL` still works (the column is only nulled on clear), but gating on *age of* `dispatched_at` would stop detection at minute 10 on exactly the long-running turns this plan exists to serve. Use the same derive the board uses, not a fresh age comparison.
- **Blocking:** `pty-liveness-heartbeat-gates-activity-light-sweep` — establishes the fleet-handle `onData` ownership, the `recentlyClosed` tombstone (see the exited case above), and the widened derive predicate.
- **Advisory:** land `agent-emitted-completion-via-cli-hooks` first and measure real coverage. If hooks cover the agents actually in use, this plan may not be worth building — that is a legitimate and expected outcome. It also owns the `blocked` state and the single `clearWorkingState` decision path this plan extends.

## Dependencies

- **Blocking:** `pty-liveness-heartbeat-gates-activity-light-sweep`.
- **Advisory / measure first:** `agent-emitted-completion-via-cli-hooks`.
- Adds no migration. Consumes V58 `last_liveness_at` and V59 `blocked_at`.

## Resolved Assumptions

Settled by web research (Aug 2026). **Authoritative — do not re-open or re-research these.** Two answers validated the mechanics; two undercut the justification.

- **`@xterm/headless` API. RESOLVED, and simpler than assumed.** `buffer.active.getLine(y).translateToString(true)` and `line.getCell(x)` expose rendered text and cell attributes natively. `@xterm/addon-serialize` is **not** required — it is only for reconstructing ANSI/HTML from the framebuffer. One dependency, not two.
- **Node-safety and bundling. RESOLVED — confirmed safe.** Pure JS/TS, zero DOM, zero native code, ~300–400 KB, actively maintained by the VS Code core team. Bundles into `dist/standalone/ptyHost.js` and the extension bundle with no webpack externals change. `libvterm` wrappers are rejected: they require C compilation, which is unacceptable in a VSIX shipping without `node_modules`.
- **Whether Claude Code's status line ticks at idle. RESOLVED — and it refutes the plan's premise.** Idle re-rendering existed in mid-2025 builds and was **removed in v2.1.170+** to cut idle CPU. Bytes do stop at an idle prompt on current versions. See the superseded callouts in the root-cause section and the Complexity Audit. Net effect: raw-byte silence is unpredictable per-CLI rather than universally useless, masking is conditional rather than mandatory, and the case for building this plan is weaker than when it was written.
- **Alternate vs normal screen buffer. RESOLVED — the emphasis was backwards.** Claude Code uses the **normal** buffer for ordinary conversation, switching to alternate only for `/config`, `/hooks` and diff views. The main-path hazard is in-place rewriting of the normal buffer via erase/reposition sequences, not buffer switching. Diff cell content, not buffer extent.

Also noted from research and folded into the design: output continues flushing for some milliseconds *after* a turn-end hook fires (PTY buffer delay), so a stability clock must not be started from a hook event; and screen-stability inference is widely characterised as an anti-pattern precisely because subagent execution, delayed tool calls and network jitter produce false positives. That is independent corroboration of this plan's own adversarial synthesis, not a new objection.

Residual, and explicitly **not** a research question — it is a measurement, and it is the gate on whether this plan gets built at all: **do the specific hookless agent CLIs in use repaint at idle?** Nobody has measured them. If they do not, raw-byte silence solves the problem in a few dozen lines and this plan should be closed unbuilt. See Verification step 1.

## Adversarial Synthesis

Key risks: (1) the tap site was ambiguous between the fleet and the gateway, and resolving it the wrong way puts a second accumulator on the hot read path — the exact cost the plan exists to avoid; (2) operator-killed terminals leave a frozen frame with no `status` to veto it, making a false "done" the default outcome without the prerequisite plan's tombstone; (3) every masking rule is a guess about a third party's UI with a version half-life, and a stale rule fails silently in whichever direction it drifts. Mitigations: a gateway-exposed flush observer so there is one accumulator; a hard dependency on the tombstone rather than an assumption that `status` is readable; masking isolated in a per-agent profile with a conservative default that under-reports.

The honest case against this plan is that it is a large amount of machinery to re-derive, unreliably, information the agent could simply state. Every masking rule is a guess about someone else's UI; every guess has a version half-life; and the failure mode is silent — a masking rule that goes stale reports "busy forever" or "idle immediately", and neither announces itself.

The case for it is narrower but real: it requires nothing from the agent, so it works for CLIs that will never expose hooks, for wrapper scripts, and for custom roles. It is the only option that generalises without per-agent cooperation.

Given that, the correct posture is: build it **after** hook coverage is measured, keep it behind a setting that defaults off, and treat "we never needed it" as a successful outcome rather than sunk cost.

## Proposed Changes

### 1. `src/standalone/terminalWsGateway.ts` — expose the existing coalesced flush

> **Superseded:** "`src/standalone/ptyFleetService.ts` — an opt-in render tap. Extend the fleet handle with an optional `screenState` observer … Feed the emulator from the same coalesced path the gateway flushes on — not from the raw `onData` chunk handler."
> **Reason:** The coalescing accumulator (`pendingOutput` + `scheduleFlush` + the shared `OUTPUT_FLUSH_MS` interval) is private to `TerminalWsGateway`, in a different file from `ptyFleetService`. An observer owned by the fleet cannot reach it, so satisfying the instruction as written would require the fleet to build its own 6 ms accumulator — a second buffer on the hot read path, which is the specific regression the plan's own Complexity Audit forbids.
> **Replaced with:** The gateway exposes a flush observer; the detector subscribes to it. Ownership follows the accumulator.

- Add `public onFlush(cb: (terminalName: string, data: string) => void): { dispose(): void }`, invoked from the existing per-terminal flush (`flushOutput`, `~:432`) with the same coalesced string already being sent to clients. No new accumulation, no new timer — one extra callback per existing flush, and none at all when nothing is subscribed.
- Register the detector's emulator map in `rekeyTerminal` (`:634`) and its teardown in `untrackTerminalData` (`:578`), per the standing instruction in the `:614-633` comment.
- Note the availability consequence: the gateway is constructed only when `ptyReady` (`bootstrap.ts:1509-1510`), so screen-state detection is gateway-scoped. Document it at the setting.

### 2. New `src/standalone/ptyIdleDetector.ts`

- Wrap `@xterm/headless`: `write(chunk)`, `resize(cols, rows)`, `snapshot(): string`.
- `snapshot()` reads the *active* buffer directly — **no `@xterm/addon-serialize` needed.** Research confirms text and cell attributes are natively accessible: `terminal.buffer.active.getLine(y)?.translateToString(true)` for row text (with trailing whitespace trimmed) and `line.getCell(x)` for per-cell attributes. `buffer.normal` / `buffer.alternate` distinguish the buffers; `buffer.active` is the visible one. `@xterm/addon-serialize` is only required to reconstruct raw ANSI or HTML from the framebuffer, which this plan never does — do not add it.
- Apply the agent profile's masking to the assembled rows: cursor cell dropped, status-line rows dropped, digit runs normalised. Per the Complexity Audit, the default profile masks the cursor only; add rules per CLI only after measuring that CLI needs them.
- Hash on a ~2 s tick; N consecutive identical hashes (default 4, i.e. ~8 s) → idle.
- Export a per-agent profile map keyed by the same role/brand derivation the terminal list already uses, with a conservative default profile that masks only the cursor and reports idle rarely. Unknown agents should under-report, never over-report.
- Construct only for terminals holding a live dispatched card (using the board's own widened derive, not a fresh age comparison) and only when the setting is on. Tear down on both death paths and on the card clearing.
- Before reporting idle, veto on: `status === 'exited'` **or** presence in the fleet's `recentlyClosed` tombstone. The tombstone check is the one that covers operator kills, where no handle and therefore no `status` exists.

### 3. Consume the signal

Route idle through the *same* decision the hook plan's `stop` event uses — idle plus a plan-file `updated_at` advance is completion; idle without it is blocked. Do not add a second, parallel path to `clearWorkingState`; extend the one the hook plan establishes so both signals converge on one code path and one broadcast. Where the hook plan landed its `stop` handling (`LocalApiServer` `/agent/event` → resolve → decide), the detector calls the same decision function directly in-process rather than POSTing to itself.

### 4. `package.json` — one setting and one dependency

- `switchboard.activityLight.screenIdleDetection`, default `false`, beside the existing `switchboard.activityLight.timeoutMs` (`:557`) and the liveness plan's `livenessWindowMs`. Description should state plainly that it is a heuristic fallback for agents without hook support, and that it requires the terminal gateway (i.e. a PTY-capable host).
- Add `@xterm/headless` to `dependencies` alongside the existing `@xterm/*` entries (`:914-917`). No `webpack.config.js` externals change expected — standalone externalises only `node-pty` (`:161-163`).

## Verification Plan

Compilation and automated tests are out of scope for this session; the steps below are manual/observational.

1. **Gate the whole plan on this measurement — run it before writing any code.** Instrument raw-byte silence over the **specific hookless agent CLIs actually in use**, not over Claude Code. For each: does output stop at a bare idle prompt within a few seconds, and does it stay stopped for 5 minutes? If yes for all of them, **stop here and close this plan** — a silence timer over the existing `onData` handler solves the problem without an emulator, a masking profile, or a version coupling. Build what follows only for CLIs that measurably keep emitting at idle.

   > **Superseded:** "Instrument raw-byte silence over a live Claude seat and record that it never reports idle, including at a bare prompt for 5 minutes. Without this measurement the plan's premise is unverified."
   > **Reason:** Two problems. It measured the wrong CLI — Claude Code has hooks and will use the sibling plan, never this one — and its expected outcome is now known to be false on current versions (idle re-rendering was removed in v2.1.170+), so the step as written would "fail" while proving nothing about the agents this plan serves.
   > **Replaced with:** Measure the hookless CLIs, and treat "silence works" as grounds to close the plan rather than as a failed test.

1a. **Confirm the refuted premise, for the record.** Run the same instrumentation against a current Claude Code seat and confirm bytes *do* stop at idle. This is not a test of the feature; it documents why the plan's original justification was withdrawn, so a later reader does not reinstate it from the old reasoning.
2. **True idle.** Claude seat at an idle prompt, no dispatch. Detector reports idle within ~10 s and stays idle for 5 minutes without flapping. Log the hash each tick — a single flap is a masking defect, not noise.
3. **True busy.** Long tool-running turn. Detector reports busy throughout, including during a 60 s quiet stretch mid-API-call. Determine explicitly which mechanism is carrying the signal there: if the rendered elapsed counter keeps the frame unstable, the mask is not removing what it claims to; if the mask *is* removing it, something else must be supplying instability. Name it, or the test proves nothing.
4. **Alternate buffer.** Run a full-screen TUI (`htop`, `vim`) in the seat. No false idle while it is being interacted with; correct idle when it is left alone.
5. **Resize.** Resize the pane mid-turn. No idle→busy→idle flap on the card.
6. **Exited terminal — both death paths.** (a) Let the agent exit on its own: frozen frame is not reported as idle, vetoed by `status`. (b) Close the terminal from the panel: frozen frame is not reported as idle, vetoed by the `recentlyClosed` tombstone. Confirm the emulator is torn down in both cases and the detector's map is empty afterwards.
7. **No double completion.** With the hook plan landed and a Claude seat emitting events, confirm the detector does not construct an emulator for that terminal, and that a completed turn produces exactly one `broadcastAgentCompleted`. Then force both signals on for one terminal (temporary stub) and confirm the transition gate still yields one broadcast, not two.
8. **Long-turn gating.** Dispatch a turn that runs past `timeoutMs`. Detection must still be active at minute 15 — proving the gate uses the widened liveness derive rather than the raw `dispatched_at` age.
9. **Cost.** Measure interactive latency and extension-host CPU with 8 fleet terminals under heavy output, detection on and off. A measurable typing-latency regression fails the plan outright. Confirm the flush observer adds no accumulation by checking that `pendingOutput` behaviour and flush cadence are unchanged.
10. **Bundle.** Confirm `@xterm/headless` webpacks into both `dist/standalone/ptyHost.js` and the standalone package, and that the VSIX still loads with no `node_modules`.
11. **Default-off parity.** With the setting off, no emulator is constructed, no flush observer is registered, and behaviour is byte-identical to `main`.
12. **Gateway-less host.** With `isPtyAvailable()` false (no gateway), enabling the setting is inert and logs once rather than throwing.

## Recommendation

**Do not build yet. Run Verification step 1 first — it is now more likely than not to close this plan.**

If step 1 shows the hookless CLIs in use keep emitting at idle, then send to Lead Coder (complexity 7) and build as specified. If it shows they go quiet — which is what current Claude Code does, and there is no reason to assume other CLIs are noisier — the correct deliverable is a raw-byte silence timer over the `onData` handler subtask 1 already establishes: a few dozen lines, no new dependency, no masking profile, no version coupling. That would be this plan succeeding by making itself unnecessary.

The research pass moved this plan's expected value down, not up. Its original justification was that byte silence *cannot* work; the actual finding is that byte silence is *unpredictable per CLI*, and the cheap way to handle unpredictability is to measure rather than to pre-emptively build an emulator. Two of the four resolved assumptions validated the mechanics (`@xterm/headless` is the right library and bundles cleanly); the other two removed the reason to reach for it.

Ordering is unchanged: liveness heartbeat first because it fixes a live defect; hooks second because they are the correct mechanism and deliver the blocked state; this one third **and conditionally**, gated on a measurement rather than on the other two landing. If it is built, keep it default-off permanently — a heuristic that silently degrades should never be the path a user is on without choosing it.

## Completion Report

Subtask 3 was not built, following the plan's own recommendation to gate construction on Verification step 1. The required measurement — whether the specific hookless agent CLIs in use stop emitting bytes at an idle prompt — cannot be run in this environment because no such CLI sessions were available. Without that empirical signal, building the headless VT emulator would violate the plan's corrected premise (byte silence is unpredictable per CLI, not universally useless) and risk adding a large, version-coupled fallback that the actual CLIs may not need. The liveness heartbeat from subtask 1 already provides a byte-silence foundation; the hook plan from subtask 2 covers the agents that expose lifecycle events. No files were changed for this subtask. The correct next step is to instrument the actual hookless CLIs in use and either build the raw-byte silence timer or the full emulator based on what the measurement shows.

## Review Findings

Closure verified legitimate, not a skipped task: the plan's own `## Recommendation` says "**Do not build yet**" and gates construction on Verification step 1, a measurement of whether the hookless CLIs actually in use repaint at idle — which cannot be run without those CLI sessions present. Confirmed the closure is clean rather than half-done: no `@xterm/headless` entry in `dependencies`, no `switchboard.activityLight.screenIdleDetection` setting, no `src/standalone/ptyIdleDetector.ts`, no `onFlush` observer on `TerminalWsGateway`, and no orphaned references to any of those identifiers anywhere in `src/`, `package.json` or `webpack.config.js`. The two prerequisites this plan depends on did land in reviewable shape — subtask 1's `recentlyClosed` tombstone (the hard dependency for vetoing frozen frames from operator-killed terminals) and subtask 2's single `clearWorkingState` decision path, which now returns a real transition boolean so a future third signal can converge on it without producing a double broadcast. No files were changed for this subtask by the coder or by this review. The outstanding action is unchanged and belongs to the operator, not to code: instrument raw-byte silence against the specific hookless CLIs in use, then either write the few-dozen-line silence timer over subtask 1's existing `onData` subscription or reopen this plan.
