# ptySendPrompt returns no delivery evidence, and promptCount is a latch wearing a counter's name

## Goal

Make a `ptySendPrompt` response answer "did this reach the terminal?" on its own, and stop
`ptyListTerminals` publishing a first-delivery latch under the name `promptCount`. An agent or
operator must be able to distinguish a delivered prompt from a lost one without inventing a
mechanism.

### The observed failure

An operator asked a live team lead "did it reach the terminal? I do not see it." The lead had
the API response in hand — `{"success":true,"directivesAttached":[]}` — and could not answer
from it. It fell back to `ptyListTerminals`, read `"promptCount":1` on the destination seat,
observed the value had not moved, and concluded *"First fix likely hollow ack."* It then
resent with an unrelated field changed, saw activity, and reported that field as the cause.
Both the diagnosis and the remedy were fabricated. The lead reasoned correctly from the only
two signals the API exposes; both signals are misleading.

### Root cause — three separate gaps

**1. The success response carries no evidence when `clearBeforePrompt` is false.**
`ptyHost.ts:319` returns `{ success: true, readiness: readiness || undefined, bootPhase }`.
`readiness` is produced only by the first-delivery gate or the clear branch
(`ptyPromptDelivery.ts:166-186`). On the overwhelmingly common path — an established seat,
`clearBeforePrompt: false`, which the head prompt mandates on every send — neither branch
runs, `readiness` is `undefined`, and the field is dropped. What reaches the caller through
`TaskViewerProvider._ptyHostVerb`'s `{...result, directivesAttached}` spread
(`TaskViewerProvider.ts:1257`) is a bare `success: true`. It is a true statement about a
completed write and reads as an empty one.

**2. `promptCount` is set once and never incremented.**
`ptyPromptDelivery.ts:249-254` writes `handle.promptCount = 1` **only** inside
`if (isFirstDelivery)`. It is initialised to `0` at `ptyFleetService.ts:465`. There is no
other writer anywhere in `src/` outside tests. The field is a boolean latch — "has this seat
ever been dispatched to" — and every internal consumer reads it correctly as one
(`ptyHost.ts:289`, `bootstrap.ts:439`, `TaskViewerProvider.ts:3629`, all `=== 0`). But it is
published verbatim on the `ptyListTerminals` roster (`ptyHost.ts:183`, `bootstrap.ts:1800`),
where the name promises a count. An agent polling it to confirm a second delivery will
**always** see it unchanged, and will always conclude the send was lost.

**3. The two hosts already return different fields for the same verb.**
`ptyHost.ts:319` returns `readiness` and `bootPhase`. `bootstrap.ts` (the standalone
`ptySendPrompt` case) returns `deliveryReason` and `readiness` and **no** `bootPhase`; its
boot-exit arm (`bootstrap.ts:2205-2212`) returns `deliveryReason: 'exit'` where
`ptyHost.ts:311` returns `readiness` plus `bootPhase`. Any evidence added to one host and not
the other deepens a divergence that is already live.

### Non-goal, stated explicitly

This plan does not add readiness detection to the no-clear path. `clearPty`'s docblock
(`ptyPromptDelivery.ts:259-273`) already settles that question for standalone clears, and
`sendPromptToPty` is deliberately the one path that gates on readiness — only because a
prompt follows a clear with no gap. Evidence here means **facts the write path already
knows**: when it wrote, how much it wrote, which sequence number. Not a new probe, not a
round-trip confirmation, not an echo scrape.

## Metadata

**Tags:** backend, api, reliability, bugfix, cli
**Complexity:** 6
**Project:** Browser Switchboard

## User Review Required

None. The three defects are established from the source, the fix is additive on the response
and in-memory on the handle, and the one judgement call this plan makes — that `bytesWritten`
reports the composed text actually written rather than the caller's `data` field — is settled
below in Proposed Changes and made explicit in the documented field table.

## Complexity Audit

### Routine

- Adding three additive keys to two response arms.
- Turning `handle.promptCount = 1` into `handle.promptCount += 1`.
- Extending the verb's field table in `.agents/skills/switchboard-orchestration/SKILL.md`.
- Unit coverage against a fake handle — `ptyPromptDelivery.ts` is host-free and already
  exercised this way by `src/test/pty-prompt-delivery-framing.test.js`.

### Complex / Risky

