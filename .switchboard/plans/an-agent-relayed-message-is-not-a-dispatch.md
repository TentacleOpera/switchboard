# An agent relaying a message to a lead sends a dispatch-sized payload, because the appends default to on

## Goal

Separate *"is this a dispatch?"* from *"who sent it?"* on the prompt rail, so an agent relaying
a short message to a team lead sends a short message. Today the `/switchboard` console agent
asking a lead a question delivers that question wrapped in the lead's full standing orders and
the seat directive bundle — appends that exist to equip a seat for work it is about to do, on a
payload that carries no work.

### The problem

Asked to send a team lead a message, the `/switchboard` agent delivers a massive prompt block —
the message, plus the full standing-orders block, plus the prompt add-on directives. These were
never meant to ride every prompt an agent sends to another agent.

### Root cause — the flag that fixes this exists, keys on the wrong axis, and defaults wrong

`deliverPrompt` (`bootstrap.ts:242`, and its `TaskViewerProvider` twin) appends three things,
**all defaulting to on**:

1. the standing-orders block (`applyOrders`, 4th parameter),
2. the seat directive block (`applySeatBlock`, 5th),
3. the dispatch-protocol directives (`dispatch`, 6th).

A `machineOrigin` flag already suppresses all three at once, and the docblock at
`bootstrap.ts:250-256` states the principle exactly right:

> *"A machine-origin delivery (a queue/done relay, a coder's fallback report) carries NONE of
> the three appends… **All three exist to equip a seat for work it is about to do; a seat being
> told that someone else finished is not about to do that work.**"*

That principle is correct and it is **not** about machine origin. It is about whether the
payload is a dispatch. The flag was introduced by
`one-coder-callback-delivers-four-prompts-to-the-lead-three-carrying-the-standing-orders-block.md`,
which scoped itself to the system's own relay sites — it sets `machineOrigin: true` at
`LocalApiServer.ts:3440` and `:5643`, and adds the flag to the coder's step-3 fallback text. It
never reached the general case, because in that plan's world the only non-dispatch senders were
the system's own relays.

An agent relaying a human's message is a third category that fits neither name:

- It is **not machine-origin** — a person wrote it.
- It is **not a dispatch** — nobody is about to start work from it.

So the flag that would fix it reads, by its name, as the wrong flag to set, and an agent has no
reason to reach for it. It sends a plain `ptySendPrompt`, and gets all three appends.

**Why the caller cannot simply opt out.** `standingOrders: false` *is* honoured from HTTP
(`bootstrap.ts:2171`, `:2512` read `payload.standingOrders !== false`), but `seatBlock` and
`addonsComposed` are **stripped at the HTTP boundary** (`bootstrap.ts:1906-1907`) because *"an
HTTP caller supplying them would opt a seat out of its own safety block."* That strip is right
for a dispatch and wrong for a message: the only field that turns off the seat block from
outside is `machineOrigin`, whose name says it is for something else.

**Why the default is wrong for this caller.** Defaulting the appends on is correct for the board
dispatching work into a seat. It is wrong for an arbitrary agent sending text to another agent
— the common case for a console agent — and nothing on that path distinguishes them.

### The nuance this needs — three payload kinds, not two

The axis is what the payload is, not who sent it:

| Kind | Standing orders | Seat block | Dispatch directives |
|---|---|---|---|
| **Dispatch** — a seat is starting work | yes | yes | yes |
| **Message** — a question, an instruction to a lead, a relayed human message, a notification | no | no | no |
| **Orders refresh** — restoring a cleared seat's orders | orders only | no | no |

The third row is the after-clear one-shot and is owned by
`after-clear-standing-orders-block-is-a-taskless-prompt.md`; it is listed so the taxonomy is
complete, not to be built here. `machineOrigin` today implements the Message row under a name
that only covers part of it.

## Implementation

### 1. Name the axis for what it is

Introduce an explicit payload-kind field on `ptySendPrompt` — a dispatch/message distinction —
with `machineOrigin` retained as an accepted alias mapping to the message kind, so every current
caller keeps working unchanged: the two relay sites, the coder's step-3 fallback standing-order
text (which instructs `"machineOrigin":true` verbatim and is stored per install), and any agent
that learned the flag from that text. Do not remove `machineOrigin` in this plan — it is live in
migrated standing-order bodies on ~4,000 installs and removing it would silently restore the
appends on the relay path.

