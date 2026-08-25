# A message sent to a terminal has no return path, so the one function a phone most needs is one-way

## Goal

Give "message a terminal and get the answer back" a return path that survives a mobile
connection. Sending works today; collecting the reply does not exist, and the mechanism that
would seem obvious — hold a request open until the agent answers — is the one that cannot work
on a phone.

### Problem Analysis

**Sending is solved and well-guarded.** `POST /terminals/relay`
(`LocalApiServer.ts:3867`) delivers a message into a live terminal without resetting it. Its
comment records the care taken: `ptyListTerminals` validates the target against the live fleet,
`ptySendPrompt` is called with `clearBeforePrompt: false` **hardcoded** — "there is no field to
omit and no field to get wrong" — and the delivered text is wrapped with a provenance header so
the recipient knows who is talking. It is composed entirely from the `terminalVerb` seam, so it
is host-agnostic by construction and works in standalone as well as the extension.

**And it returns nothing but an ack.** The success branch is
`{ success: true, delivered: to }`. Every failure branch returns `{ success: false, error }`.
There is no reply, no correlation id, and no handle to come back for one.

**There is no HTTP path to terminal output at all.** Output reaches a client exactly one way:
the WebSocket gateway at `/ws/terminal` (`LocalApiServer.ts:748`, dispatched to
`terminalWsGateway.handleUpgrade`). There is no tail endpoint, no ring buffer exposed over
HTTP, and no "last N lines" route. A client that wants output must hold a WebSocket open and
render a stream.

**Which is exactly wrong for a phone.** A pocket device backgrounds the browser, walks between
cells, and drops the link. Three consequences, and they rule out the two obvious designs:

- **Holding a request open until the agent replies cannot work.** An agent turn is seconds to
  many minutes. A phone will not hold a socket that long, and a timeout is indistinguishable
  from "the agent said nothing".
- **Streaming the PTY is the wrong shape and the wrong cost.** An xterm stream is a rendering
  problem, a battery problem, and unreadable on a 390px screen. What the operator wants is not
  the terminal — it is the *answer*.
- **The reply may arrive while nothing is listening.** If the return path only exists while a
  client is connected, the common case — ask, pocket the phone, look again later — loses the
  answer.

**The precedent for the right shape already exists in this codebase.** Agent-initiated,
collect-later reporting is built and documented: agents write to a file inbox
(`.switchboard/teams/<teamId>/reports/`), a remote lead reads
`GET /teams/<teamId>/reports` and claims one with
`POST /teams/<teamId>/reports/claim` (`docs/REMOTE_ACCESS.md`), and agents already post
completion comments through `postManagedComment`. The answer-back loop should be that pattern
scoped to a single question, not a new transport.

### Root Cause

The relay was built for terminal-to-terminal handoff between agents that share a host and a
filesystem — a fire-and-forget delivery where the recipient's own output surface *is* the
return path, because a human is watching it in a panel. Nothing needed a reply channel because
the reply was already on screen. A remote operator with no panel breaks that assumption, and
the assumption was never written down as one.

### Non-goals

- **No synchronous request/response.** No long-poll held open for an agent turn, no
  server-side wait-for-reply. The failure mode is a timeout that lies.
- **No xterm on a phone.** Not rendering the PTY, not a mobile terminal emulator.
- **Not a chat product.** One question, one collectable answer. No threads, no history
  browsing, no multi-turn conversation state.
- **No change to `/terminals/relay`'s send semantics.** `clearBeforePrompt: false` stays
  hardcoded and the provenance header stays. This plan adds a return path beside it; it does
  not touch the guarantee that a relay never resets a working terminal.
- **No new transport.** No push service, no polling daemon, no second socket.

## Metadata

**Complexity:** 6
**Tags:** backend, api, feature, reliability, mobile
**Feature:** 1bf7a3ba-465b-4f4d-8cf6-54e8a6e675cc

## User Review Required

Yes — the central mechanism decision, and it is genuinely a decision rather than a detail.

**How does the answer get produced?**

1. **Agent-initiated (recommended).** The relayed message carries an instruction: when you have
   answered, write your reply to the inbox against this question id. The operator collects it
   later from a route that reads the inbox. Survives every disconnect, works while the phone is
   in a pocket, and reuses the file-inbox pattern that is already built, already documented, and
   already how agents report. Cost: it depends on the agent complying, so a non-compliant or
   crashed agent yields silence rather than an error.