- **Changing `sendPromptToPty`'s return type is not a two-call-site edit.** The standalone
  host does not call it from its verb arm; it calls the `deliverPrompt` closure
  (`bootstrap.ts:244`), the declared "sole standalone chokepoint", which is itself typed
  `Promise<ClearReadinessResult | undefined>`, has ten call sites, and consumes the value
  internally for the dispatch-curtain broadcast. The type change propagates through it.
- **Four `?.reason === 'exit'` consumers change shape** the moment the return stops being a
  bare `ClearReadinessResult`. Each is a delivery-lost arm; a missed one silently reports a
  boot-exit as a successful send — the exact class of lie this plan exists to remove.
- **`bytesWritten` can become promptCount 2.0.** Both hosts mutate the prompt before it
  reaches the pty, so the number will not equal the caller's `data.length`. An agent that
  compares them and finds a mismatch will invent a mechanism to explain it, which is the
  originating incident repeated with a new field.
- **Cross-host key-set convergence is asserted by a source-text contract test**, not a
  runtime one — the assertion has to be written in a form that file-level regex can actually
  check, or it passes vacuously.

## Edge-Case & Dependency Audit

### Race Conditions

- **Concurrent sends to one seat.** `withTerminalLock` (`ptyPromptDelivery.ts:27-32`)
  serialises per terminal name, so `promptSeq` assigned inside the locked body is monotonic
  per seat. Increment inside the lock, never in a verb arm outside it — a verb-arm increment
  reintroduces the interleaving the lock exists to prevent.
- **`deliveredAt` vs the curtain's `elapsedMs`.** `deliverPrompt` samples `startAt` before the
  call and broadcasts `terminalDispatchFinished` in a `finally`. `deliveredAt` is captured
  inside the lock after the confirm CR, so it always falls inside that window. No ordering
  constraint between them; they are independent clocks on the same span.

### Security

- Response-only fields. Step 4 keeps them out of `verbSchemas.ts`, which validates *request*
  payloads — a schema entry would let an HTTP caller set its own `promptSeq` and hand the
  next reader a forged delivery ordinal.
- `bytesWritten` is a length, never the payload. Do not echo prompt text back on the response;
  the prompt can carry a PRD, a diff, or a plan body.

### Side Effects

- `promptCount` becoming monotonic changes an in-memory field that four readers test for `=== 0`.
  All four keep their meaning ("never delivered"), but each must be read by hand rather than
  assumed — a reader that had been relying on `<= 1` or truthiness would silently invert.
- The `ptyListTerminals` roster is rendered by `terminals.js` and read by the board. Both read
  by key; a value that now counts up changes no render path.
- No persistence: `promptCount` lives on the live handle (`ptyFleetService.ts:465`), is never
  written to `kanban.db`, and is never read from disk. This is a runtime-shape change, not
  stored state — no migration, nothing to preserve across a restart.

### Dependencies & Conflicts

- **The companion subtask** (`…head-prompt-teaches-own-seat-name-and-message-recipe.md`) owns
  every string the team lead reads at dispatch time. This plan owns the API and the verb's
  field table in the orchestration skill. The two touch disjoint files — confirmed: this plan
  touches `src/standalone/ptyPromptDelivery.ts`, `ptyFleetService.ts`, `ptyHost.ts`,
  `bootstrap.ts` and `.agents/skills/switchboard-orchestration/SKILL.md`; the companion
  touches `src/services/KanbanProvider.ts`. No shared file, no shared symbol.
- **Both composition roots.** `sendPromptToPty` is the shared delivery layer; `ptyHost.ts` is
  the extension host's child process and `bootstrap.ts` is the standalone host. A response
  field added to one and not the other is exactly the divergence gap 3 already documents.

## Dependencies

- None. No prior session is required; this plan is self-contained against HEAD.

## Adversarial Synthesis

Key risks: the return-type change fans out further than the plan's original three call sites —
through `bootstrap.ts`'s `deliverPrompt` chokepoint and four `?.reason === 'exit'` delivery-lost
arms — and a missed one turns an aborted boot into a successful-looking send. `bytesWritten`
counts the *composed* text both hosts actually write (extension: `ensureDispatchProtocolDirectives`;
standalone: seat block plus standing orders), so it will never equal a caller's `data.length` and
becomes a new misleading signal unless that is documented at the point of publication.
Mitigations: widen `deliverPrompt`'s return type in the same change and enumerate all four
exit arms as a checklist; document `bytesWritten` as bytes-on-the-wire in the same field-table
block that explains `promptSeq`; use `Buffer.byteLength` so the name is literally true; and
write the cross-host key-set assertion as a check the source-text contract test can actually
evaluate.

