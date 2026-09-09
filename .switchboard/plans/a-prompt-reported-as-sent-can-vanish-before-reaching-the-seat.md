# A Prompt Reported as Sent Can Vanish Before Reaching the Seat

## Goal

`ptySendPrompt` must report whether a prompt **arrived**, not whether bytes were handed to a pty. A
send that vanishes has to come back as a failure the lead can retry, not a success it waits on.

### Problem analysis

A lead dispatched a fix round to `Coding-coder-1` and got a success receipt. Nothing arrived — the
text did not appear in the seat's input field, unsent or otherwise. It was simply not there. Told to
resend, the lead reformatted and the second attempt landed.

```
14:20:12   {"success":true,"bytesWritten":1343,"promptSeq":2,"bootPhase":false}   never arrived
14:22:36   {"success":true,"bytesWritten":1339,"promptSeq":3,"bootPhase":false}   arrived
```

The lead's own account of the difference: *"Same substance, different formatting. First had `\n\n`
line breaks and escaped quotes around the criterion. Second collapsed line breaks to spaces."*

#### The defect that is certain: success means "we wrote bytes"

`src/standalone/bootstrap.ts:2838` returns `success: true` for every outcome except one —
`receipt.readiness.reason === 'exit'`, a CLI that died during boot. There is no other failure branch.
`bytesWritten` is the count of bytes handed to the pty handle; a write to a pty master succeeds
whether or not anything on the other end is alive, reading, or in a state to accept a paste. So the
receipt cannot distinguish *delivered* from *written into a void*, and the caller is told to wait for
a callback that will never come.

That is the bug to fix regardless of which mechanism swallowed this particular prompt: **an
unverifiable success is worse than a failure**, because the lead blocks on it.

#### What has been ruled out

- **Ambiguous name resolution.** `tmuxBackend.ts:239` derives a seat's name from `pane_title` or else
  `window_name`, so duplicate window names would resolve ambiguously — and earlier today the same
  team did carry three windows per name. But not at send time: the seat generation running at 14:20
  started 13:59:22–13:59:27, four windows, four distinct names. (The `5 ×` count per name in
  `list-panes -a` is the five grouped session views sharing one window list, not duplicates.)
- **The `\x1b[201~` chunk split.** `ptyPromptDelivery.ts:265` documents delivery breaking when
  `text.length % 256 ∈ [245,249]`. `1343 % 256 = 63`, `1339 % 256 = 59`; neither payload qualifies,
  framed or not.
- **"Pasted text lands in the input field unsent."** The failure the unconditional second CR at
  `ptyPromptDelivery.ts:270` exists to prevent. Operator observation is that nothing appeared at all.
- **Payload formatting.** Tested directly: a probe carrying 9 real newlines and 20 double quotes
  (1,055 bytes of text, 1,833 written) was sent to the same seat in the same idle-after-completion
  state and **arrived intact**, and the seat acknowledged it. The two 14:20/14:22 payloads differ only
  in newlines and escaped quotes, so the lead's explanation — *"first had `\n\n` line breaks and
  escaped quotes ... second collapsed line breaks to spaces"* — is post-hoc correlation on one trial.
  Formatting is not sufficient to cause the loss.
- **A clear racing delivery.** Operator confirms the terminal was not cleared.
- **A busy seat.** Operator confirms the seat had finished and was awaiting dispatch after a review.
- **The seat was mid-tool-call.** Operator confirms it had been completely idle for two minutes.
- **A stale pty handle.** A handle cached from the 13:59 seat generation would explain a write that
  buffers into a dead pty — but not the recovery: the retry landed ~20 s after the operator spoke,
  with nothing in between that would re-resolve a handle. A stale handle does not heal itself.

#### The mechanism is not identified, and that is the finding

Every hypothesis available from the evidence has been eliminated (above). The event is n=1, does not
reproduce on demand, and the surviving explanations all require something the system does not record.
Guessing further is not useful; **this plan therefore does not propose a root-cause fix.** It proposes
making the next occurrence diagnosable in one reading, and making the success signal honest in the
meantime.

#### The observability gap

Nothing the host exposes could distinguish any of the eliminated causes, then or now:

- The receipt carries `bytesWritten`, `promptSeq`, `deliveredAt`, `bootPhase`, `cleared` — **and no
  identity for what it wrote to.** No pane id, no pty id, no pid.
- `GET /health` publishes seats as bare names — `["Coding","Coding-coder-1","Coding-coder-2",
  "Coding-intern"]` — with no handle behind them, so a stale or mismatched handle is invisible from
  outside the process.
- Names resolve through `deriveFriendlyName` (`tmuxBackend.ts:239`), which prefers `pane_title` then
  `window_name`, so a name is not a unique key and nothing reports which candidate won.

