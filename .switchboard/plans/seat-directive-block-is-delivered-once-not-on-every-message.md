# The Seat Directive Block Is Delivered Once, Not On Every Message

## Goal

A seat's directive block is appended when the seat does not already have it, and skipped when it does. A lead driving a feature receives its safeguards once and then reads its coders' reports unadorned, instead of re-reading the same block on every callback.

### The problem, observed

A lead driving a three-subtask feature receives one inbound `ptySendPrompt` per coder report — plus one per turn-end notice, plus one per user message. Every one of them arrives with the lead's own seat directive block stapled underneath: subagent policy, git policy, skip-compilation, skip-tests, caveman output, suppress-walkthrough, accuracy mode. Roughly 350 tokens, byte-identical every time, appended to messages that are **status reports, not work assignments**.

Across a single feature drive that is the same block delivered five or more times into a context that never dropped the first copy.

### Root cause — the append is unconditional, and the seat's context is not

The delivery layer appends the block on every send, with no knowledge of what the seat already holds:

- **Extension** — `TaskViewerProvider._ptyHostVerb` (`:418`). The `ptySendPrompt` intercept at `:445` gates on `applySeatBlock` (`:447`), resolves the recipient's role from the terminal row (`:487-488`), builds the block (`:492`) and appends it (`:494`).
- **Standalone** — `bootstrap.ts`, `deliverPrompt(handle, text, opts, applyOrders, applySeatBlock)`. Same three steps against `handle.role`.

Both gates answer *"is this send allowed to carry the block"*. Neither asks *"does this seat already have the block"*. So the answer is yes on every send, forever.

The second half of the cause is that a seat's context outlives the send. The `terminal-coder-dispatch` skill makes this explicit and load-bearing: a head agent **never clears itself** (§7, "Never clear yourself" — its driving context across turns is the only place the work state lives), and every dispatch it sends passes `clearBeforePrompt: false`. A coder is cleared when its lead rests it; a lead is not cleared at all. So the block a lead received on its first message is still in its context on its twentieth, and re-appending it adds nothing a re-read of the same context would not already give.

A lead's context also stays comparatively small — it dispatches, reads reports, and reviews diffs, rather than holding a coding session — so there is no context-pressure reason for it to be cleared later either.

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

`friendlyName` is reused: a terminal named `coder-1` can die and be recreated, and a name-keyed entry would suppress the block for a brand-new seat that has never seen it. `agentInstanceId` is unique per terminal creation, so a recreated seat misses the cache by construction and no creation hook is needed.

Both hosts already have the value in hand at zero cost — the extension resolves `targetRow` from the `ptyListTerminals` result it already fetched (`TaskViewerProvider.ts:455`, `:487`), and standalone has the handle itself.

**3. Fail open. Any uncertainty delivers the block.**

If the instance id cannot be resolved — an unknown name, a row without the field, a listing that failed — append the block and record nothing. The two failure modes are not symmetric: a redundant block costs tokens, a missing block silently drops that seat's git policy and subagent policy. Never suppress on a guess.

**4. Invalidate on clear.**

A clear wipes the seat's context, so the next send must carry the block again. Drop the seat's entry in both clear paths:

- `ptyClearTerminal` — drop that seat's entry.
- `ptyClearAllTerminals` — drop every entry.

Standalone handles both as named cases (`bootstrap.ts:1436`, `:1504`). The extension routes both generically through `_ptyHostVerb`, which is the same function that already special-cases `ptySendPrompt` at `:445` — so the invalidation hook is the identical seam, one `verb ===` check beside the existing one.

**5. Prune to the live set, so the map cannot grow without bound.**

The extension's send path already lists terminals (`:455`). Drop map entries whose instance id is absent from that listing. Standalone prunes against `ptyFleetService.listActive()`. No eviction policy, no TTL — the live set is the bound.