The new field must be caller-settable and **not** in the HTTP boundary strip, for the same
reason `machineOrigin` is not: the caller is the only party that knows what it is sending.

### 2. Fix the default for agent-initiated sends

A `ptySendPrompt` that carries no `dispatch` object and no payload-kind field is, today,
treated as a dispatch and gets all three appends. That default is the actual bug: an agent
sending a message must not have to know a flag exists to avoid a dispatch-sized payload.

Decide the default from evidence already on the payload rather than from the caller's identity:
a send carrying a `dispatch` object is a dispatch; a send with none is a message. Note that the
parse-based backstop (`extractDispatchIdentity` on `payload.data`, `bootstrap.ts:1959`) already
recognises a dispatch-shaped prompt without an explicit `dispatch` object, so the two together
cover the board and lead paths that legitimately dispatch without setting the field.

**This is a behaviour change on a shared rail and it is the risky part of the plan.** Before
changing the default, enumerate every internal caller that relies on the appends arriving
without setting `dispatch` — the board's `_attemptDirectTerminalPush` sends
`name`/`data`/`clearBeforePrompt` and nothing else (`bootstrap.ts:1917-1922` records exactly
this) and would flip to "message" under a naive rule. Those callers must set the dispatch kind
explicitly as part of this change. An audit that misses one silently strips a seat's safety
block — the failure mode the HTTP strip exists to prevent — so the audit is the deliverable, not
a preliminary.

If that audit shows the risk is not containable in one pass, ship step 1 and step 3 alone and
leave the default as it is: an agent that knows the field is a large improvement over one that
does not, and the default flip can follow behind its own verification.

### 3. Tell agents which kind they are sending

- **`.agents/workflows/switchboard.md`** — the console agent's front door has no guidance on
  messaging a seat. Add it: relaying a message to a lead is a message, not a dispatch; set the
  kind, and expect a short payload.
- **`.agents/protocols/switchboard-mission-control/SKILL.md` `## Messaging Leads`** — its curl
  recipe is the canonical example agents copy, and it currently shows a bare `ptySendPrompt`.
  Show the message kind in the recipe, and state when the dispatch kind is correct instead.
- **`switchboard-orchestration` / `switchboard-mission-control-http`** — document the field on
  the `ptySendPrompt` row with the three-kind table above.

### 4. Do not weaken the seat block on real dispatches

The seat directive block carries `GIT POLICY` and the subagent policy. Suppressing it on a
message is correct; suppressing it on work is a safety regression. Every test that asserts a
dispatched seat receives its block must still pass unchanged — treat those as the gate on this
plan, not as collateral to update.

## Verification Plan

1. `POST /terminals/verb/ptySendPrompt` with a message-kind payload and confirm the delivered
   text is the message alone: no `=== STANDING ORDERS ===` marker, no seat directive block, no
   dispatch-protocol directives.
2. The same call with `machineOrigin: true` behaves identically — the alias is honoured.
3. A dispatch-kind send, and a send carrying a `dispatch` object, still receive all three
   appends. Run the existing seat-safeguard suite
   (`seat-safeguards-fleet-prompt-path.test.js`) unchanged; it anchors on the literal
   `if (applySeatBlock) {`, so the refactor must preserve that source shape.
4. Both relay sites still deliver bare relays — re-run the assertions from the
   four-prompts plan rather than writing new ones.
5. A coder running the shipped step-3 fallback text (which sends `machineOrigin: true`) still
   reports to its lead without appends, including on an install whose standing orders were
   migrated to that body.
6. Default-flip audit evidence: a list of every internal `ptySendPrompt` caller, what kind each
   sends, and which were changed to set it explicitly. `_attemptDirectTerminalPush` must appear
   on it.
7. Manual: ask a `/switchboard` agent to send a team lead a one-line question and confirm the
   lead's terminal shows a one-line question.
8. `npx tsc --noEmit -p tsconfig.json`, and run the standing-orders marker and stage-marker
   contract suites (the latter has 2 pre-existing failures on an unmodified tree — compare to
   that baseline).

## Metadata

**Complexity:** 6
**Tags:** backend, refactor, reliability
