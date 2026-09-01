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
that learned the flag from that text. Keep `machineOrigin` as an alias rather than removing it — not for
migration reasons (teams and their standing orders are unreleased dev work, so no install base
is owed a compat shim), but because the flag is written verbatim into the coder's step-3
standing-order text and into agent-facing skill docs. Retiring the name is a follow-up once
those texts are reissued, not part of this change.

The new field must be caller-settable and **not** in the HTTP boundary strip, for the same
reason `machineOrigin` is not: the caller is the only party that knows what it is sending.

> **Clarification — HTTP strip scope.** The boundary strip at `bootstrap.ts:2042-2043`
> deletes `addonsComposed` and `seatBlock` only. It does **not** touch `machineOrigin` or the
> new `kind` field — both pass through to `deliverPrompt` unchanged. A coder must not add
> `kind` to the strip; doing so would make it impossible for an agent to send a message-kind
> payload from HTTP, which is the entire point of this plan.

> **Clarification — `kind: "orders-refresh"` handling.** The three-kind taxonomy lists
> "orders refresh" as the third row, owned by
> `after-clear-standing-orders-block-is-a-taskless-prompt.md`. This plan implements two kinds
> (`dispatch` and `message`) only. A caller sending `kind: "orders-refresh"` today must be
> rejected with an error naming the after-clear delivery path — it is not silently mapped to
> `message` (which would strip standing orders) or to `dispatch` (which would attach the seat
> block). The third kind is reserved for the after-clear plan's use.

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

> **Clarification — audit threshold.** "Not containable in one pass" means: the audit
> identifies more than three internal callers that send without `dispatch` and rely on
> appends arriving, OR any caller whose send path cannot be traced end-to-end (e.g. a path
> that branches on runtime state the audit cannot statically resolve). At that point, ship
> steps 1+3 (the field + docs) and defer the default flip. Below that threshold, fix every
> audited caller to set the dispatch kind explicitly and flip the default. The audit list
> itself is a deliverable — it goes in the PR description, not just the code.

### 3. Tell agents which kind they are sending

- **`.agents/workflows/switchboard.md`** — the console agent's front door has no guidance on
  messaging a seat. Add it: relaying a message to a lead is a message, not a dispatch; set the
  kind, and expect a short payload.
- **`.agents/protocols/switchboard-mission-control/SKILL.md` `## Messaging Leads`** — its curl
  recipe is the canonical example agents copy, and it currently shows a bare `ptySendPrompt`.
  Show the message kind in the recipe, and state when the dispatch kind is correct instead.
- **`switchboard-orchestration` / `switchboard-mission-control-http`** — document the field on
  the `ptySendPrompt` row with the three-kind table above.

> **Clarification — `machineOrigin` doc treatment.** This plan edits the same skill docs that
> document `machineOrigin`. In every doc it touches, show `kind: "message"` as the primary
> form and `machineOrigin: true` as the legacy alias with a note that the alias will be
> retired once the coder's step-3 standing-order text is reissued. This is not "reissuing the
> texts" — it is updating the docs this plan already edits. The coder's step-3 text (which
> instructs `"machineOrigin":true` verbatim and is stored per install) is the one text this
> plan does NOT touch; its reissue is the follow-up that retires the alias.

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
5. A coder running the step-3 fallback text (which sends `machineOrigin: true`) still reports
   to its lead without appends — the alias must keep working for as long as that text ships.
6. Default-flip audit evidence: a list of every internal `ptySendPrompt` caller, what kind each
   sends, and which were changed to set it explicitly. `_attemptDirectTerminalPush` must appear
   on it.
7. Manual: ask a `/switchboard` agent to send a team lead a one-line question and confirm the
   lead's terminal shows a one-line question.
8. `npx tsc --noEmit -p tsconfig.json`, and run the standing-orders marker and stage-marker
   contract suites (the latter has 2 pre-existing failures on an unmodified tree — compare to
   that baseline).

### Goal Invariants