## Proposed Changes

### `src/standalone/ptyPromptDelivery.ts`

**Context.** `sendPromptToPty` (lines 145-256) is the single delivery path for both hosts. It
already knows the payload it framed, the moment of the final CR, and `isFirstDelivery`. It
returns `ClearReadinessResult | undefined` and discards the rest.

**Logic.** Replace the return with a receipt that carries the readiness result as a member
rather than as the whole value:

```ts
export interface PromptDeliveryReceipt {
    /** The clear/boot readiness result, when either gate ran. Undefined on the
     *  established-seat, clearBeforePrompt:false path — unchanged semantics. */
    readiness?: ClearReadinessResult;
    /** UTF-8 byte length of the text WRITTEN TO THE PTY — the composed prompt,
     *  including any host-appended directives, seat block and standing orders.
     *  Not the length of the caller's `data` field. */
    bytesWritten: number;
    /** Date.now() captured immediately after the confirm CR. */
    deliveredAt: number;
    /** This seat's delivery ordinal, post-increment. Absent on an aborted send. */
    promptSeq?: number;
}
```

**Implementation.**

1. `bytesWritten` is `Buffer.byteLength(text, 'utf8')` — not `text.length`.

   > **Superseded:** `bytesWritten` is `text.length` (the payload, not the framing).
   > **Reason:** `text.length` is UTF-16 code units, not bytes. A prompt containing an em
   > dash, a box-drawing character, or any non-ASCII content — which every prompt this
   > codebase composes does — reports fewer "bytes" than were written. A field named
   > `bytesWritten` that is not a byte count is the same defect as a field named
   > `promptCount` that does not count.
   > **Replaced with:** `bytesWritten` is `Buffer.byteLength(text, 'utf8')`. "Payload, not
   > framing" is retained: the bracketed-paste markers and the two CRs are excluded.

2. `deliveredAt` is `Date.now()` captured immediately after the second (confirm) CR write,
   inside the lock.
3. `promptSeq` is the post-increment value of `handle.promptCount` from the change below.
4. Every early-return arm returns a receipt, not a bare readiness:
   - `handle.status === 'exited'` on first delivery (line ~168) → `{ readiness: { reason: 'exit', elapsedMs: 0 }, bytesWritten: 0, deliveredAt: Date.now() }`, no `promptSeq`.
   - first-readiness `reason === 'exit'` (line ~176) → same shape, carrying that readiness.
   - clear-branch exits (lines ~181-186) → same shape, carrying that readiness.
   Nothing was written on any of these arms, so `bytesWritten: 0` and `promptCount` does not
   advance.

**Edge cases.**

- **Empty prompt.** `payload.data || ''` is legal today and writes only framing plus two CRs.
  Report `bytesWritten: 0`, still advance `promptSeq`, keep `success: true` — it is a real
  (if useless) send, and the seat did receive two carriage returns.
- **A seat that dies mid-write.** `handle.write` on a dead pty throws or no-ops by platform.
  The receipt reports what the loop attempted; `success` stays governed by the existing
  exit/error arms. A receipt field must never turn a failed send into a successful-looking one.

### `src/standalone/ptyPromptDelivery.ts` — the counter

**Context.** Lines 249-254: `if (isFirstDelivery) { handle.promptCount = 1; }`, placed after
the confirm CR and reached only when the write completed.

**Logic.** Replace with an unconditional `handle.promptCount += 1` in the same position, and
read the post-increment value into the receipt's `promptSeq`. Update the field's docblock at
`ptyFleetService.ts:103` and the roster-publication comments at `ptyHost.ts:180-183` and
`bootstrap.ts:1798-1800`, all of which currently describe a first-delivery flag.

**Edge cases.** Verify each of the four readers by hand rather than assuming — every one tests
`=== 0` today and stays correct under a counter, but the point of the check is to catch a
reader that does not:

- `ptyPromptDelivery.ts:152` — `isFirstDelivery = handle.promptCount === 0`.
- `ptyHost.ts:289` — `bootPhase = handle.promptCount === 0`, captured before the call.
- `bootstrap.ts:439` — `isBooting = handle?.promptCount === 0`, the curtain phase.
- `TaskViewerProvider.ts:3629` — `target.promptCount === 0` off the `ptyListTerminals` roster.