2. **Output capture with a correlation window.** The host records terminal output between the
   relay and a quiescence signal, and exposes it as the answer. No agent cooperation needed.
   Cost: "when has the agent finished answering?" has no reliable signal, and the captured text
   is raw PTY output — ANSI escapes, spinners, tool chatter — not an answer.
3. **Both: (1) as the answer, (2) as a fallback tail.** Recommendation if the extra surface is
   acceptable: the structured reply when the agent complies, and a "show me the raw last N
   lines" peek when it does not, which is also the debugging affordance for when the loop
   misbehaves.

Recommendation: **start with (1), and add (2) only as an explicitly-labelled raw peek.** The
first is the shape the codebase already uses; the second is a diagnostic, not the product.

## Complexity Audit

### Routine

- A question id minted at relay time and threaded into the wrapped message.
- A collect route reading the inbox for that id, with a "not answered yet" state distinct from
  "no such question".
- The prompt text instructing the agent where to write its reply.

### Complex / Risky

- **Correlation is the whole problem.** A relay today has no identity. Adding one means the
  question id must survive into an agent's context, back out through whatever the agent writes,
  and be matched without depending on the agent echoing it verbatim — because it will sometimes
  paraphrase, wrap it in prose, or answer two questions in one reply.
- **"Not answered yet" versus "will never be answered".** These are different and the operator
  needs both. An agent that crashed, was cleared, or was closed will never reply, and a phone
  showing "pending" forever is worse than an error. The live-fleet check the relay already does
  at send time gives a basis for a liveness re-check at collect time.
- **Unbounded inbox growth.** Every question leaves an artifact. Without a retention rule the
  inbox becomes a slow leak in the workspace, and these files are in `.switchboard/`, which
  users have in their repos.
- **A relay into a *cleared* terminal is a lost question.** `ptyClearPolicy.ts` exists because
  clearing is a real event with real rules. A question in flight when its terminal is cleared
  must resolve to "lost", not "pending".
- **Prompt injection through the reply.** The answer is agent-authored text rendered on the
  operator's phone. It must be treated as data — escaped on render, never interpreted as a
  command, and never auto-actioned.
- **Migration is live.** The file inbox already ships and external team leads already read it.
  Adding question artifacts to `.switchboard/teams/<teamId>/reports/` risks a lead's existing
  claim loop picking up a phone question as a work report. Either the namespace is separate or
  the claim filter is explicit.

## Edge-Case & Dependency Audit

**Race conditions**
- Agent replies before the operator's collect request arrives: the answer must be durable, not
  delivered-on-connection. This is the case that rules out any connection-scoped channel.
- Two questions to the same terminal in flight: replies must not cross. The agent may answer
  them out of order or merge them.
- Reply written while the collect route reads the inbox: a partially-written file must not be
  served as a complete answer. The existing inbox uses `mv` into `claimed/` precisely to make
  claiming atomic; the same discipline applies to writing.
- The operator retries the same question after a dropped link (see the companion route plan's
  "sent, outcome unknown" state): a duplicate must not produce two questions the agent answers
  twice.

**Security**
- The reply is untrusted text rendered on the phone. Escape it; never interpret it.
- The collect route is a new authenticated read. It follows the board's existing model —
  `sb_session` cookie or `Authorization: Bearer` — and adds no new auth path.
- **The loopback guards are untouched.** No bind change, no peer-check change, no Host-guard
  change. This plan adds two routes to a server that is already reached the same way.
- A question id must not be guessable in a way that lets one workspace's question be collected
  from another. Scope it to the workspace root the way existing routes do.

**Side effects**
- New artifacts under `.switchboard/`. If they land in the teams inbox they are visible to the
  external-team-lead HTTP loop documented in `docs/REMOTE_ACCESS.md` — that overlap is either
  intentional and documented, or namespaced apart.
- Agents gain an instruction in relayed messages, which lengthens the wrapped text. The
  provenance header already sets the precedent for wrapping; this extends it.

**Migration**
- The relay's send contract is unchanged, so existing callers (terminal-to-terminal handoff,
  the orchestration skill) are unaffected. New fields must be optional: a relay without a
  question id must behave exactly as it does today, because agents and skills already call it.