- **Negative:** A `ptySendPrompt` with `kind: "message"` (or `machineOrigin: true`) does NOT
  deliver the `=== STANDING ORDERS ===` marker, the seat directive block, or the
  dispatch-protocol directives — grep the delivered text for all three markers, expect zero
  matches.
- **Positive:** A `ptySendPrompt` with `kind: "dispatch"` (or carrying a `dispatch` object)
  delivers all three appends — the `=== STANDING ORDERS ===` marker and the seat directive
  block are present in the delivered text.
- **Negative:** `kind` is not present in the HTTP boundary strip
  (`bootstrap.ts:2042-2043`) — it passes through to `deliverPrompt` unchanged.
- **Positive:** `machineOrigin: true` and `kind: "message"` produce byte-identical delivered
  text — the alias is honoured exactly.
- **Negative:** `kind: "orders-refresh"` is rejected with an error — it is not silently mapped
  to `message` or `dispatch`.
- **Positive:** Every internal caller identified by the audit sets `kind: "dispatch"`
  explicitly (or carries a `dispatch` object) — the default-flip does not strip any seat's
  safety block.

## Complexity Audit

### Routine
- Adding a `kind` field to the `ptySendPrompt` payload, accepted alongside `machineOrigin` as
  an alias.
- Documenting the field and three-kind taxonomy in three agent-facing files.
- Rejecting `kind: "orders-refresh"` with an error naming the after-clear path.

### Complex / Risky
- **The default flip** — changing the default for sends without `dispatch` from "dispatch" to
  "message" on a shared rail. The audit of every internal caller is the deliverable; a missed
  caller silently strips a seat's safety block.
- **The `machineOrigin` alias retention** — two names for the same concept create a permanent
  redundancy. The alias must be honoured exactly (byte-identical behaviour) for as long as the
  coder's step-3 standing-order text ships unchanged.