**6. Nothing else moves.** `buildSeatDirectiveBlock` and `resolveSeatPromptOptions` stay exactly as they are — both are consulted on every send as before, and the block is still built before the comparison. The standing-orders block is untouched and still appended last on every send; it is short, it is the routing contract, and it is not what this plan is about.

## Metadata

**Complexity:** 3
**Tags:** refactor, backend, reliability

## User Review Required

None. The cache key, the fail-open direction, the invalidation points and the scope-to-seat-block-only are all settled above.

## Complexity Audit

### Routine

- Adding a private `Map<string, string>` field to each host.
- One equality comparison and one `.set` in each of the two append paths.
- Two `.delete` sites per host for the clear verbs.
- A prune loop over a listing both hosts already fetch.

### Complex / Risky

- **Two hosts must move together.** A host that suppresses and a host that does not gives the same workspace different prompt text under VS Code and under `npx switchboard`. This is the exact divergence class the project PRD's host-agnosticism contract exists to prevent, and there is no test that would catch it from one host alone.
- **The name-reuse trap is the reason for the instance-id key.** A reviewer who "simplifies" the key to `friendlyName` reintroduces a silent safeguard drop on every recreated terminal, and it is invisible in testing because a fresh workspace never reuses a name.
- **Suppression must never be the failure mode.** Every error path in this change appends the block. A `try/catch` that swallows an error and falls through to "skip" would drop a seat's git policy silently.
- **The extension's clear path has no named case.** `ptyClearTerminal` reaches the pty host generically; the invalidation must be added at the `_ptyHostVerb` seam, not in a handler that does not exist there.

## Edge-Case & Dependency Audit

**Race Conditions**

- The map is read and written inside the existing per-send path, which is already serialised per terminal by the send lock `ptySendPrompt` takes. No new window.
- Two sends to *different* seats touch different keys.
- A clear racing a send resolves to one redundant block at worst — the clear drops the entry, the send re-appends. Never a suppression.

**Security**

- No new network surface, no new endpoint, no persisted state, no new credential path. The map holds prompt text already delivered to that seat.

**Side Effects**

- Prompt text delivered to seats changes: second and subsequent messages to an un-cleared seat lose a block they were previously carrying. That is the intent.
- Any test asserting that *every* delivered prompt contains a directive block will fail on the second send. Those assertions are the specification of the old behaviour and must be updated deliberately, not deleted.
- Host process reload empties the map, so one redundant block is delivered per seat afterwards. Self-correcting, and strictly the safe direction.
- The `seatBlock: false` / `addonsComposed: true` opt-outs on the payload keep working unchanged; this adds a second reason to skip, it does not replace the first.

**Dependencies & Conflicts**

- Touches `src/services/TaskViewerProvider.ts` and `src/standalone/bootstrap.ts` only.
- **`TaskViewerProvider.ts` is a heavily-contended file** — the project PRD's one-agent-stream-per-provider-file rule applies. Do not code this in parallel with any other plan that edits it.
- No overlap with the three subtasks of *A Finished Stage Is a Fact, Not an Inference*, which own `agentPromptBuilder.ts`, `kanban.html`, `teamWiring.ts` and `terminals.js`. This plan touches the delivery layer that consumes `buildSeatDirectiveBlock`, never the builder.

## Dependencies

- `sess_seat_safeguards_delivery — buildSeatDirectiveBlock, resolveSeatPromptOptions, and the two delivery-layer append sites`

## Adversarial Synthesis

Key risks: a `friendlyName` key silently dropping safeguards on recreated terminals; an error path that falls through to suppression rather than delivery; and one host landing without the other, splitting prompt text between VS Code and `npx switchboard`. Mitigations: key on `agentInstanceId` so recreation misses by construction, make every uncertain branch append, and land both hosts in one commit with a test that asserts the second send is bare. Residual: a seat whose context is truncated by its own CLI — rather than by a Switchboard clear — loses the block without the map knowing. Accepted: Switchboard cannot observe a host CLI's internal compaction, the standing-orders block still rides every send, and the alternative is repeating the block forever against a case nothing can detect.