A prompt can therefore be written, counted, reported as sent, and lost, with no artefact anywhere
that says where it went. That is the actual defect: not a delivery bug, an accountability one.

## Metadata

**Complexity:** 6
**Tags:** [reliability, bugfix]
**Dependencies:** none

## User Review Required

Change 2 makes some sends that currently report success report failure instead. Confirm a lead
retrying on failure is preferred to it waiting on a callback that never arrives.

## Complexity Audit

### Routine
- Adding `paneId` / `panePid` / `pid` fields to the existing receipt object — additive, no behaviour change.
- Mirroring `scripts/capture-cli-modes.js` into a new diagnostic harness — self-contained, no production path touched.
- The framing regression test already passes; it stays as a guard.

### Complex / Risky
- **Two-host divergence.** The extension host's delivery path is a Go binary
  (`cmd/switchboard-pty-host/prompt.go`, `deliverPrompt`), NOT the TS standalone path. It carries the
  identical false-success defect (`success: true, bytesWritten: len(text)` after writing to the master
  fd at `prompt.go:267`). Every change to the success signal must land in BOTH `ptyPromptDelivery.ts`
  (standalone) AND `prompt.go` (extension), or the two hosts diverge with no gate catching it —
  `scripts/check-standalone-push-parity.js` is scoped to the browser read-back path, not the
  composition root or the receipt shape (the exact precedent CLAUDE.md records for the queue seams).
- **Arrival verification is net-new machinery with a false-positive surface.** Reading the pane back
  and asserting the payload's signature is present can pass while the prompt sits *unsent* in the
  input box (the devin 3000.5.20 failure mode documented at `ptyPromptDelivery.ts:283`: the CLI echoes
  the pasted text but the confirm CR inserts a literal newline instead of submitting). The check must
  require the *stronger* signal (input cleared / turn started), not the weaker (text echoed), or it
  replicates the false-success one layer up.
- **`capture-pane` is tmux-specific; the Go host is not tmux-based.** The Go pty host owns its own pty
  and reads via an internal ring buffer (`f.rings[name]` fed by `readOutput`), not `capture-pane`.
  Arrival verification needs a different read-back mechanism per host.

## Edge-Case & Dependency Audit

**Race Conditions**
- A clear dispatched immediately after a prompt (the existing `ptyClearAllTerminals` /
  roster-barrier path) can erase the prompt before the read-back samples the pane. The verification
  must either complete before any sibling clear can run (it already holds the per-terminal
  `sendLocks` lock, so a clear via `writeSlashCommand` is serialised behind it — confirm this holds
  for the Go host's `t.mu` too) or report the prompt as not-delivered.
- The read-back samples a moving buffer. A CLI that redraws between the confirm CR and the sample can
  scroll the payload's signature out of the captured window. A bounded wait with re-sampling (as the
  settle machinery does) mitigates; a single snapshot does not.

**Security**
- No new surface. The receipt gains identity fields already held in-process; no secret crosses a
  boundary.

**Side Effects**
- Change 2 adds latency to EVERY successful send (the read-back wait). On a warm devin seat the
  family floor is already 15s; the read-back is additive on top. Quantify the added latency in the
  capture script and confirm it is acceptable, or gate the read-back behind a configurable timeout
  with a fast ceiling.
- `deliverPrompt` at `bootstrap.ts:698` broadcasts `terminalDispatchFinished` with `success: !sendErr`
  to the browser. A vanished send that does not throw broadcasts success to the UI too — the
  browser-side dispatch light clears on a lost prompt. The honesty fix must propagate to this
  broadcast, not only to the returned receipt.

**Dependencies & Conflicts**
- The `pty-prompt-delivery-framing.test.js` contract asserts the exact write sequence and
  `CONFIRM_CR_COUNT`. A read-back step that issues extra writes (e.g. a probe) would break the
  byte-sequence parity assertion. The read-back must READ only (`capture-pane` / ring-buffer
  inspection), never write.
- The Go host's `deliverPrompt` and the TS `sendPromptToPty` are independent implementations of the
  same contract (the TS file's header says "PORTED VERBATIM from _sendRobustTextBackground"). A
  receipt-shape change must be applied to both; a new test contract must assert parity, not just the
  TS side.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) the plan as originally written fixes only the standalone TS host and silently leaves
the extension's Go pty host with the identical false-success — a divergence no gate catches; (2)
arrival verification that accepts "payload text is visible in the pane" as success replicates the
hollow-success bug one layer up, because a CLI can echo pasted text without submitting it; (3) the
read-back adds latency to every send and can false-negative on a redraw. Mitigations: mandate both
hosts in every change; require the *turn-started* signal (input cleared / composer handed off), not
the *text-echoed* signal; bound the read-back wait and make it additive to, not a replacement for, the
write-side liveness gate.