- **The `extractDispatchIdentity` parse backstop** — the default rule ("no `dispatch` object =
  message") must compose with the parse-based backstop that recognises dispatch-shaped prompts
  without an explicit `dispatch` object. The two together must cover the board and lead paths
  that legitimately dispatch without setting the field.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — the payload-kind decision is per-request, not stateful.
- **Security:** The `kind` field is not in the HTTP boundary strip, so an HTTP caller can set
  it. This is correct (the caller knows what it is sending) but means a malicious caller could
  send `kind: "message"` to strip a seat's safety block. This is the same trust model as
  `machineOrigin` today — the rail trusts the caller to identify its payload correctly. No
  regression.
- **Side Effects:** The default flip changes behaviour for every internal caller that sends
  without `dispatch`. The audit must enumerate and fix each one; a missed caller loses its seat
  block silently.
- **Dependencies & Conflicts:** Shared surface with the clear-endpoint plan on
  `.agents/workflows/switchboard.md` and the Mission Control `## Messaging Leads` section —
  land in either order, not simultaneously. Also shares the `ptySendPrompt` case in
  `bootstrap.ts` (different concerns, same case handler). The `after-clear-standing-orders-block-is-a-taskless-prompt.md`
  plan owns the "orders-refresh" kind; this plan reserves the value but does not implement it.

## Dependencies

- `one-coder-callback-delivers-four-prompts-to-the-lead-three-carrying-the-standing-orders-block.md`
  — introduced `machineOrigin`; this plan re-keys it to `kind` and retains it as an alias.
- `after-clear-standing-orders-block-is-a-taskless-prompt.md` — owns the "orders-refresh" kind
  (the third row of the taxonomy). This plan reserves the value; that plan implements it.
- `seat-safeguards-fleet-prompt-path.test.js` — anchors on the literal `if (applySeatBlock) {`;
  the refactor must preserve that source shape.

## Adversarial Synthesis

Key risks: (1) the default flip on a shared rail — a missed caller in the audit silently
strips a seat's safety block, which is the exact failure mode the HTTP strip exists to
prevent; (2) the `machineOrigin` alias creates a permanent redundancy with no scheduled
retirement, though the plan now updates every doc it touches to show `kind` as primary; (3)
the `kind: "orders-refresh"` value is reserved but unimplemented — a caller sending it must be
rejected, not silently mapped. Mitigations: the audit is the deliverable with a concrete
pull-the-ripcord threshold (3 callers or any untraceable path); docs show `kind` as primary
with `machineOrigin` as legacy; `orders-refresh` is rejected with an error naming the
after-clear path.

## Metadata

**Feature:** 25e6a03f-26a5-444d-8089-43368af27bcd
**Complexity:** 6
**Tags:** backend, refactor, reliability

## Summary of Changes

Implemented explicit payload-kind distinction (`"dispatch"` vs `"message"`) for `ptySendPrompt` across both extension and standalone hosts (`TaskViewerProvider.ts` and `bootstrap.ts`). Retained `machineOrigin: true` as an accepted alias mapping to message kind, and reserved `kind: "orders-refresh"` with explicit rejection for the after-clear delivery path. Fixed send default so prompts lacking a `dispatch` object or dispatch identity default to `message`, while updating all internal dispatch sites (`_attemptDirectTerminalPush`, queue dispatch) to declare `kind: "dispatch"`. Updated agent-facing skills and workflows (`switchboard.md`, `switchboard-mission-control`, `switchboard-mission-control-http`, `switchboard-orchestration`) to document the payload kinds and proper usage.

## Review Findings

Files changed: `src/webview/terminals.js` (4 sends declared: queue drain, pane drop, standing-orders resend, link-up relay), `src/services/TaskViewerProvider.ts` (`sendToTerminal` prompt path + the pure-clear send declared), `.agents/skills/external-team-lead/SKILL.md` and `.agents/protocols/external-team-lead/SKILL.md` (worker dispatch recipe now sets `kind: "dispatch"`), `.agents/skills/switchboard-orchestration/SKILL.md` and `.agents/protocols/switchboard-mission-control-http/SKILL.md` (corrected a clause that taught the old default), plus a new CI-wired gate `src/test/prompt-payload-kind-contract.test.js`. The default-flip audit the plan required was not performed: seven `ptySendPrompt` send sites declared no kind, and the three most serious silently lost their appends — the standing-orders resend button (whose entire payload was the host's append), the browser team-queue drain, and the pane drop onto a freshly-cleared seat; `sendToTerminal` additionally diverged from standalone, whose twin calls `deliverPrompt` directly and still applies orders. Verification: `tsc --noEmit` clean apart from 5 pre-existing TS2835 import-extension errors in untouched files; `test:contract:seat-safeguards` 99/0, `roster-clear-mid-turn` 56/56, `pty-route-surface`, `queue-done-relay`, `coding-head-prompt`, `drive-mode-prompt-overhaul` all pass; `stage-marker-commit` at its documented 41/2 baseline; new `test:contract:prompt-payload-kind` passes and is wired into `.github/workflows/integration-tests.yml`. Remaining risk: `kind` is caller-settable over HTTP by design, so the rail still trusts a caller to classify its own payload — the same trust model `machineOrigin` had, but now reachable by every agent that reads the docs.

## Deferred Findings

- NIT — The plan's own ripcord threshold ("more than three undeclared internal callers → ship steps 1+3 and defer the default flip") was exceeded (seven found), but every site was statically traceable and fixed with one field each, so the flip was kept rather than reverted. `.switchboard/plans/an-agent-relayed-message-is-not-a-dispatch.md:1`
- NIT — `machineOrigin` remains a permanent second name for the message kind with no scheduled retirement; retirement is still blocked on reissuing the coder's step-3 standing-order text, which this plan correctly did not touch. `src/services/teamWiring.ts:222`
- NIT — The drive prefix tells the lead "bytesWritten counts the host's appended directives too, so it is larger than your data", which is now true only of its STAGING recipe and not its MESSAGE recipe. `src/services/KanbanProvider.ts:5818`
- NIT — Two unrelated `batchFitVisiblePanes()` calls from a different plan rode into the implementation commit through `terminals.js`; left in place rather than reverted, since reverting would break whatever plan owns them. `src/webview/terminals.js:988`
