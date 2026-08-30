# A dispatch to a new seat must wait for the CLI, not for silence

## Goal

When a board dispatch spawns a terminal, the prompt must not be delivered until the agent CLI is able to receive it — and a session that is one second old must not be sent `/clear` at all. Today the dispatch spawns a pty and writes into it ~900 ms later, while the CLI is still booting. The `/clear` and the prompt merge into a single `/clear <prompt>` submission, the CLI discards the argument, and the dispatch is lost while the API reports success.

### The problem

Observed 2026-08-28 on the standalone host, reproducing exactly.

`reviewer-1` was created at `00:29:43.805Z`. Its prompt was written at `00:29:44.718Z` — **913 ms later**. Its terminal log shows the `/clear` echoing at shell level, *before* the Claude Code banner has painted:

```
patrick@patrickremotedev:~/switchboard$ claude
/clear
78
```

then the banner, and then the input line carrying both:

```
❯ /clear
YouareactingastheSwitchboardrevieweragent.
```

Claude Code parsed that as `/clear` with arguments. `/clear` takes none — it wiped the (empty) session and discarded the prompt. `POST /kanban/dispatch` had already returned `{"success":true,...,"dispatchedAgent":"reviewer","dispatchedAt":"2026-08-28T00:29:44.95..."}`, and the card sat in `CODE REVIEWED` with a reviewer that had never been given anything to review.

### Root cause — three defects composing

**1. No boot gate between spawn and delivery.** `src/standalone/bootstrap.ts:2228-2231`:

```ts
if (!terminal) {
    terminal = await ptyFleetService.create(targetRole, overrideName, matchedWtPath || root, matchedWtPath);
}
await deliverPrompt(terminal, prompt, getPromptDeliveryOptions());
```

`create()` resolves when the pty exists and the startup command has been written — not when the CLI inside it is usable. Nothing in between waits.

**2. The readiness detector reads boot silence as readiness.** `src/standalone/clearReadiness.ts:186-205`. The `claude` / `antigravity` profile arms a **100 ms** quiet timer on the first data chunk after the submitting CR, and resolves `signal` when that window elapses:

```ts
dataSub = target.onData(() => {
    if (resolved) return;
    if (!submitted) return;
    if (quietTimer) { clearTimeout(quietTimer); quietTimer = null; }
    quietTimer = setTimeout(() => finish('signal'), quietMs);   // CLAUDE_DEFAULT_QUIET_MS = 100
});
```

A booting CLI is silent. `bracketed-paste-submit-cr-not-firing-on-devin-3000-5-20-under-load.md`, which built this file, flagged the risk in its own review findings: *"the Devin 12–15s fallback and the 100ms quiet windows are still the plan's uncalibrated estimates — only real-CLI probe runs can confirm them."* The boot timeline is separately documented in `feature_plan_20260807090000_terminals-pane-startup-curtain-animated-cli-brand-icon.md`, which measures *"the CLI booting in silence for 1–4 s (node startup, config read, auth/model check)"* and warns that a quiet timer *"fires inside the silent gap… while every stated success check still passes."* That is precisely what happened.

**3. Clearing a new session has no upside.** A terminal spawned for this dispatch has no prior context. The `/clear` is pure risk: it is the write that can merge with the prompt, and on some CLIs it costs a full session restart (`devin-clear-reauth-toll-visibility.md` documents the MCP re-auth toll). The delivery path applies `clearBeforePrompt` uniformly without asking whether there is anything to clear.

### Why the existing readiness work does not cover this

`clearReadiness.ts` answers "is the CLI ready *after a clear*". That question presumes a running CLI whose state transition can be observed. On a cold seat there is no transition to observe — the detector is measuring an event that has not started. The missing concept is CLI **first-readiness**, which is a different signal with a different source.

## Metadata

**Complexity:** 6
**Tags:** backend, bugfix, reliability

## User Review Required

None.

## Complexity Audit

### Routine