## Proposed Changes

### 1. The receipt names its target — BOTH hosts

> **Superseded:** Original framing named only `src/standalone/bootstrap.ts:2838` and
> `src/standalone/tmuxBackend.ts`.
> **Reason:** The extension host does not route through `bootstrap.ts` or `tmuxBackend.ts` for
> delivery — its pty host is the Go binary `cmd/switchboard-pty-host/prompt.go`, whose `deliverPrompt`
> (line 144) returns `success: true, bytesWritten: len(text)` with no target identity. Fixing only the
> standalone TS path leaves the extension host with the identical hollow-success and diverges the two
> hosts with no gate catching it (`check-standalone-push-parity.js` is scoped to browser read-back,
> not the receipt).
> **Replaced with:** Carry the resolved target identity in the receipt on BOTH hosts.

- **Standalone (`src/standalone/bootstrap.ts:2838`, `src/standalone/tmuxBackend.ts`):** carry the
  resolved target in the receipt — `paneId`, `panePid`, and the handle id actually written to. Resolve
  seats to a stable `pane_id`, never a derived friendly name, and fail loudly when a name matches
  more than one pane instead of taking the first.
- **Extension (`cmd/switchboard-pty-host/prompt.go:267`):** the Go host already tracks `t.pid`
  (`main.go:106`); add `pid` and `name` to the `out` map at `prompt.go:267`. The Go host keys terminals
  by name directly (no `deriveFriendlyName` ambiguity), so the ambiguity-fail is standalone-only —
  but the missing identity in the receipt is shared and must be fixed here too.

### 2. Verify arrival before reporting success — BOTH hosts, with the STRONG signal

> **Superseded:** "after the confirm CR, read the pane back and assert the payload's own signature
> is present (echoed, or the input cleared and a turn started)" — accepting the echoed-text branch.
> **Reason:** A CLI can echo the pasted payload into its input box WITHOUT submitting it (the
> devin 3000.5.20 failure at `ptyPromptDelivery.ts:283`: the confirm CR inserts a literal newline, the
> text sits visible-but-unsent). A signature-presence check that accepts "echoed" as success passes
> while the prompt never started a turn — the exact hollow-success this plan exists to kill, moved
> one layer up. The "or" in the original wording is the load-bearing defect.
> **Replaced with:** The read-back must require the STRONG signal — the input line cleared and/or the
> composer handed off to a turn — never the weak "payload text is visible" signal alone.