## Proposed Changes

### `src/services/TaskViewerProvider.ts` — `_ptyHostVerb` (`:418`)

- **Context:** The single seam every pty verb routes through. Already special-cases `ptySendPrompt` at `:445`, resolves the live terminal listing at `:455`, finds `targetRow` at `:487`, builds the block at `:492` and appends it at `:494`.
- **Logic:** Add a private `Map<string, string>` field. Inside the `applySeatBlock` branch, after building `seatBlock` and before appending, read `targetRow?.agentInstanceId`; append and record when there is no id, no entry, or a differing entry; skip when the entry is identical. Add a `verb === 'ptyClearTerminal'` / `'ptyClearAllTerminals'` branch that deletes the matching entry or clears the map. Prune the map against the listing already fetched at `:455`.
- **Implementation:** The existing `try/catch` at `:496` must keep appending on failure — put the cache read inside the same block and let any throw fall through to the current append. Do not introduce a second `ptyListTerminals` call; the comment at `:442-444` forbids it explicitly.
- **Edge Cases:** `targetRow` undefined (unknown name) → append, record nothing. A hidden seat resolves through `roleRows`, which already merges `hiddenTerminals` — key it the same way. `seatBlock` empty string → nothing appended today, so nothing to record.

### `src/standalone/bootstrap.ts` — `deliverPrompt`, `ptyClearTerminal` (`:1436`), `ptyClearAllTerminals` (`:1504`)

- **Context:** `deliverPrompt(handle, text, opts, applyOrders = true, applySeatBlock = true)` builds the block from `handle.role` and appends it. Both clear verbs are named cases.
- **Logic:** Mirror the extension exactly — same map semantics, keyed on the handle's agent instance id. Delete the seat's entry in `ptyClearTerminal`, clear the map in `ptyClearAllTerminals`. Prune against `ptyFleetService.listActive()`.
- **Implementation:** The map lives in the same closure scope as `deliverPrompt` so both it and the verb cases can reach it. `deliverPrompt`'s existing `catch` swallows errors with "a degraded prompt beats a lost dispatch" — keep that posture and make the degraded outcome *append*, never skip.
- **Edge Cases:** A handle without an instance id → append, record nothing. `clearPty` on a non-active handle is already a no-op; drop the entry regardless, since a stale entry is the only outcome that suppresses.

## Verification Plan

1. Send three prompts in a row to an un-cleared lead seat with safeguards configured. The first carries the seat directive block; the second and third do not. All three carry the standing-orders block.
2. Clear that seat, then send again. The block is back.
3. Change a role addon on the lead (e.g. turn caveman output off) and send again without clearing. The new block is delivered, because its content differs.
4. Drive a feature end to end with a lead and two coders. Each coder callback reaching the lead is bare below the standing-orders block; each coder's own first dispatch after being rested carries its block.
5. Kill a terminal and recreate one with the same `friendlyName`. The first send to the new seat carries the block — the instance-id key did not suppress it.
6. `ptyClearAllTerminals`, then send to two different seats. Both carry the block.
7. Break the terminal listing (unknown recipient name) and send. The block is delivered — the failure direction is append, not skip.
8. Both hosts agree: the same sequence under the extension and under `npx switchboard` produces the same delivered text at every step.
9. Run a long session with terminals created and destroyed repeatedly; the map's size tracks the live terminal count and does not grow monotonically.
10. Payload-level opt-outs still work: `seatBlock: false` and `addonsComposed: true` suppress the block on a seat that has no cache entry.

### Automated Tests

- A delivery-layer test asserting the second identical send to the same instance id omits the block while the first includes it, and that a differing block is delivered.
- A test asserting the clear verbs drop the entry, so the next send re-appends.
- A test asserting an unresolved instance id appends the block (fail-open).
- Grep the existing suite for assertions that every delivered prompt contains a directive constant — those pin the old behaviour and must be re-scoped to the first send in the same commit.

**Recommendation: Send to Coder** (complexity 3).