## Dependencies

- **Depended on by** the mobile command route plan, for its fifth function only. That route
  ships the send half without this and gains the return half when this lands.
- **Reuses** the file-inbox pattern and the `/teams/<teamId>/reports` + `/reports/claim`
  routes' design, without necessarily reusing their namespace.
- **Independent of** the tailnet access plan.

## Adversarial Synthesis

Key risks: (1) building a synchronous or connection-scoped reply channel, which is the obvious
design and the one a phone guarantees will fail; (2) correlation that depends on an agent
echoing an id verbatim, which it will sometimes not do; (3) a "pending" state that never
resolves because the terminal died, was cleared, or the agent ignored the instruction; (4)
question artifacts leaking into the external-team-lead claim loop; (5) unbounded inbox growth
inside a user's repository; (6) rendering agent-authored text as anything but data. Mitigations:
durable agent-initiated replies collected on demand; correlation that tolerates paraphrase and
falls back to terminal+time scoping; an explicit "lost" resolution driven by a liveness re-check
against the live fleet the relay already validates; a separate namespace or an explicit claim
filter; a stated retention rule; escape-on-render with no auto-action.

## Proposed Changes

1. **Optional question id on `POST /terminals/relay`.** Absent, behaviour is byte-identical to
   today. Present, the wrapped message gains an instruction naming where the reply goes,
   alongside the existing provenance header. Send semantics — the hardcoded
   `clearBeforePrompt: false`, the live-fleet validation — are untouched.
2. **A collect route** returning one of four states for a question id: `answered` (with the
   reply), `pending`, `lost` (terminal gone, cleared, or closed — determined by re-checking the
   live fleet), or `unknown` (no such question).
3. **A durable artifact per question**, written atomically, in a namespace that the external
   team-lead claim loop does not pick up — or picked up deliberately, with the filter stated.
4. **A retention rule**, enforced rather than documented, so the artifacts cannot accumulate
   indefinitely in a user's workspace.
5. **Optional raw peek**, explicitly labelled as raw output rather than an answer, for the case
   where the agent did not comply. Decide per the User Review section whether this ships now.
6. **Escape-on-render** for every reply, wherever it is displayed.

### Migration

Additive and optional. The relay's existing contract is preserved exactly — every current
caller keeps working with no change — so nothing that shipped needs migrating. The new
artifacts are new files under `.switchboard/`; if they share the teams inbox directory, the
claim filter must be updated in the same change rather than later, or a lead's existing loop
starts claiming phone questions.

## Verification Plan

1. **Ask, pocket, return.** Send a question from a phone, close the browser entirely, wait out
   an agent turn, reopen and collect. The answer must be there. This is the acceptance test —
   any design that fails it is the wrong design.
2. **Existing relay unregressed.** Call `POST /terminals/relay` with no question id and assert
   a byte-identical response and delivery to today, including that the target terminal's
   context survives.
3. **Never clears.** Confirm `clearBeforePrompt: false` still cannot be reached around, with
   and without a question id.
4. **Two in flight.** Send two questions to one terminal, answer them out of order, and assert
   each collect returns its own answer and not the other's.
5. **Lost, not pending.** Ask a question, then close/clear the target terminal. Assert the
   state resolves to `lost` with a reason, not `pending` forever.
6. **Non-compliant agent.** Relay to a terminal running something that ignores the
   instruction. Assert the state is legible rather than an indefinite `pending`.
7. **Duplicate send.** Repeat the same question after a simulated dropped link and assert the
   agent is not asked twice and one answer is returned.
8. **Atomicity.** Poll the collect route continuously while a reply is being written and assert
   no partial answer is ever served.
9. **Reply is data.** Have an agent reply with text containing markup, ANSI escapes, and
   command-shaped content. Assert it renders inert.
10. **Inbox hygiene.** Run many questions and assert the retention rule actually bounds the
    artifacts on disk.
11. **Team-lead loop unaffected.** With question artifacts present, run the documented external
    lead loop (`GET /teams/<teamId>/reports`, `POST /reports/claim`) and assert it neither sees
    nor claims a phone question — or sees it deliberately, matching whatever the plan decided.
12. **Guards unchanged.** Re-run `loopback-hostname-contract`; confirm a non-loopback peer and
    a non-loopback Host still 403.