- **Logic:** after the confirm CR, read the pane back and assert the turn has *started* (input
  cleared, or the CLI's composer transitioned to a processing state), not merely that the payload's
  text is visible. Return `success: true` only then; add `deliveryVerified: boolean` and
  `submitted: boolean` to the receipt so a partial outcome is reportable. Keep `bytesWritten`, but it
  stops being the success signal.
- **Standalone (`src/standalone/ptyPromptDelivery.ts`):** a bounded wait against `capture-pane`,
  reusing the *settle-window* idiom (the quiet-timer re-arm pattern) already in this file — NOT the
  clear-readiness tracker itself, which is about `/clear` re-render, not post-submit verification.
  This is net-new machinery; "reusing the settle machinery" in the original wording overstates what
  is there.
- **Extension (`cmd/switchboard-pty-host/prompt.go`):** the Go host is not tmux-based — it has no
  `capture-pane`. Read back from its own ring buffer (`f.rings[name]`, fed by `readOutput` at
  `main.go:186`) using the same strong-signal predicate. The ring buffer is the Go host's equivalent
  of `capture-pane`; the verification logic is shared in intent, separate in mechanism.
- **Latency:** the read-back is additive to the existing family floor (15s devin / 3s claude). Bound
  it with a short ceiling (e.g. 2s) and make it configurable; a timeout expires as
  `deliveryVerified: false` with `success: false`, NOT a silent success.

### 3. Fail closed on a stale handle — BOTH hosts

- **Logic:** before writing, confirm the handle's pane still exists and its pid is unchanged since
  the handle was created. A mismatch is a hard failure, not a write into the void.
- **Standalone:** the pty fleet handle carries a pid; compare against the live `list-panes` pid.
- **Extension (`prompt.go`):** the Go host's `get(name)` + `t.status` check is the existing guard,
  but a write to a master fd whose slave process exited still succeeds at the kernel level. Add a
  pid-liveness check (e.g. `os.FindProcess` + signal-0 probe, or track the exit callback that sets
  `t.status = "exited"`) before the write, and fail closed on a mismatch.

### 4. A capture script to close the mechanism question

- **Logic:** mirror `scripts/capture-cli-modes.js` — send matched payloads that differ only in
  embedded newlines and quoting to `agy` and `devin` seats, with and without a clear in flight, and
  record which arrive. Write the answer into `ptyPromptDelivery.ts`'s comment and close the theory.
- This is diagnostic only and touches no production path.

### 5. Propagate honesty to the browser dispatch broadcast (Clarification)

- `deliverPrompt` at `bootstrap.ts:698` broadcasts `terminalDispatchFinished` with `success: !sendErr`
  to the browser. A vanished send that does not throw clears the UI dispatch light on a lost prompt.
  Thread the honest `deliveryVerified` / `success` from the receipt into this broadcast so the UI
  does not report a successful dispatch for a prompt that never arrived. (Clarification of the
  existing Change 2 scope, not net-new product scope — the broadcast already claims to report
  dispatch outcome.)

## Verification Plan

### Automated Tests

- Extend `src/test/pty-prompt-delivery-framing.test.js`: a payload containing `\n\n` and escaped
  quotes must deliver identically to its flattened twin. (Verified by hand to pass already — keep it
  as a regression guard, not as the reproduction.)
- A write whose resolved handle no longer matches the live pane returns `success: false`.
- Note: no test can reproduce the 14:20 loss, because the mechanism is unidentified. The tests here
  guard the accountability properties instead, which is what would have made it diagnosable.
- A write to a handle whose pane is gone returns `success: false` — today it returns success.
- A name resolving to two panes returns an ambiguity error rather than picking one.
- A clear dispatched immediately after a prompt must not erase it, or must report the prompt as not
  delivered.
- **NEW — two-host parity:** add a contract test asserting the Go `deliverPrompt` receipt
  (`cmd/switchboard-pty-host/prompt.go`) and the TS `sendPromptToPty` receipt
  (`src/standalone/ptyPromptDelivery.ts`) carry the same success semantics: no `success: true`
  without `deliveryVerified: true`, and both name the target pid. Source-text or build-time parity
  assertion — the existing `pty-prompt-delivery-framing.test.js` is TS-only and would not catch a Go
  regression.

### Goal Invariants

- No `success: true` without `deliveryVerified: true` — on BOTH the TS (`ptyPromptDelivery.ts`) and
  Go (`prompt.go`) delivery paths.
- Every receipt names the target identity (`paneId`/`pid`) it wrote to — on both hosts.
- Delivery outcome is independent of payload length, newlines and quoting.
- `terminalDispatchFinished` broadcast (`bootstrap.ts:698`) never carries `success: true` for a
  prompt whose receipt is `deliveryVerified: false`.

### Manual

1. Send a multi-line prompt with escaped quotes to a live `agy` seat; it arrives.
2. Kill a seat's pane, send to its stale handle; the receipt is a failure.
3. Reproduce the 14:20 payload verbatim from the lead's scrollback; it must arrive or fail, never
   report success and vanish.
4. Repeat 1–3 on the EXTENSION host (VS Code fleet), not only standalone — the Go pty host must
   behave identically.

## Outstanding Questions

- **[research]** Is there an existing seat-side acknowledgement (`promptSeq` echoed back on the seat's
  next report) that verification could use instead of scraping the pane? — proceeding on the
  assumption that no such seat-side ack exists today, so the read-back is the only available signal.
- **[user]** Can the host know a seat is mid-tool-call before writing? If readiness can detect it,
  delivery should queue until the seat is reading rather than write into a TUI that will drop it — a
  better fix than reporting the failure after the fact. — proceeding on the assumption that
  mid-tool-call detection is out of scope for this plan and the honest-failure is the deliverable.

## Resolved Assumptions

- **Do the other delivery paths — `dispatchCards`, the queue relay, `handlePtyVerb` at
  `bootstrap.ts:3231` — share this receipt, and therefore this false success?** YES, resolved from
  code. `handlePtyVerb('ptySendPrompt', ...)` at `bootstrap.ts:3231` routes into the `ptySendPrompt`
  case at `bootstrap.ts:2454`, which calls `deliverPrompt` and returns its receipt-shaped envelope at
  `bootstrap.ts:2838`. The queue/turn-end relay (`bootstrap.ts:3907`, `:4469`, `:4490`, `:4529`,
  `:4559`, `:4575`) and phone-a-friend (`:4469`) call `deliverPrompt` directly, which returns the
  `PromptDeliveryReceipt` from `sendPromptToPty` (`bootstrap.ts:719`). Every standalone delivery path
  therefore shares the false-success. The extension host's paths all funnel through
  `_ptyHostVerb('ptySendPrompt', ...)` (e.g. `TaskViewerProvider.ts:22392`, `:2598`, `:11905`) into the
  Go `deliverPrompt`. So the fix at the two delivery chokepoints covers all paths on both hosts.
