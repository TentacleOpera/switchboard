# The Seat Directive Block Is Delivered Once, Not On Every Message

## Goal

A seat's directive block is appended when the seat does not already have it, and skipped when it does. A lead driving a feature receives its safeguards once and then reads its coders' reports unadorned, instead of re-reading the same block on every callback.

### The problem, observed

A lead driving a three-subtask feature receives one inbound `ptySendPrompt` per coder report — plus one per turn-end notice, plus one per user message. Every one of them arrives with the lead's own seat directive block stapled underneath: subagent policy, git policy, skip-compilation, skip-tests, caveman output, suppress-walkthrough, accuracy mode. Roughly 350 tokens, byte-identical every time, appended to messages that are **status reports, not work assignments**.

Across a single feature drive that is the same block delivered five or more times into a context that never dropped the first copy.

### Root cause — the append is unconditional, and the seat's context is not

The delivery layer appends the block on every send, with no knowledge of what the seat already holds:

- **Extension** — `TaskViewerProvider._ptyHostVerb` (`src/services/TaskViewerProvider.ts:419`). The `ptySendPrompt` intercept at `:446` gates on `applySeatBlock` (`:448`), resolves the recipient's role from the terminal row (`:488-489`), builds the block (`:493`) and appends it (`:495`).
- **Standalone** — `src/standalone/bootstrap.ts`, `deliverPrompt(handle, text, opts, applyOrders, applySeatBlock)` (`:241-282`). Same three steps against `handle.role` (`:254`, `:258`, `:260`).

Both gates answer *"is this send allowed to carry the block"*. Neither asks *"does this seat already have the block"*. So the answer is yes on every send, forever.

The second half of the cause is that a seat's context outlives the send. The `terminal-coder-dispatch` skill makes this explicit and load-bearing: a head agent **never clears itself** (§7, "Never clear yourself" — its driving context across turns is the only place the work state lives), and every dispatch it sends passes `clearBeforePrompt: false`. A coder is cleared when its lead rests it; a lead is not cleared at all. So the block a lead received on its first message is still in its context on its twentieth, and re-appending it adds nothing a re-read of the same context would not already give.

A lead's context also stays comparatively small — it dispatches, reads reports, and reviews diffs, rather than holding a coding session — so there is no context-pressure reason for it to be cleared later either.

### Approach — and the alternatives that were rejected

The approach this plan commits to: **a content-keyed, per-seat-instance memo in the delivery layer** — remember the last block delivered to each `agentInstanceId`, skip a byte-identical repeat, invalidate on anything that wipes the seat's context, and prune to the live fleet.

Three genuinely different approaches meet the same goal and were considered:

1. **Route-based classification** — suppress the block on agent-to-agent traffic and keep it on dispatches. **Rejected on a concrete seam problem, not on taste.** The precedent exists and is already implemented for the *standing-orders* block: `LocalApiServer._handleTerminalsRelay` (`src/services/LocalApiServer.ts:1928-2040`) hardcodes `standingOrders: false` with exactly this reasoning. But the traffic this plan is about does **not** use `/terminals/relay` — `terminal-coder-dispatch` §"Primary" teaches coders to report back via `POST /terminals/verb/ptySendPrompt` (SKILL.md:30, :138, :195), the same route the browser terminals rail uses for a human's own message. There is no route seam separating "coder report" from "operator prompt to a freshly cleared seat", so a route rule would either keep the repetition or drop the block on the operator path.
2. **Re-teach the skills to relay** — move agent callbacks onto `/terminals/relay` and add a `seatBlock: false` hardcode beside the existing `standingOrders: false`. **Rejected:** it fixes only the seats that obey the new instruction, leaves every other origin repeating, and `seatBlock` is stripped from wire payloads at the HTTP boundary (`TaskViewerProvider.ts:2893-2894`), so the route would additionally need to be trusted to set a host-only field. Larger blast radius, weaker guarantee.
3. **Probe the seat's own scrollback** for the block before appending. **Rejected:** the delivery layer does not read pty output, the block may have scrolled out of any buffer we could read, and a CLI's own re-render makes a text match unreliable in both directions — including the direction that suppresses.