### `src/standalone/ptyHost.ts` and `src/standalone/bootstrap.ts` — the response arms

**Context.** `ptyHost.ts:275-321` is the extension host's arm and calls `sendPromptToPty`
directly. `bootstrap.ts:1897-2228` is the standalone arm and calls the `deliverPrompt` closure
(`bootstrap.ts:244-502`), not `sendPromptToPty`.

> **Superseded:** "Update the three call sites that consume the old return: `ptyHost.ts:290`,
> the standalone arm in `bootstrap.ts`, and any `dispatchCards` path that awaits it."
> **Reason:** The standalone arm does not consume `sendPromptToPty`'s return at all. It
> consumes `deliverPrompt`'s — the declared sole standalone chokepoint at `bootstrap.ts:244`,
> which is itself typed `Promise<ClearReadinessResult | undefined>`, calls `sendPromptToPty`
> at line 462, and reads the value internally at line ~478 for the
> `terminalDispatchFinished` broadcast's `reason` field before returning it at line 500.
> Widening `sendPromptToPty` without widening `deliverPrompt` either fails to compile or —
> if the closure's annotation is left as-is and the value is passed through — silently drops
> every new field on the entire standalone host, shipping the extension half only.
> **Replaced with:** the call-site list below, which is exhaustive as of HEAD.

**Implementation — the call sites, in order.**

1. `bootstrap.ts:244` — widen the `deliverPrompt` closure's return annotation to
   `Promise<PromptDeliveryReceipt>` and change its internal `readiness` local (line 458) to
   hold the receipt. Its `terminalDispatchFinished` broadcast at line ~478 reads
   `readiness?.reason`; that becomes `receipt.readiness?.reason` with the same
   `|| (handle.status === 'exited' ? 'exit' : 'signal')` fallback. Return the receipt at
   line 500. The eight fire-and-forget call sites (515, 2540, 2650, 2858, 3223, 3253, 3269)
   ignore the return and need no change — confirm that by inspection, do not assume it.
2. `bootstrap.ts:2189` (`ptySendPrompt` arm) — `const receipt = await deliverPrompt(...)`.
   The exit check at line 2205 becomes `receipt.readiness?.reason === 'exit'`.
3. `bootstrap.ts:2435` (`dispatchCards`) — same rename; the exit check at line 2440 and the
   conditional `deliveryReason` spread at line 2491 both read `receipt.readiness`.
4. `ptyHost.ts:291` — `const receipt = await sendPromptToPty(...)`; the exit check at line 307
   becomes `receipt.readiness?.reason === 'exit'`.

**Logic — converged response shape.** Both hosts' `ptySendPrompt` arms return the same keys:

- **Unconditional on every arm, success and boot-exit alike:** `success`, `bytesWritten`,
  `deliveredAt`, `bootPhase`. `bootPhase` is captured *before* delivery in both hosts
  (`ptyHost.ts:289` already does; `bootstrap.ts` must capture `handle.promptCount === 0` in
  its arm, independently of `deliverPrompt`'s own `isBooting`, and return it).
- **Unconditional on success, absent on boot-exit:** `promptSeq` — nothing was written, so no
  ordinal was consumed.
- **Conditional, and conditioned IDENTICALLY in both hosts:** `readiness` and `deliveryReason`,
  emitted only when a readiness gate actually ran. `ptyHost.ts` currently omits
  `deliveryReason` and `bootstrap.ts` currently omits `bootPhase`; adopt both in both. Do not
  delete `deliveryReason` — the standalone host's callers read it (`bootstrap.ts:2491`).

  The condition must be spelled the same way on both sides, because a key present with value
  `undefined` and a key absent are indistinguishable after `JSON.stringify` on the wire but
  are *not* indistinguishable to an in-process caller: `TaskViewerProvider._fleetVerb` reaches
  `bootstrap.ts`'s arm without a JSON round-trip (`TaskViewerProvider.ts:1206`). Use the same
  `...(receipt.readiness ? { … } : {})` spread in both.

- `directivesAttached` is already present on both paths — added by `bootstrap.ts` in its own
  arm and by `TaskViewerProvider.ts:1258`'s spread on the extension path. No change.

**Edge cases.**

- **Callers that ignore the new fields.** Every field is additive. `terminals.js` and the board
  read the roster by key. Confirm no consumer does an exhaustive key check or an
  `Object.keys().length` comparison on a `ptySendPrompt` response.
- **The `bytesWritten` mismatch trap.** On BOTH hosts the text handed to `sendPromptToPty` is
  larger than the caller's `data`:
  - extension — `TaskViewerProvider.ts:699` replaces `payload.data` with
    `ensureDispatchProtocolDirectives(payload.data, missionControlActive)` before forwarding;
  - standalone — `deliverPrompt` appends the seat directive block and the standing-orders
    block to produce the `out` it delivers (`bootstrap.ts:462`).

  So `bytesWritten > data.length` is the normal case, not an anomaly. This must be stated
  where the field is documented (below) or the field reproduces the originating incident: an
  agent compares the two, finds a discrepancy it cannot explain, and invents a mechanism.

### `.agents/skills/switchboard-orchestration/SKILL.md`

**Context.** Line 214 is the verb's field table. It documents the *request* shape and says
nothing about what the response proves. It is the only complete description of the verb
anywhere.

**Logic.** Add one short response block. Do not restate the delivery internals.

**Implementation.** Cover exactly these four points:

- `success: true` means the bytes were written to the pty and the submit CR was sent. It is
  not an echo, not a round trip, and not a claim that the CLI parsed anything.
- `bytesWritten` is the UTF-8 byte length of what was written to the terminal, which includes
  the host-appended directive, seat and standing-orders blocks. It is **expected** to exceed
  the length of your `data` field. A larger number is not evidence of corruption.
- `promptSeq` is that seat's delivery ordinal. Re-reading `promptCount` on `ptyListTerminals`
  and seeing it advance *past* your `promptSeq` means a **later** send landed, not that yours
  did — your own evidence is the `promptSeq` on your own response.
- `lastDataAt` is the seat's **output** heartbeat. It proves the CLI emitted something; it
  never proves the CLI received something.

**Edge cases.** The team head prompt is out of scope here — the companion subtask owns every
string the lead reads at dispatch time. This plan's job is the field table the skill publishes.

## Verification Plan

### Automated Tests

1. **Unit — receipt shape.** Drive `sendPromptToPty` against a fake handle: assert
   `bytesWritten === Buffer.byteLength(text, 'utf8')`, `deliveredAt` falls between the pre-
   and post-call clock samples, and `promptSeq === 1` on first delivery, `2` on the second.
   Include a non-ASCII prompt so a `text.length` regression fails here.
2. **Unit — the latch regression.** Send twice to one fake handle and assert
   `handle.promptCount === 2`. This test is the whole point: at HEAD it returns 1, which is
   the value that convinced a live lead its dispatch was lost.
3. **Unit — boot-exit arm.** A handle whose status is `exited` on first delivery returns
   `bytesWritten: 0`, no `promptSeq`, does not advance `promptCount`, and still surfaces
   `readiness.reason === 'exit'`.
4. **Contract — first-delivery readers survive the counter.** Assert `bootPhase` is `true` on
   the first send and `false` on the second, through both `ptyHost.ts` and `bootstrap.ts`.
   A counter that broke boot-phase detection would silently re-enable the clear on a cold seat.
5. **Contract — both hosts, same keys.** Extend `src/test/pty-route-surface-contract.test.js`.
   That suite asserts over **source text**, not runtime values (cf. its existing
   `/case 'ptySendPrompt'/.test(child) && /sendPromptToPty\(/.test(child)` assertions), so
   write the convergence check in that idiom: slice each host's `ptySendPrompt` arm out of its
   source and assert that `bytesWritten`, `deliveredAt`, `promptSeq`, `bootPhase`,
   `deliveryReason` and `readiness` each appear in **both** slices. This is the gate that
   would have caught the existing `bootPhase`/`deliveryReason` drift, and it is the one
   CLAUDE.md's two-hosts rule asks for.
6. **Contract — exit arms are exhaustive.** Assert that no `ptySendPrompt` or `dispatchCards`
   arm in either host still tests a bare `?.reason === 'exit'` on the value returned by
   `deliverPrompt` / `sendPromptToPty` — the receipt nests it under `.readiness`. A surviving
   bare test is always-false and reports an aborted boot as a successful send.

### Goal Invariants

- **Negative:** the literal `handle.promptCount = 1` is absent from
  `src/standalone/ptyPromptDelivery.ts`.
- **Positive (paired):** `handle.promptCount += 1` is present in that file, outside any
  `isFirstDelivery` conditional, and after the confirm CR write.
- **Positive:** all four `promptCount` readers (`ptyPromptDelivery.ts:152`, `ptyHost.ts:289`,
  `bootstrap.ts:439`, `TaskViewerProvider.ts:3629`) still compare against `0` and none
  compares against `1`.
- **Positive:** both hosts' `ptySendPrompt` success arms name `bytesWritten`, `deliveredAt`,
  `promptSeq` and `bootPhase`.
- **Negative:** `promptSeq` and `bytesWritten` do not appear in `src/services/verbSchemas.ts`
  — they are response fields, and a request-schema entry would let a caller set them.
- **Positive:** `.agents/skills/switchboard-orchestration/SKILL.md` states that `bytesWritten`
  exceeds the caller's `data` length by design.

### Live smoke — the original question

With a real team up, POST a plain message to a coder seat with `clearBeforePrompt: false` and
confirm the response carries `bytesWritten`, `deliveredAt` and `promptSeq`. Send a second
message and confirm `promptSeq` advances and the roster's `promptCount` advances with it. This
is the exact scenario in which the lead could not answer the operator.

## Implementation Summary

Implemented delivery evidence for `ptySendPrompt` and converted `promptCount` from a first-delivery latch into a monotonic counter. `sendPromptToPty` now returns `PromptDeliveryReceipt` with `bytesWritten` (UTF-8 byte length), `deliveredAt` (timestamp after confirm CR), `promptSeq` (seat delivery ordinal), and optional `readiness`. Both extension (`ptyHost.ts`) and standalone (`bootstrap.ts`) composition roots return converged response shapes with identical keys and nested exit checks. Updated `.agents/skills/switchboard-orchestration/SKILL.md` to document the receipt fields and added unit and contract tests in `pty-prompt-delivery-framing.test.js` and `pty-route-surface-contract.test.js`.

## Review Findings

Reviewed commit `2bd5f0c7` and fixed two defects it introduced, both in tests it shipped: `src/test/pty-prompt-delivery-framing.test.js` (adding `promptCount: 0` to the shared stub flipped `isFirstDelivery` to true, which suppresses the clear by design and left the two clear-branch tests asserting a Ctrl+U that no longer fires — the seats are now marked established) and `src/test/pty-route-surface-contract.test.js` (the cross-host convergence gate sliced bootstrap's arm to `case 'ptyRollLogSession':`, a verb that exists only in `ptyHost.ts`, so the gate could never pass — both slices now cut at the next `case`). The production change itself is correct: `bytesWritten` is `Buffer.byteLength(text,'utf8')` on the composed text, `deliveredAt` and the unconditional `handle.promptCount += 1` sit inside `withTerminalLock` after the confirm CR so `promptSeq` is monotonic per seat, every early-return arm reports `bytesWritten: 0` without consuming an ordinal, and all four readers still compare `=== 0`. Both hosts' arms now carry the same six keys with `readiness`/`deliveryReason` spread identically, and `deliverPrompt`'s widened return is consumed correctly at every call site (its only `undefined` path is the `orientationOnly` relay, which the `ptySendPrompt` arm never takes). Verified green: `pty-prompt-delivery-framing`, `pty-route-surface`, `clear-readiness`, `terminal-session-log`, `terminal-plan-attribution`, `pty-host-gating`, `dispatch-curtain` — all CI-wired.

## Deferred Findings

- NIT — `src/standalone/bootstrap.ts:2195` — `bootPhase` is sampled outside `withTerminalLock`, so two concurrent cold sends to one seat can both report `bootPhase: true`. Cosmetic (curtain label only), and `ptyHost.ts:289` has sampled it the same way since before this change.
- NIT — `src/standalone/bootstrap.ts:2234` — `bytesWritten: receipt?.bytesWritten ?? 0` would pair a `success: true` with a zero byte count if `deliverPrompt` ever returned `undefined` on this arm; unreachable today because `orientationOnly` is never passed here.
- NIT — `src/test/pty-route-surface-contract.test.js:614` — the convergence gate asserts key *presence* in source text; the plan's item 4 ("`bootPhase` true on the first send, false on the second, through both hosts") has no runtime assertion in either host.
- MAJOR (pre-existing, not this commit) — `src/generated/verbAllowlist.ts` — `parity:check` fails: `getFeatureWorktreeMode` and `setFeatureWorktreeMode` are in the checked-in allowlist but have zero references in `src/`, so `catalog:check` also reports drift. Left untouched; regenerating is a separate concern.