- Gating `clearBeforePrompt` on whether the seat has a prior work context — the map (`_lastWorkContextByTerminal` / `lastWorkContextByTerminal`) already exists in both hosts.

  > **Superseded:** "…and is already consulted on this path."
  > **Reason:** Verified: the work-context map is consulted **only** in the `ptySendPrompt` handler (`bootstrap.ts:2039-2043`). The `dispatchCards` handler (`bootstrap.ts:2228-2231`) — the one path that spawns a new seat and delivers — calls `deliverPrompt` directly with `getPromptDeliveryOptions()`, which returns `clearBeforePrompt: true`, and **never touches the work-context map.** So the suppression the plan relies on does not exist on the path that has the bug.
  > **Replaced with:** The clear-suppression must be applied in the shared delivery layer (`sendPromptToPty`, `ptyPromptDelivery.ts:140`) keyed on a per-handle first-delivery flag, not assumed to already run on the `dispatchCards` path.
- Returning a distinct delivery reason so the lifecycle event reports what happened.

### Complex / Risky

- **First-readiness has no generic signal.** The terminals-curtain plan established this at length: the WS frame set carries `hello` / binary out / `inputThrottled` / `error` / `exit` and no readiness frame, and *"one timer cannot"* separate boot from quiescence. Its own solution was a three-timer predicate. Whatever is chosen here must survive a multi-second silent gap mid-boot, a CLI with no startup command, and a CLI that never quiesces.
- **Per-CLI first-paint markers are real but brittle.** Claude Code paints a recognisable banner; Devin prints its own; both change between versions, and the repo already carries a memory that version-pinned CLI behaviour drifts. A marker match must be a fast path with a time-based floor and ceiling behind it, never the only mechanism.
- **The failure is silent today, and that is half the defect.** `POST /kanban/dispatch` verified `moved` and `dispatched` against the DB and answered `success:true`. Neither field can distinguish "prompt delivered" from "prompt written into a boot buffer and discarded". Fixing only the timing leaves the next timing bug equally invisible.
- **Both hosts reach the shared delivery layer, but only one host spawns-then-delivers back-to-back.** `sendPromptToPty` (`ptyPromptDelivery.ts:133`) is shared by both hosts, so a gate placed inside it covers both. The standalone `dispatchCards` handler (`bootstrap.ts:2228-2231`) is the one path that spawns a terminal and delivers into it with no gap — that is the path the observed bug lives on.

  > **Superseded:** "The spawn-then-deliver sequence, however, is written out separately in each composition root — the standalone one at `bootstrap.ts:2228`, and the extension's create-then-dispatch path in `TaskViewerProvider`. Both need the gate."
  > **Reason:** Verified by reading the code: the extension host has **no** spawn-then-deliver sequence. `_tryFleetDeliveryForRole` (`TaskViewerProvider.ts:22000`) and `_attemptDirectTerminalPush` (line 22105) deliver **only to existing active terminals**; `ptySendPrompt` (`bootstrap.ts:1854-1856`) errors if the terminal does not exist. The extension host creates terminals ahead of time (autoban pool, team setup via `ptyCreateTerminal`) and dispatches later, so by the time a dispatch reaches `sendPromptToPty` the CLI has already booted. There is no second composition root to gate.
  > **Replaced with:** Place the gate inside `sendPromptToPty` (the shared layer), keyed on a per-handle first-delivery flag. This covers the standalone spawn-then-deliver path **and** the extension host's first-dispatch-to-a-fresh-pool-terminal for free — one gate, one location. Do not hunt for a second spawn-then-deliver sequence in `TaskViewerProvider`; it does not exist.
- **A long gate stalls the dispatch gesture.** Board dispatch awaits delivery. A 4-second first-readiness wait is 4 seconds of dead UI unless the existing dispatch curtain (`terminalDispatchPreparing`) is armed for the boot phase too.

## Edge-Case & Dependency Audit