The memo wins because it is the only one of the four whose failure mode is *redundancy*: every uncertain branch appends. (1) and (2) fail by dropping safeguards on paths nobody enumerated; (3) fails by matching text it should not have trusted.

**Goal-versus-appearance:** the honest failure this design can have is passing its own success check — "the second send is bare" — while the real goal, *the seat is still holding its safeguards*, is false. That happens whenever something wipes the seat's context without the map hearing about it. Two such paths exist; one is inside this system and is now handled (item 4 below — `clearBeforePrompt` runs the `/clear` **inside the send**, `src/standalone/ptyPromptDelivery.ts:42`), and one is not observable at all (the agent CLI's own compaction), which is stated and accepted in the Adversarial Synthesis.

### Why this is not a weakening of the seat-safeguards contract

`terminal-coder-dispatch` §3.4 states that seat safeguards ride the delivery layer rather than being hand-copied by a head agent, so that they carry provenance and cannot be forgotten or paraphrased. **That contract is untouched here.** The block is still composed host-side from the seat's own config by `buildSeatDirectiveBlock`, still appended by the delivery layer, still never authored by a sender. The only change is that the layer stops repeating itself to a seat that is still holding the last copy.

The codebase already makes exactly this judgement in one place: machine-origin turn-end notices pass `applySeatBlock = false` (documented in `deliverPrompt`'s header comment) because a notice is not a work assignment. This plan extends that same reasoning from *"this message does not warrant the block"* to *"this seat already has the block"*.

## What changes

**1. Track the last block delivered to each seat, and skip an identical repeat.**

Each host keeps an in-process `Map<string, string>` from **agent instance id** to the last seat directive block delivered to that seat. On a send that would append a block:

- No entry, or an entry that differs from the block just built → append it and record it.
- Entry byte-identical to the block just built → append nothing.

Comparing block **content**, not a boolean "already sent" flag, is what makes this correct under config change: an operator who turns off caveman output on the lead role mid-session produces a different block on the next send, which misses the cache and is delivered. A boolean would strand the seat on stale directives until its next clear.

**2. Key on agent instance id, never on friendly name.**

`friendlyName` is reused: a terminal named `coder-1` can die and be recreated, and a name-keyed entry would suppress the block for a brand-new seat that has never seen it. `agentInstanceId` is unique per terminal creation (minted by `crypto.randomUUID()` in `ptyFleetService.create`, `src/standalone/ptyFleetService.ts:231`), so a recreated seat misses the cache by construction and no creation hook is needed.

Both hosts already have the value in hand at zero cost — the extension's `ptyListTerminals` projection carries `agentInstanceId` on both the `terminals` and `hiddenTerminals` arrays (`src/standalone/ptyHost.ts:143-158`), and it is already the listing `_ptyHostVerb` fetched at `:456` and searched at `:488`; standalone has the handle itself (`ExtendedTerminalHandle.agentInstanceId`, `ptyFleetService.ts:34`).

**3. Fail open. Any uncertainty delivers the block.**

If the instance id cannot be resolved — an unknown name, a row without the field, a listing that failed — append the block and record nothing. The two failure modes are not symmetric: a redundant block costs tokens, a missing block silently drops that seat's git policy and subagent policy. Never suppress on a guess.

**4. Invalidate on every context wipe — including the one that rides inside the send.**

> **Superseded:** "Invalidate on clear. A clear wipes the seat's context, so the next send must carry the block again. Drop the seat's entry in both clear paths: `ptyClearTerminal` — drop that seat's entry; `ptyClearAllTerminals` — drop every entry."
> **Reason:** The two clear *verbs* are not the only clear. `sendPromptToPty` issues the `/clear` itself when the send carries `clearBeforePrompt: true` (`src/standalone/ptyPromptDelivery.ts:42`, inside the same per-terminal lock as the paste). That is the **board dispatch path** — the kanban dispatch callers read `terminal.clearBeforePrompt` from config and pass it explicitly (`TaskViewerProvider.ts:2873`, `bootstrap.ts:1493-1495`). With only the verb-level invalidation, the second dispatch to a coder seat would hit the cache, suppress the block, and *then* wipe the context with its own `/clear` — leaving the coder running its task with no git policy, no subagent policy and no skip-tests directive. That is precisely the silent safeguard drop this plan forbids, produced by the plan's own mechanism.
> **Replaced with:** Invalidate at **three** points, all of them before the append decision is acted on:
>
> - `ptyClearTerminal` → drop that seat's entry.
> - `ptyClearAllTerminals` → clear the whole map.
> - **A send whose resolved `clearBeforePrompt` is `true` → treat the seat as wiped: append the block unconditionally and record it.** The `/clear` and the paste are one operation under one lock, so appending on that same send is both correct and sufficient — no separate invalidation ordering to get wrong.
>
> Both hosts have the resolved flag in hand at the decision point: the extension resolves it into the payload in `handlePtyVerb` before calling `_ptyHostVerb` (`:2869-2882`), and internal senders that reach `_ptyHostVerb` directly pass their own; standalone computes `resolvedClear` at `bootstrap.ts:1493-1495` and passes it in `opts`, which `deliverPrompt` already receives.

Standalone handles both clear verbs as named cases (`bootstrap.ts:1440`, `:1508`). The extension routes both generically through `_ptyHostVerb`, which is the same function that already special-cases `ptySendPrompt` at `:446` — so the invalidation hook is the identical seam, one `verb ===` check beside the existing one. Delete **before** forwarding the verb to the pty host: a clear that then fails leaves the entry dropped, which costs one redundant block and never a suppression.

**5. Prune to the live set, so the map cannot grow without bound.**

The extension's send path already lists terminals (`:456`). Drop map entries whose instance id is absent from that listing.

> **Clarification:** prune against `roleRows` — the concatenation of `terminals` **and** `hiddenTerminals` already built at `:475-478` — not against the `terminals` array alone and not against `live` (which is `status === 'active'`, terminals-only, and exists for standing-orders membership). Hidden seats are real prompt targets whose role already resolves through `roleRows`; pruning them on every send would evict their entry each time and re-deliver the block forever, quietly restoring the exact behaviour this plan removes. Skip the prune entirely when the listing call failed or returned no arrays — an empty listing must not be read as "no live seats".

Standalone prunes against `ptyFleetService.listActive()`, which filters on status only and therefore already includes hidden seats (`ptyFleetService.ts:381-383`). No eviction policy, no TTL — the live set is the bound. `ptyCloseTerminal` needs no hook: instance ids are never reused, so a killed seat's entry is inert until the next prune removes it.

**6. Strip the inbound standing-orders block on the suppressed path too.**

Today the strip is *inside* the `if (seatBlock)` branch in both hosts — `data = stripStandingOrdersBlock(data) + '\n\n' + seatBlock` (`TaskViewerProvider.ts:495`, `bootstrap.ts:260`) — so a send that appends no block also performs no strip. `applyStandingOrders` strips internally, but it only runs when `applySO` is true **and** at least one effective order exists (`TaskViewerProvider.ts:507-521`, `bootstrap.ts:266-278`). On a workspace with no standing orders configured, suppressing the seat block would therefore let a relayed message carry the *sender's* standing-orders block through into the recipient — a regression introduced by this change, not a pre-existing one.

Hoist the strip so it runs whenever `applySeatBlock` is true, regardless of whether the block is appended. The ordering constraint is unchanged: strip inbound SO → (maybe) append seat block → `applyStandingOrders` last.

**7. Nothing else moves.** `buildSeatDirectiveBlock` and `resolveSeatPromptOptions` stay exactly as they are — both are consulted on every send as before, and the block is still built before the comparison. The standing-orders block is untouched and still appended last on every send; it is short, it is the routing contract, and it is not what this plan is about. The legacy `vscode.Terminal` dispatch paths (`_handleKanbanBatchTrigger` at `TaskViewerProvider.ts:20567-20588`, phone-a-friend at `:5635-5654`) never carried a seat block and are out of scope — they are not pty-fleet seats and have no `agentInstanceId`.

## Metadata

**Complexity:** 5
**Tags:** refactor, backend, reliability

> **Superseded:** **Complexity:** 3
> **Reason:** 3 scored the diff size (a map, two comparisons, four deletes) rather than the work. This is cache invalidation on a safety-critical path, landing in two hosts that must not diverge, on a `_handleMessage`-adjacent seam covered by ~20 source-shape assertions in `src/test/seat-safeguards-fleet-prompt-path.test.js` that constrain where the new code may go. The audit below already lists four "Complex / Risky" entries, which contradicts a 1-4 routine score, and the clear-inside-send interaction (item 4) was invisible at the original scoring.
> **Replaced with:** **Complexity:** 5 — mixed: majority routine, with well-scoped risks in invalidation completeness and two-host parity. The dispatch recommendation is unchanged (4-6 → Coder).

## User Review Required

None. The cache key, the fail-open direction, the invalidation points and the scope-to-seat-block-only are all settled above.

## Complexity Audit

### Routine

- Adding a private `Map<string, string>` field to each host.
- One equality comparison and one `.set` in each of the two append paths.
- Two `.delete` sites per host for the clear verbs.
- A prune loop over a listing both hosts already fetch.
- Hoisting one existing `stripStandingOrdersBlock` call out of an `if`.

### Complex / Risky

- **Two hosts must move together.** A host that suppresses and a host that does not gives the same workspace different prompt text under VS Code and under `npx switchboard`. This is the exact divergence class the project PRD's host-agnosticism contract exists to prevent, and there is no test that would catch it from one host alone.
- **Invalidation completeness is the whole correctness argument.** Three wipe paths, not two — the third (`clearBeforePrompt: true` inside the send, `ptyPromptDelivery.ts:42`) is the board dispatch path and is invisible from the verb list. Any wipe path this change does not know about becomes a silent safeguard drop.
- **The name-reuse trap is the reason for the instance-id key.** A reviewer who "simplifies" the key to `friendlyName` reintroduces a silent safeguard drop on every recreated terminal, and it is invisible in testing because a fresh workspace never reuses a name.
- **Suppression must never be the failure mode.** Every error path in this change appends the block. A `try/catch` that swallows an error and falls through to "skip" would drop a seat's git policy silently.
- **The extension's clear path has no named case.** `ptyClearTerminal` reaches the pty host generically; the invalidation must be added at the `_ptyHostVerb` seam, not in a handler that does not exist there.
- **The existing test file constrains the shape of the new code.** `seat-safeguards-fleet-prompt-path.test.js` slices `_ptyHostVerb` from its declaration to `const http = require` and `deliverPrompt` from its declaration to `await sendPromptToPty`, and asserts an exact count of `_ptyHostVerb('ptyListTerminals'` invocations (must stay 1) plus `buildSeatDirectiveBlock` appearing before `applyStandingOrders(`. New code must land inside those slices and must not add a second listing call.

## Edge-Case & Dependency Audit

**Race Conditions**

> **Superseded:** "The map is read and written inside the existing per-send path, which is already serialised per terminal by the send lock `ptySendPrompt` takes. No new window."
> **Reason:** True for standalone only. `withTerminalLock` lives in `ptyPromptDelivery.ts:22-29`, in whichever process owns the pty. Standalone calls `sendPromptToPty` in-process, so its map access is inside the lock. The **extension** does its map read/write in the extension host and only then makes the HTTP hop to the pty-host child, where the lock is taken — so two concurrent sends to the same seat are *not* serialised at the cache.
> **Replaced with:** In the extension, two concurrent sends to one seat can both miss the cache and both append. That is redundancy, never suppression: the losing writer records the same block the winner did. A suppressed send racing a block-carrying send can also reach the pty first, so the bare message may land before the one that establishes the block — cosmetic on a seat whose context already holds it from an earlier send, and impossible on a seat with no entry (which cannot produce a suppressed send). No lock is needed; the invariant is that every uncertain interleaving appends.

- Two sends to *different* seats touch different keys.
- A clear verb racing a send resolves to one redundant block at worst — the clear drops the entry, the send re-appends. Never a suppression.
- A `clearBeforePrompt: true` send racing an unrelated send to the same seat: the clearing send always appends (item 4), so the seat re-establishes the block regardless of ordering.

**Security**

- No new network surface, no new endpoint, no persisted state, no new credential path. The map holds prompt text already delivered to that seat.
- The map is keyed on a host-minted id and is never reachable from the wire; `seatBlock` / `addonsComposed` stay stripped from caller payloads at the HTTP boundary (`TaskViewerProvider.ts:2893-2894`, `bootstrap.ts:1489-1490`), so no caller can steer suppression.

**Side Effects**

- Prompt text delivered to seats changes: second and subsequent messages to an un-cleared seat lose a block they were previously carrying. That is the intent.
- Any test asserting that *every* delivered prompt contains a directive block will fail on the second send. Those assertions are the specification of the old behaviour and must be updated deliberately, not deleted.
- Host process reload empties the map, so one redundant block is delivered per seat afterwards. Self-correcting, and strictly the safe direction.
- The `seatBlock: false` / `addonsComposed: true` opt-outs on the payload keep working unchanged; this adds a second reason to skip, it does not replace the first. Note that an `addonsComposed: true` dispatch delivers a block the map never records — the next uncomposed send therefore appends redundantly. Correct direction, and not worth a second recording site inside `agentPromptBuilder`.
- Hoisting the SO strip (item 6) means a suppressed send still rewrites `data`. Harmless: `stripStandingOrdersBlock` is a no-op on text with no SO block.

**Dependencies & Conflicts**

- Touches `src/services/TaskViewerProvider.ts` and `src/standalone/bootstrap.ts` only, plus `src/test/seat-safeguards-fleet-prompt-path.test.js` for the new assertions.
- **`TaskViewerProvider.ts` is a heavily-contended file** — the project PRD's one-agent-stream-per-provider-file rule applies. Do not code this in parallel with any other plan that edits it.
- No overlap with the three subtasks of *A Finished Stage Is a Fact, Not an Inference*, which own `agentPromptBuilder.ts`, `kanban.html`, `teamWiring.ts` and `terminals.js`. This plan touches the delivery layer that consumes `buildSeatDirectiveBlock`, never the builder.
- Read-only dependency on `ptyHost.ts`'s `ptyListTerminals` projection carrying `agentInstanceId` (`:143-158`) — that field must not be dropped from the projection.

## Dependencies

- `sess_seat_safeguards_delivery — buildSeatDirectiveBlock, resolveSeatPromptOptions, and the two delivery-layer append sites`

## Adversarial Synthesis

Key risks: an invalidation set that misses a context wipe — above all the `/clear` that `sendPromptToPty` performs *inside* a `clearBeforePrompt: true` send, which is the board dispatch path and would silently strip a coder's git and subagent policy; a `friendlyName` key silently dropping safeguards on recreated terminals; an error path that falls through to suppression rather than delivery; and one host landing without the other, splitting prompt text between VS Code and `npx switchboard`. Mitigations: invalidate at all three wipe points with the clearing send itself always appending, key on `agentInstanceId` so recreation misses by construction, make every uncertain branch append, and land both hosts in one commit with tests that assert the second send is bare and the post-clear send is not. Residual: a seat whose context is truncated by its own CLI — rather than by a Switchboard clear — loses the block without the map knowing. Accepted: Switchboard cannot observe a host CLI's internal compaction, the standing-orders block still rides every send, and the alternative is repeating the block forever against a case nothing can detect.

## Proposed Changes

### `src/services/TaskViewerProvider.ts` — `_ptyHostVerb` (`:419`)

- **Context:** The single seam every pty verb routes through. Already special-cases `ptySendPrompt` at `:446`, resolves the live terminal listing at `:456`, builds `roleRows` (terminals + hiddenTerminals) at `:475-478`, finds `targetRow` at `:488`, builds the block at `:493` and appends it at `:495`. `handlePtyVerb` (`:2635`) has already resolved `payload.clearBeforePrompt` to a boolean-or-undefined before this runs (`:2869-2882`).
- **Logic:**
  1. Add a private field `private _seatBlockCache = new Map<string, string>();`.
  2. Inside the `applySeatBlock` branch, after building `seatBlock` and before appending: read `targetRow?.agentInstanceId`. Append **and record** when the id is missing, when there is no entry, when the entry differs, or when `payload.clearBeforePrompt === true`. Skip only when an id resolved, the entry is byte-identical, and the send is not clearing.
  3. Hoist `stripStandingOrdersBlock(data)` so it applies whenever `applySeatBlock` is true, then concatenate `'\n\n' + seatBlock` only on the append branch.
  4. Add a `verb === 'ptyClearTerminal'` / `verb === 'ptyClearAllTerminals'` branch beside the existing `ptySendPrompt` check — delete the entry for `payload.name`'s resolved instance id, or `.clear()` the map — running **before** the verb is forwarded.
  5. Prune the map against `roleRows` using the listing already fetched at `:456`, skipping the prune when the listing failed.
- **Implementation:** The existing `try/catch` at `:497-499` must keep appending on failure — put the cache read inside the same block and let any throw fall through to the current append. Do not introduce a second `ptyListTerminals` call; the comment at `:443-445` forbids it and `seat-safeguards-fleet-prompt-path.test.js` asserts the invocation count is exactly 1. All new code must sit above `const http = require` (`:531`) so it stays inside the slice that file's assertions read.
- **Edge Cases:** `targetRow` undefined (unknown name) → append, record nothing. A hidden seat resolves through `roleRows`, which already merges `hiddenTerminals` — key and prune it the same way. `seatBlock` empty string → nothing appended today, so nothing to record (and no entry means a later non-empty block is delivered). `ptyClearTerminal` for a name that resolves to no row → nothing to delete; harmless, because a seat with no resolvable id was never recorded.

### `src/standalone/bootstrap.ts` — `deliverPrompt` (`:241`), `ptyClearTerminal` (`:1440`), `ptyClearAllTerminals` (`:1508`)

- **Context:** `deliverPrompt(handle, text, opts, applyOrders = true, applySeatBlock = true)` builds the block from `handle.role` (`:254-258`) and appends it (`:260`). It already receives the resolved clear flag in `opts.clearBeforePrompt` — the `ptySendPrompt` case computes `resolvedClear` at `:1493-1495` and passes it at `:1496-1500`. Both clear verbs are named cases.
- **Logic:** Mirror the extension exactly — same map semantics, keyed on `handle.agentInstanceId`, same three-way invalidation with `opts?.clearBeforePrompt === true` forcing an append, same hoisted SO strip. Delete the seat's entry in `ptyClearTerminal`, clear the map in `ptyClearAllTerminals`. Prune against `ptyFleetService.listActive()`.
- **Implementation:** Declare the map in the same closure scope as `deliverPrompt` (immediately above it) so both it and the verb cases can reach it — the same scope from which `deliverPrompt` already reaches `db` and `ptyFleetService`, both declared later in the closure. Keep every new statement between `const deliverPrompt = async` and `await sendPromptToPty` (`:281`), the slice the existing assertions read. `deliverPrompt`'s existing `catch` swallows errors with "a degraded prompt beats a lost dispatch" — keep that posture and make the degraded outcome *append*, never skip.
- **Edge Cases:** A handle without an instance id → append, record nothing. `clearPty` on a non-active handle is already a no-op; drop the entry regardless, since a stale entry is the only outcome that suppresses. `ptyClearAllTerminals` clears the whole map, not just the active handles it iterates — a self-exited seat that gets revived must not keep a stale entry.

## Verification Plan

1. Send three prompts in a row to an un-cleared lead seat with safeguards configured. The first carries the seat directive block; the second and third do not. All three carry the standing-orders block.
2. Clear that seat via `ptyClearTerminal`, then send again. The block is back.
3. **Send with `clearBeforePrompt: true` to a seat that already has a cache entry** (the board dispatch shape). The block is delivered on that same send, because the send wipes the context itself.
4. Change a role addon on the lead (e.g. turn caveman output off) and send again without clearing. The new block is delivered, because its content differs.
5. Drive a feature end to end with a lead and two coders. Each coder callback reaching the lead is bare below the standing-orders block; each coder's own dispatch after being rested carries its block.
6. Kill a terminal and recreate one with the same `friendlyName`. The first send to the new seat carries the block — the instance-id key did not suppress it.
7. `ptyClearAllTerminals`, then send to two different seats. Both carry the block.
8. Break the terminal listing (unknown recipient name) and send. The block is delivered — the failure direction is append, not skip.
9. Send twice to a **hidden** seat. The second send is bare — hidden seats get the same benefit, i.e. the prune did not evict them.
10. With no standing orders configured, relay a message that already carries an SO block to a seat with a cache entry. The delivered text carries no inbound SO block — the hoisted strip still ran.
11. Run a long session with terminals created and destroyed repeatedly; the map's size tracks the live terminal count and does not grow monotonically.
12. Payload-level opt-outs still work: `seatBlock: false` and `addonsComposed: true` suppress the block on a seat that has no cache entry.
13. Both hosts agree: the same sequence under the extension and under `npx switchboard` produces the same delivered text at every step.

### Automated Tests

- A delivery-layer test asserting the second identical send to the same instance id omits the block while the first includes it, and that a differing block is delivered.
- A test asserting a send with `clearBeforePrompt: true` appends the block even when the cache entry is identical.
- A test asserting the clear verbs drop the entry, so the next send re-appends.
- A test asserting an unresolved instance id appends the block (fail-open).
- A source-shape assertion, in the style of `src/test/seat-safeguards-fleet-prompt-path.test.js`, that both hosts key on `agentInstanceId` and neither mentions `friendlyName` as a cache key — the name-reuse trap is invisible at runtime in a fresh workspace.
- Re-run `seat-safeguards-fleet-prompt-path.test.js` unchanged: the `ptyListTerminals`-called-once count, the strip-before-seat-block ordering, and the `buildSeatDirectiveBlock` before `applyStandingOrders` ordering must all still hold.
- Grep the existing suite for assertions that every delivered prompt contains a directive constant — those pin the old behaviour and must be re-scoped to the first send in the same commit.

**Recommendation: Send to Coder** (complexity 5).

## Implementation Summary

Implemented content-keyed per-seat-instance memoization of seat directive blocks across both the extension host (`TaskViewerProvider._ptyHostVerb`) and the standalone host (`bootstrap.deliverPrompt`), keying on `agentInstanceId`. Added 3-point cache invalidation (`ptyClearTerminal`, `ptyClearAllTerminals`, and sends with `clearBeforePrompt: true`), live set pruning against all active terminals and hidden terminals, and hoisted inbound standing orders stripping before seat block evaluation. Updated `seat-safeguards-fleet-prompt-path.test.js` with comprehensive source-shape and contract tests for cache keying, invalidation, fail-open behavior, and pruning. Modified files: `src/services/TaskViewerProvider.ts`, `src/standalone/bootstrap.ts`, and `src/test/seat-safeguards-fleet-prompt-path.test.js`. No issues encountered during implementation.

## Review Findings

Two CRITICAL silent-suppression defects were found and fixed in `src/services/TaskViewerProvider.ts`, `src/standalone/bootstrap.ts` and `src/test/seat-safeguards-fleet-prompt-path.test.js`. (1) A **fourth wipe path** the plan's enumeration missed: the sidebar's per-terminal "clear" and broadcast "CLEAR TERMINALS" buttons post `sendToTerminal` with `input: '/clear'`, which the single-line-leading-slash content rule routes down the raw-write branch (`TaskViewerProvider.ts:14424`, `bootstrap.ts:1745`) and never through `ptyClearTerminal` — the seat's context was wiped while its entry survived, suppressing the block on the next prompt; both hosts now drop the entry on a bare `/clear` write. (2) The extension keyed on `agentInstanceId` but *invalidated by name*, while `ptyFleetService.rename()` mutates `friendlyName` in place under an unchanged instance id and a suppressed send never re-records — stranding the entry's name permanently and defeating every later `ptyClearTerminal` on that seat (standalone was unaffected, so this was also a two-host divergence); `ptyRenameTerminal` now drops the entry. Validation: `test:contract:seat-safeguards` 69/69 (CI-wired at `.github/workflows/integration-tests.yml:194`), `tsc -p tsconfig.test.json --noEmit` clean, eslint 0 errors, plus standing-orders-marker, pty-prompt-delivery-framing, terminal-rename-rekey, pty-route-surface, terminal-rest-clear, pty-host-gating, pty-dispatch-focus, terminal-input-path, verb-engine, `parity:check` and `standalone-parity:check` all green. Remaining risks (accepted): raw keystroke `/clear` typed straight into a terminal pane travels over the WebSocket to the pty child and is invisible to both caches, as is a CLI's own internal compaction; two deferred NITs — standalone prunes even on `applySeatBlock: false` notices, and an empty-but-well-formed `ptyListTerminals` listing wipes the extension map — both fail toward a redundant block, never suppression.

