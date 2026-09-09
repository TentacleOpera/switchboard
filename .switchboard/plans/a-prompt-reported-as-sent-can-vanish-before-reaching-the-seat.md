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

**Complexity:** 4
**Tags:** pty, prompt-delivery, reliability
**Dependencies:** none

## User Review Required

Change 2 makes some sends that currently report success report failure instead. Confirm a lead
retrying on failure is preferred to it waiting on a callback that never arrives.

## Proposed Changes

### 1. The receipt names its target (`src/standalone/bootstrap.ts:2838`, `src/standalone/tmuxBackend.ts`)

- **Logic:** carry the resolved target in the receipt — `paneId`, `panePid`, and the handle id
  actually written to. "It disappeared" then becomes a one-line diagnosis rather than an
  investigation.
- **Implementation:** resolve seats to a stable `pane_id`, never a derived friendly name, and fail
  loudly when a name matches more than one pane instead of taking the first.

### 2. Verify arrival before reporting success (`src/standalone/ptyPromptDelivery.ts`)

- **Logic:** after the confirm CR, read the pane back and assert the payload's own signature is
  present (echoed, or the input cleared and a turn started). Return `success: true` only then; add
  `deliveryVerified: boolean` and `submitted: boolean` to the receipt so a partial outcome is
  reportable.
- **Implementation:** a bounded wait against `capture-pane`, reusing the settle machinery already in
  this file. Keep `bytesWritten`, but it stops being the success signal.

### 3. Fail closed on a stale handle

- **Logic:** before writing, confirm the handle's pane still exists and its pid is unchanged since the
  handle was created. A mismatch is a hard failure, not a write into the void.

### 4. A capture script to close the mechanism question

- **Logic:** mirror `scripts/capture-cli-modes.js` — send matched payloads that differ only in
  embedded newlines and quoting to `agy` and `devin` seats, with and without a clear in flight, and
  record which arrive. Write the answer into `ptyPromptDelivery.ts`'s comment and close the theory.

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

### Goal Invariants

- No `success: true` without `deliveryVerified: true`.
- Every receipt names the `paneId` it wrote to.
- Delivery outcome is independent of payload length, newlines and quoting.

### Manual

1. Send a multi-line prompt with escaped quotes to a live `agy` seat; it arrives.
2. Kill a seat's pane, send to its stale handle; the receipt is a failure.
3. Reproduce the 14:20 payload verbatim from the lead's scrollback; it must arrive or fail, never
   report success and vanish.

## Outstanding Questions

- Is there an existing seat-side acknowledgement (`promptSeq` echoed back on the seat's next report)
  that verification could use instead of scraping the pane?
- Can the host know a seat is mid-tool-call before writing? If readiness can detect it, delivery should
  queue until the seat is reading rather than write into a TUI that will drop it — a better fix than
  reporting the failure after the fact.
- Do the other delivery paths — `dispatchCards`, the queue relay, `handlePtyVerb` at
  `bootstrap.ts:3231` — share this receipt, and therefore this false success?