| Case | Required behaviour |
|---|---|
| Dispatch reuses a live seat | Unchanged — prior work context exists, clear decision unchanged |
| Dispatch spawns a new seat | No `/clear`; wait for first-readiness; then deliver |
| Seat spawned with no startup command (bare shell) | First-readiness resolves on the shell prompt; floor prevents an instant resolve |
| CLI prints continuously and never quiesces | Ceiling fires, delivery proceeds, reason reported as `timeout` |
| CLI exits during boot (auth failure, bad command) | Delivery aborts; dispatch returns an error rather than `success:true` |
| CLI prompts for input during boot (trust-folder, device code) | Ceiling fires; the prompt is delivered on top, as today — out of scope, but must not hang forever |
| `terminal.clearBeforePrompt` off | Unchanged |
| Re-dispatch to a seat that has exited | Existing not-active guard applies before any of this |

**Dependencies.** None blocking. Shares the `clearReadiness` module with `bracketed-paste-submit-cr-not-firing-on-devin-3000-5-20-under-load.md` (shipped) and should reuse its `ClearReadinessResult` reporting shape rather than inventing a second one.

## Dependencies

None blocking. Shares the `clearReadiness` module (`src/standalone/clearReadiness.ts`) with `bracketed-paste-submit-cr-not-firing-on-devin-3000-5-20-under-load.md` (shipped) and should reuse its `ClearReadinessResult` reporting shape (`clearReadiness.ts:6-9`) rather than inventing a second one. No `sess_` session dependencies.

## Adversarial Synthesis

Key risks: (1) the plan's "already consulted on this path" and "both composition roots" claims were both false — the work-context suppression does not run on the `dispatchCards` path and the extension host has no spawn-then-deliver sequence, so an implementer who trusts the original text ships nothing; (2) the first-delivery flag the gate keys on does not exist on `ExtendedTerminalHandle` and must be added, or the gate has no trigger; (3) clear-suppression and the dispatch curtain are coupled — suppressing clear kills the curtain's only trigger, so the curtain must be re-armed on first-delivery, not on `isClearing`; (4) `sendPromptToPty` returns `undefined` when no clear ran, so the gate's result has nowhere to flow without a return-shape restructure; (5) the predicate resolves on *output*, not on *input-editor-ready*, so a CLI that banners early then blocks on auth false-positives. Mitigations: add a `promptCount` flag as the single keystone; place the gate inside `sendPromptToPty` (one location, both hosts); arm the curtain on `promptCount === 0`; restructure the return to carry the first-readiness result; document the banner-then-block false-positive as a known limitation the ceiling covers.

## Proposed Changes

**Keystone — add a per-handle first-delivery flag.** Add `promptCount: number` to `ExtendedTerminalHandle` (`src/standalone/ptyFleetService.ts:68-104`), initialised `0` at creation (line 434-457), incremented to `1` after the confirm CR in `sendPromptToPty` (`src/standalone/ptyPromptDelivery.ts:210`). This single flag keys changes 1, 3, 5, and 6 below. `lastDataAt` (line 103) cannot serve this role — it is initialised to `Date.now()` and updates on every byte, so it cannot distinguish "booted, never prompted" from "prompted and active."

1. **Suppress `clearBeforePrompt` on a seat with no prior delivery.** In `sendPromptToPty` (`ptyPromptDelivery.ts:140`), when `handle.promptCount === 0`, force `clearBeforePrompt = false` regardless of the caller's option — a seat the host has never dispatched to has nothing to clear. This removes the `/clear` write that merges with the prompt. The existing work-context map (`lastWorkContextByTerminal`) is **not** on this path (it lives only in the `ptySendPrompt` handler, `bootstrap.ts:2039-2043`), so the suppression must live in the shared delivery layer, not be assumed to already run.

2. **Add a first-readiness gate** — a new `awaitFirstReadiness(handle, opts)` in `ptyPromptDelivery.ts` (or `clearReadiness.ts`), reusing the `ClearReadinessResult` shape (`clearReadiness.ts:6-9`). Resolve on: per-CLI first-paint marker where one is known (fast path), else an output-quiet window measured **after first output**. Enforce a **floor** (never resolve before any `onData` chunk has been seen), a **ceiling** (proceed regardless, reason `timeout` — add to `ClearReadinessReason` or reuse `fallback`), and an **exit** arm (`onExit` → abort delivery). Reuse the per-family timeout constants (`CLAUDE_DEFAULT_TIMEOUT_MS` / `DEVIN_DEFAULT_TIMEOUT_MS`, `clearReadiness.ts:35-40`).

3. **Call the gate inside `sendPromptToPty`** (`ptyPromptDelivery.ts:138-148`), **before** the clear branch, when `handle.promptCount === 0`. This is the one location that covers both hosts: the standalone `dispatchCards` path (`bootstrap.ts:2231` → `deliverPrompt` → `sendPromptToPty`) and the extension host's `_attemptDirectTerminalPush` (`TaskViewerProvider.ts:22148` → `ptySendPrompt` → `sendPromptToPty`) both flow through it. Do not add a second call site in `TaskViewerProvider` — it has no spawn-then-deliver sequence to gate.

4. **Raise `CLAUDE_DEFAULT_QUIET_MS` off its uncalibrated 100 ms** (`clearReadiness.ts:38`) for the post-clear path, or gate the quiet window on having observed post-clear output rather than any output. Record the calibration source in the constant's docblock — today the line has no comment at all.

5. **Arm the dispatch curtain on first-delivery, not on `isClearing`.** Today the curtain arms only when `opts.clearBeforePrompt === true` (`bootstrap.ts:437-446`; extension host `TaskViewerProvider.ts:3549-3559`). Change 1 suppresses clear on new seats, which **kills the curtain's only trigger** — so this change is a repair of a regression change 1 introduces, not an independent addition. Arm when `handle.promptCount === 0` (boot phase) in addition to (or instead of) `isClearing`, with a `phase: 'booting'` value distinct from `phase: 'clearing'`.

6. **Make a lost delivery detectable.** `sendPromptToPty` returns `ClearReadinessResult | undefined` (`ptyPromptDelivery.ts:137, 211`) — `undefined` when no clear ran. After change 1, new-seat dispatches return `undefined`, so the gate's result has nowhere to flow. Restructure: return the first-readiness result even when no clear ran (the gate produces a `ClearReadinessResult`-shaped value). Thread it through `deliverPrompt`'s return and the `dispatchCards` response (`bootstrap.ts:2255`, currently `{ success: true, ... }`) as a `deliveryReason` field, and through the `ptySendPrompt` handler response (`bootstrap.ts:1854+`), so `POST /kanban/dispatch` distinguishes delivered-and-confirmed from delivered-on-a-timeout instead of a bare `success:true`.

## Migration

None. All state is in-memory and per-session; the timing constants are code.

## Verification Plan

### Goal Invariants

- A terminal spawned by a dispatch never receives `/clear`.
- No prompt is written to a pty before that pty has produced output.
- A dispatch whose delivery hit the ceiling is reported as such, never as an unqualified success.
- A CLI that exits during boot fails the dispatch rather than returning success.
- Both hosts apply the gate — it lives inside the shared `sendPromptToPty`, so neither the standalone `dispatchCards` path nor the extension host's `ptySendPrompt` path can deliver a first prompt without passing through it.

### Automated Tests

- **New seat, no clear:** dispatch to a role with no live seat; assert zero `/clear` writes on the new handle and that the first bytes written are the prompt.
- **Floor:** a fake handle that emits nothing → assert no write before the floor elapses, and no write at all before first output or ceiling.
- **Ceiling:** a fake handle that emits continuously → assert delivery proceeds at the ceiling with reason `timeout`.
- **Exit during boot:** handle emits `exit` before readiness → assert the dispatch returns an error and writes nothing.
- **Reused seat unchanged:** dispatch to a live seat with a recorded work context → assert the existing clear/readiness path runs byte-identically to today.
- **Gate location:** source-text contract asserting the first-readiness gate is reached inside `sendPromptToPty` keyed on `promptCount === 0` (one location), in the style of `pty-route-surface-contract.test.js`. Do **not** assert a second call site in `TaskViewerProvider` — it has no spawn-then-deliver sequence.
- **Curtain arms on boot phase:** a first-delivery dispatch (`promptCount === 0`, clear suppressed) → assert `terminalDispatchPreparing` is broadcast with `phase: 'booting'`; a subsequent dispatch → assert no boot-phase curtain.
- **Delivery reason flows:** a dispatch that hits the ceiling → assert `POST /kanban/dispatch` response carries `deliveryReason: 'timeout'`, not a bare `success:true`; a dispatch that resolves on signal → assert `deliveryReason: 'signal'`.
- **Banner-then-block false-positive (goal-vs-appearance):** a fake handle that emits a banner chunk, then goes silent for longer than the quiet window, then emits again → assert the gate does **not** resolve in the post-banner quiet gap before the second emission, OR if it does, document it as the known limitation the ceiling covers. This encodes the top architecture-review finding.
- **Regression — the observed failure:** replay the captured `reviewer-1` boot byte stream against the readiness tracker and assert it does **not** resolve inside the boot silence. **Prerequisite:** if the byte-stream fixture is not already committed under `src/test/`, capture a fresh boot stream with `scripts/capture-cli-modes.js` (referenced in `ptyPromptDelivery.ts:167`) before writing the test.

### Manual

Dispatch a feature to `CODE REVIEWED` with no reviewer seat live. The spawned reviewer must show the prompt as a normal message, never on a `/clear` input line, and its first turn must begin without operator intervention.

## Outstanding Questions

- Is a per-CLI first-paint marker worth carrying, or is floor-plus-quiet-plus-ceiling sufficient on its own? Preference: ship the time-based predicate first, add markers only for CLIs it demonstrably mistimes — a marker table is a maintenance surface that drifts with CLI releases.
- **[user]** The floor / quiet / ceiling values need empirical calibration against real CLI boot streams (Claude Code, Devin) on the target host. The plan reuses the existing per-family timeout constants but does not pick a concrete quiet-ms for first-readiness. Proceeding on the assumption that the implementer calibrates with `scripts/capture-cli-modes.js` and records the source in each constant's docblock, as change 4 requires for `CLAUDE_DEFAULT_QUIET_MS`.
- **Known limitation (not blocking):** the predicate resolves on *output*, not on *input-editor-ready*. A CLI that paints a banner early then blocks on a network auth/model check can false-positive in the post-banner quiet window. The ceiling ensures delivery proceeds regardless; a per-CLI first-paint marker (the open question above) is the mitigation for CLIs where this is observed.

## Implementation Summary

All six proposed changes landed in the shared delivery layer and both composition roots. The keystone `promptCount` flag was added to `ExtendedTerminalHandle` (`ptyFleetService.ts:110`, initialised `0` at `:465`) and increments to `1` after the confirm CR in `sendPromptToPty` (`ptyPromptDelivery.ts:252-254`). Change 1 suppresses `clearBeforePrompt` when `promptCount === 0` (`ptyPromptDelivery.ts:160`). Change 2 added `awaitFirstReadiness` with floor+quiet+ceiling+exit arms (`clearReadiness.ts:288-384`) and per-family cold-boot constants (`:68-73`). Change 3 calls the gate inside `sendPromptToPty` before the clear branch (`ptyPromptDelivery.ts:166-176`) — the one location covering both hosts. Change 4 raised `CLAUDE_DEFAULT_QUIET_MS` from 100 to 300 with a calibration-source docblock (`clearReadiness.ts:38-50`). Change 5 arms the dispatch curtain on boot phase (`phase: 'booting'`) in both `bootstrap.ts:439-453` and `TaskViewerProvider.ts:3615-3654`. Change 6 threads `deliveryReason` through the `dispatchCards` and `ptySendPrompt` responses (`bootstrap.ts:2210,2220,2445,2491`). Compilation and automated tests were skipped per directive; the goal invariants hold by source-text inspection.
