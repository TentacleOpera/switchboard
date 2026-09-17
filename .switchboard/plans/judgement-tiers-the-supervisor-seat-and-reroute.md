# Judgement Tiers, the Supervisor Seat, and Reroute

## Goal

Make the controller's **judgement rows** reachable: rows 3, 5, 6 and 8 of the solutions matrix, the
ordered list of judgement backends that answers them, the supervisor seat that fixes what a
classification cannot, and the reroute verb row 5 needs. This is the expensive half of *The Agent
Panel Becomes a Standing Controller* — the half that costs model calls and agent wakes.

The controller spine — its clock, lease, report, capability declaration, ladder and the matrix as a
data store — is the *Controller Wakes on a Clock, Diagnoses, and Reports* subtask and is a hard
dependency. On a board with only that subtask shipped, every row this subtask makes reachable already
exists in the store and reports itself unavailable with the reason `no judgement backend configured`.
This subtask changes that reason to a working chain.

### Problem analysis

**Diagnosis is the job worth a model; remediation selection is not.** Four stall nudge sweeps already
run on every tick and all take the same action — re-deliver a prompt. None asks *why* the seat went
quiet, and the causes need opposite responses: a seat waiting on a human answer is healthy and a
nudge is noise; a seat out of quota cannot be fixed by any board verb; a seat hitting an undiscovered
bug has no remediation at all and the value is the written diagnosis.

**The evidence exists and the endpoint is already there.** `GET /terminals/<name>/log`
(`LocalApiServer.ts:8683`) serves a ranged tail of a seat's session log — 256 KB default, 2 MB
ceiling, `?tail`/`?offset`/`?session`, fence-normalized markdown, with `/terminals/<name>/logs`
(`:8783`) listing sessions. That is the diagnosis input for every judgement rule, and it works over
the tailnet because it is an ordinary authenticated GET, not the WS hub. Its docblock also carries a
constraint this subtask must respect: *"The log files may contain secrets (agent terminals echo
tokens, env and paths), so the auth gate is load-bearing."*

**There is no reroute verb, and the column it would have used is gone.** Moving work from an exhausted
seat to a different one does not exist today in any form. Migration **V81**
(*the-board-never-refuses-a-dispatch*, `KanbanDatabase.ts:12524-12545`) dropped `routed_to` along with
every other refusal/ownership column and replaced them with the advisory pair `owner_seat` /
`owner_since` — *display metadata, never a gate*. V81 also makes *the board never refuses a dispatch*
an explicit invariant (`LocalApiServer.ts:3628`, `:5452-5453`, `:5572`, `:5690`), so **stand-down is
enforceable only in the controller**, as a rule precondition it checks before acting. Any design that
expects the board to refuse is wrong on this codebase.

### 0. Which files "the Agent panel" means (read this before grepping)

There are two unrelated things in this repo called *Agent Control*, and the larger one is **not**
what this plan touches. A coder who greps for the name will land on the wrong file first.

| file | what it is | this plan |
| --- | --- | --- |
| `src/webview/dock.js:140-560` (markup in `dock.html`) | the **dock's Agent tab** — log, quick actions, card/column pickers, provider config | **in scope** |
| `src/webview/command.js:2625-2900` (markup in `command.html:1113-1145`) | the **mobile command surface's `agent` view** — a near-verbatim copy of the above | **in scope** |
| `src/webview/agent-control.js` (4001 lines) + `agent-control.html` | the **Agent Control panel** — Agents, Teams, Prompts, Standing Orders tabs, extracted from `kanban.html` | **out of scope; do not edit** |
| `src/webview/terminals.js:8187` `renderStatusPane` (CSS `terminals.css:1530`) | the **seat status pane** | in scope for change 12 only |

The two in-scope copies are genuinely duplicated: the same element ids
(`agent-control-log`, `agent-control-quickactions`, `agent-control-card-select`,
`agent-control-provider`, …) are queried independently in each file, and each has its own render and
fetch path. That duplication is the divergence risk change 2 names, and it is why change 12's shared
renderer is not optional polish.


Of the four files above, this subtask touches **none of the webview files**. Its surface is the
controller module, the board's config store, and one new verb.

## Metadata

- **Complexity:** 7
- **Tags:** backend, cli, api, reliability, feature

## Host Scope

**Standalone only.** `src/extension.ts` is the legacy host and is being removed; wiring this there
is throwaway work, and "the extension does not have it" is the intended state, not a divergence.
No `extension.ts` composition-root seam is touched, and none should be added.


## Dependencies

**Hard: *The Controller Wakes on a Clock, Diagnoses, and Reports*** — the sibling subtask that builds
the clock, the lease, the report, the capability declaration, the ladder and the matrix store. This
subtask adds evaluation paths to structures that one creates. It cannot land first.

**Soft: *Structured Cards Render in One Module on Three Surfaces*** — the supervisor's structured
output is rendered by that subtask's card renderer. The supervisor can post without it; the posts are
simply not yet drawn as cards.

**Not a dependency:** *The Agent Panel Becomes a Standing Controller, Not a Button Row*. The tier
list, matrix rows and escalation criteria are editable from the panel there; here they are read from
the board's config store, which is writable by any client.

## Complexity Audit

### Routine

- Sending a prompt to the supervisor seat: `POST /terminals/verb/ptySendPrompt` through the roster
  barrier (`bootstrap.ts:3585`).
- Reading a log tail as evidence — an existing authenticated GET.
- Parsing a two-line text reply and checking set membership.

### Complex / Risky

- **The tiered judgement chain**: ordering, prefix-collapse, per-tier capability declaration,
  validate-and-reject, deadlines, and escalation gating are five interacting rules.
- **The supervisor as a seat**: a tool-using agent acting unattended, with a self-exclusion rule whose
  failure is an infinite loop.
- **The reroute verb**, post-V81: needs per-seat provider, a compatible-seat resolver, and
  restart-surviving quota state — three new pieces of board state, with *the board never refuses a
  dispatch* meaning nothing backstops a mistake.
- **Redaction before evidence leaves the board**, now worse than in the spine subtask: the slice
  crosses the tailnet and then goes to a model endpoint that may be a third party.

## Edge-Case & Dependency Audit

### Race Conditions

- **Supervisor answering after its escalation timed out.** A late structured post must not reopen a
  closed escalation, or the "one open escalation per subject" bound leaks.
- **A reroute racing the dispatch-timeout sweep.** A reroute that re-stamps `owner_since` resets the
  4-hour abandonment countdown; one that does not leaves the controller reading an age belonging to a
  seat that no longer holds the work. The chosen behaviour is stated per remediation and recorded.
- **Quota stand-down vs. any other dispatcher.** V81 means an operator tap or a queue pass will push
  work back into a seat the controller just stood down. The controller re-reads stand-down state at
  the top of each wake rather than trusting its own last decision.

### Security

- **Log tails carry secrets and now leave the machine.** Redaction happens before the slice enters a
  model call, and the smallest window that answers the rule is the window sent. The controller must
  not follow redirects from the model endpoint to a different host.
- **Credentials.** Tier API keys go to `encryptedSecretsStore` (`bootstrap.ts:5371-5374`) and the
  config records only that a key is *set*, with its source. The existing surface already honours this
  (`keySet`, never the value — `_handleAgentControlConfig`); the tier list must not regress it.
- **The model endpoint is operator-supplied and unauthenticated by default.**

### Side Effects

- Waking the supervisor seat consumes an agent CLI's quota — the most expensive side effect available,
  and the one the escalation criteria exist to bound.
- A reroute changes which seat owns a card, which is visible to every other operator of that board.

### Dependencies & Conflicts

- **Reads, does not fork:** `GlobalIntegrationConfigService`'s `agentControlProviders` rows supply the
  tier endpoints, models and key-set flags. No second endpoint store.
- **Conflict:** `_runDispatchTimeoutSweep` (`PlanIngestionEngine.ts:2768`), as above.
- **Settled by research, do not re-open:** see `## Resolved Assumptions`.

## Adversarial Synthesis

Key risks: a tool-using agent woken on every uncertain triage is the most expensive thing on the
board, and the bound is the escalation criteria rather than a rate limit; the supervisor is itself a
seat, so a missing self-exclusion is an infinite loop with an agent on the end of it; and a reroute
built on state that does not survive a restart sends work straight back into the exhausted seat on
the next wake. Mitigations: one open escalation per subject, an explicit and tested supervisor
exclusion, and quota stand-down persisted in the board's `config` table rather than in controller
memory.

## Proposed Changes

### 3. The checklist is a solutions matrix, and it is data

Switchboard is a rules engine; the controller runs rules. The checklist is an ordered list of
rules — each with a condition, an evidence source, a judge, a remediation, and a **precondition** —
not a function with branches. Adding a row must not mean editing the controller.

| # | Cause | Evidence | Judge | Remediation | Precondition |
| --- | --- | --- | --- | --- | --- |
| 1 | Finished, never reported | `completed_at` NULL + seat at rest | mechanical | mark complete / advance | — |
| 2 | Idle, no blocker | silence + clean log tail | mechanical | nudge | — |
| 3 | Waiting on a human | log tail ends in a question or prompt | **model** | relay the answer if derivable, else hand to the supervisor, else escalate with the question quoted | model |
| 4 | Crashed / dead process | liveness gone, non-zero exit in tail | mechanical | `switchboard clear <seat>` — family-aware respawn | — |
| 5 | Out of quota / rate-limited | provider error text in tail | **model** | stand down, record the reset, reroute to another provider's seat | model + ≥2 providers seated |
| 6 | Looping / undiscovered bug | repeated identical output, error churn | **model** | hand to the supervisor seat; with none configured, write the diagnosis and escalate | model; supervisor to remediate |
| 7 | Board-level wedge | ≥N seats stuck, no single cause | **model** + threshold | restart the board | supervisor present |
| 8 | Unknown | nothing above matches | **model** | record evidence, escalate, act not at all | model |

**Row 8 is load-bearing.** Without an explicit `unknown` outcome the model is forced to name a
plausible class, which is the quiet wrong answer CLAUDE.md's fallback rule exists to prevent.

**Order matters and is part of the data. Diagnosis of held work runs before any new dispatch:** a
seat already holding work that has gone quiet is a worse failure than a card that has not started,
and dispatching onto a stalled fleet compounds it. Note the framing is *diagnose* first, not *kick*
first — "keep it moving" presumes a nudge is the answer, which is wrong for rows 3, 5 and 6.

A rule needing judgement is where the model is called — and only there. Mechanical rows never cost
a model call, so the controller keeps running when no model is configured at all.

**A row whose precondition is unmet is reported as unavailable with its reason, never skipped
silently.** "Reroute unavailable — one provider seated" is a different fact from "reroute was not
needed", and collapsing them is the fallback rule again.


**Scope for this subtask.** The matrix store and the mechanical rows are built by the spine subtask.
This subtask implements the evaluation path for the **judgement** rows — 3, 5, 6 and 8 — and makes
row 7 declare itself unavailable per change 10 below.

### 7. Judgement is a tiered set of declared backends, none of them the board's

The board holds no model configuration, makes no model call, and has no model reachability state.
All of it belongs to the controller. When the controller runs on the Mac, the chain is:

```
board  ←tailnet←  controller  ←localhost←  model
```

The Pi never spends CPU on judgement — which also keeps the board clear of the build-contention
problem that already makes terminals lag.

**The endpoint contract, not a hardware spec.** The controller holds a URL to an OpenAI-compatible
`/v1/chat/completions` endpoint. Whether it answers from `localhost`, a tower on the LAN, or a
tailnet host is configuration the controller never inspects.

**Judgement is an ordered list of backends, not one model.** Each entry declares
`{ enabled, reason, source }` like every other capability, and the controller walks the list until
one answers:

| tier | role | answers | typical cost |
| --- | --- | --- | --- |
| 1 | first-line classifier | triage and classification | usually free (local), **not necessarily** |
| 2 | escalation classifier | the classifications tier 1 could not make | bounded, per call |
| 3 | the supervisor seat (change 8) | *fix it* — repo access, tools, commands | unbounded |

> **Superseded:** tier 1 described as *"a small local model … ~free"* and tier 2 as *"a larger model
> over an API key"*.
> **Reason:** it defines the tiers by the deployment they were imagined in, not by their role, and a
> real configuration breaks it. An operator running a Pi board with **no local model at all**, whose
> tier 1 is cloud Gemma reached with a Google API key, has a tier 1 that is remote, paid and
> internet-dependent. Nothing structural fails, but every argument built on "tier 1 is free" inverts —
> and the plan builds the escalation gating on exactly that.
> **Replaced with:** tiers are ordered by **role and cost**, not by locality. Any tier may be local or
> remote, free or paid. "Local and free" is the common case for tier 1, never its definition, and
> **any prefix of the list remains a valid deployment** — including a single cloud tier with no local
> model and no supervisor.

**Each tier declares what it costs and where it sends evidence**, alongside `{ enabled, reason,
source }`:

| declared field | why the operator must see it |
| --- | --- |
| `locality` — `loopback` / `lan` / `tailnet` / `internet` | whether a log slice leaves the network at all |
| `operator` — `self` / third-party name | **who else sees the evidence**; `internet` + third party is the case redaction exists for |
| `costClass` — `free` / `metered` | whether the global ceiling is a backstop or the actual control |

**Where tier 1 is metered, the global ceiling stops being a backstop and becomes the cost control.**
A 5-minute wake is ~288 wakes a day; a board with a persistently stuck seat bills on every one. The
gating criteria in this change are still the primary mechanism — they are what stop *pointless*
calls — but with a metered tier 1 the declared ceiling is the thing that bounds a bad night, and the
report must name it when it is reached rather than falling quiet.

Tiers 1 and 2 answer **"what is this?"**. Tier 3 answers **"fix it."** That is why tier 2 is not
redundant with the supervisor: escalating a *classification* to a bigger model is far cheaper than
waking an agent, so it sits below the supervisor on the ladder.

**The tiers are ordered and not skippable. Absent tiers collapse.** Where tier 2 is configured,
tier 3 is reachable only through it — the supervisor is never woken by a tier-1 shrug. Where tier 2
is absent, tier 1 escalates straight to tier 3, so an operator with only a local model and a
supervisor still has a working chain. Any prefix of the list is a valid deployment, and nothing
hardcodes three tiers.

**What may be escalated is defined, not rate-limited.** A budget is a blunt instrument: it cuts off
legitimate escalations and permits wasteful ones. The gate is what the case *is*.

*Tier 1 → tier 2, permitted only when all hold:*

- tier 1 returned `unknown`, declined, or its reply failed validation;
- the row is a judgement row — rows 1, 2 and 4 diagnose mechanically and never escalate;
- **the row's remediation is available.** Never escalate a case that could not be acted on if it
  were solved — a reroute with one provider seated is not worth a model call, let alone an agent.

*Tier 2 → tier 3 (the supervisor), permitted only when all hold:*

- tier 2 also returned `unknown`, declined, or failed validation;
- the subject has been stuck across **N consecutive passes** — one quiet wake never wakes an agent;
- the cheaper rungs have already been spent on this subject, which the one-rung-per-pass ladder
  guarantees;
- **no supervisor escalation is already open for this subject.** This is the primary bound on cost,
  and it is worth more than any rate limit: a stuck seat escalates once, not once per wake, until
  the supervisor answers or its escalation times out;
- the subject is neither the supervisor seat nor a seat the operator has parked.

A global ceiling remains as a declared backstop, not as the mechanism. When it is reached the report
says so — a controller that silently stops escalating is indistinguishable from one with nothing to
escalate.

**Validate-and-reject is the guard; a grammar is an optimization.** Every model reply is parsed and
validated against the closed set of classes and verbs, and an invalid reply means **the rule did not
run**. Where a grammar is available it lowers the reject rate; it never carries the safety.

> **Superseded:** "`llama-server` has GBNF, Ollama has JSON-schema `format`, and LiteRT's documented
> surface has neither — across released configurations none can be assumed."
> **Reason:** the LiteRT half is factually wrong. LiteRT-LM ships documented constrained decoding via
> an **LLGuidance** backend (`LlGuidanceConfig` — regex, JSON Schema and Lark grammars) plus an
> `ExternalConstraintConfig` escape hatch, and it ships an OpenAI-compatible server
> (`litert-lm serve`, port 9379). Basing the argument on a capability that does exist would have made
> the whole paragraph easy to dismiss.
> **Replaced with:** the conclusion is unchanged and now rests on what is actually true per runtime,
> recorded under `## Resolved Assumptions`. In short: on **every** runtime the operator might point
> at, the grammar is reachable only through a *specific* configuration — a non-default build flag, a
> non-OpenAI request field, a renamed parameter, or an undocumented server path — and the controller
> holds only a URL. So it still cannot be assumed, and validation still carries the safety.

**The model emits one label, and JSON is not the baseline format.**

> **Superseded:** the judgement reply is a flat JSON object of `{ reason, class, remediation }`,
> validated against a JSON Schema.
> **Reason:** it asks the model for more than the design needs. The model does **not** choose the
> remediation — `Diagnosis is the job worth a model. Remediation selection, once the cause is known,
> is mostly mechanical`, and `the controller composes rules; it does not invent actions`. The
> remediation is a **column of the matrix row**, looked up once the class is known. The model also
> never emits a command line: the controller builds those from the row. So the only machine-consumed
> value in the whole judgement path is **the class**, which is one value from a closed set of eight.
> A JSON object for one enum is ceremony that buys nothing and imports every constrained-decoding
> failure mode in `## Resolved Assumptions` — coverage collapse, property reordering, the
> sub-7B structured-output floor, per-runtime parameter drift.
> **Replaced with:** the line format below.

The judgement call asks for **one line of plain text**:

```
CLASS: <one of: finished-unreported | idle | waiting-human | crashed | quota | looping | board-wedge | unknown>
```

Parsing is a regex for `CLASS:` followed by set membership. A reply with no matching `CLASS:` line, or
a class outside the set, means **the rule did not run** — no schema involved. The prefix is kept so a
model that opens with a preamble still parses; the answer itself is a handful of tokens.

> **Superseded:** a two-line reply whose first line is `REASON: <one line, free text>`, ordered before
> `CLASS:` so the model reasons before committing to a label.
> **Reason:** it was added from the NL-to-Format literature, which is about *reasoning* tasks, and then
> measured on the actual tier-1 host and found to buy nothing. Benchmark on
> `patrick-Inspiron-7400` (i7-1165G7, Ollama 0.34.1, `gemma4:12b-it-qat`, temperature 0, five
> unambiguous board scenarios): **command-only 5/5 correct at 8.3s average; reason+command 5/5 correct
> at 15.0s average.** Zero accuracy gained, 80% more wall time. The cost is structural, not
> incidental — see the decode-bound finding below: on that host every output token is ~40x more
> expensive than an input token, so a free-text line is the single most expensive thing the reply can
> contain.
> **Replaced with:** `CLASS:` alone. **The report's "why" never needed the model.** The controller
> already knows which rule fired, which evidence window it read, which rung it took and what it ran —
> that *is* the why, it is more accurate than model prose, and it costs no decode tokens. Change 5
> already requires every entry to name its rule and its source. Where an ambiguous case genuinely
> wants reasoning, the escalation path already exists and is the right place for it (below).

**A reason is requested at tier 2 and nowhere else.** Tier 1 answers the common case, which the
benchmark shows is unambiguous and needs no prose. A case that reaches tier 2 has, by construction,
already defeated tier 1 — that is the ambiguous population the reason-before-answer literature is
about, and the one place the extra tokens are worth their decode time. Tier 2 calls therefore ask for
`REASON:` then `CLASS:`; tier 1 asks for `CLASS:` alone. The benchmark's own caveat — *"scenarios were
unambiguous by construction … genuinely ambiguous board states … is where reasoning could still
pay"* — is exactly this split.

This is why the runtime survey in `## Resolved Assumptions` resolves the way it does. **None of the
per-runtime constrained-output differences are load-bearing for this plan**, because the controller
never needs a grammar to get one word out of a model. They matter only as an *optimization*: where
`response_format` happens to work, the controller may additionally request a one-property enum
schema, which lowers the reject rate. Where it does not work, is ignored, is renamed, or is
undocumented, **nothing degrades** — the regex still parses the line, and an unparseable reply is
already a designed-for outcome that escalates to the next tier. The survey is kept because it
records *why* a grammar is never depended on, not because a grammar is needed.

Three consequences worth stating, since they change what a coder builds:

1. **No JSON Schema, no GBNF, no Lark, and no `response_format` is required anywhere in the
   controller.** A build of llama.cpp without `-DLLAMA_LLGUIDANCE=ON`, an Ollama that mangles the
   OpenAI `json_schema` shape, a vLLM on either side of the v0.12.0 parameter rename, and a
   `litert-lm serve` that documents no structured-output field are **all fully supported**.
2. **The sub-7B structured-output floor stops being a tier-1 blocker.** Picking one word from a
   labelled list is a materially easier task than emitting a valid nested object, and it is the
   *classification* case both papers in `## Resolved Assumptions` agree constraining does not harm.
3. **The reply is as short as the design allows.** One label, no prose, no JSON. On a decode-bound
   host this is not a style preference — it is the dominant cost lever (see *Host measurements*
   below). Where tier 2 does ask for a reason, `REASON:` precedes `CLASS:` so the model reasons before
   committing rather than after.

The **only** place a closed, validated payload schema genuinely applies is the supervisor's
structured card output (changes 8 and 12) — and that is an agent composing a JSON argument to
`switchboard api POST`, checked by the board on arrival, not a decoder being constrained. If it is
malformed the CLI rejects it and the agent sees the error, which is an ordinary tool-use loop and
needs no grammar either.

**"No model configured" is a supported deployment, not a degraded one.** Most installs will never
stand up an inference server. Mechanical rows are the baseline, and the panel must not present a
modelless board as broken.

**A judgement rule declares the fields its condition needs, and the controller sends those.** The
existing `_callModelForAction` serialises the entire board as indented JSON into every call, which
is thousands of tokens on a real board.

**The call has a deadline.** A wake must complete inside its interval even when the model host is
powered off, and the mechanical rows that change 3 orders first must not sit behind a judgement
call that never returns. The ordering holds in wall-clock time, not just in the rule list. On the
board side, `switchboard api --timeout <ms>` already provides this.


### 8. The supervisor is a seat, and the judgement tiers call it

Rows 3 and 6 need something that can *act* rather than classify: read the repo, run a command,
answer the question a stuck agent actually asked. That is an agent, not a model call — so the
supervisor is **a seat**, dispatched like any other, typically running Claude Code.

**No new transport is required in either direction.**

- Inbound, controller → supervisor:
  `switchboard api POST /terminals/verb/ptySendPrompt {"name","data","clearBeforePrompt","kind"}`
  (`.agents/workflows/switchboard.md:76`), which routes through the roster barrier
  (`bootstrap.ts:3585`).
- Outbound, supervisor → board: the supervisor posts its answer with `switchboard api POST …`,
  exactly as seats already report (`switchboard done` / `switchboard accept`, `cli.ts:31-33`).

**The supervisor's output is never parsed from scrollback.** ANSI churn, interleaved tool output and
partial writes make terminal text the wrong channel — `normalizeLogSlice` exists precisely because
byte ranges cut fences mid-block. The supervisor posts structured output through the CLI, and the
panel reads it from the board.

Because it is a seat it inherits what seats already have: a startup command with an `ssh`/`mosh`
transport prefix, so the supervisor may run on a different machine from both the board and the
controller; standing orders; session logs; liveness.

**Three constraints, each of which is a bug if missed:**

1. **The supervisor is excluded from its own checklist.** It is a seat, so the matrix would
   otherwise diagnose it when it goes quiet — and "ask the supervisor why the supervisor is stuck"
   is a loop with a tool-using agent on the end of it. The exclusion is explicit and tested.
2. **Escalation is gated by the criteria in change 7, not by a rate limit** — chiefly the rule that
   only one supervisor escalation is open per subject at a time. A Claude Code seat woken on every
   uncertain triage is the most expensive thing on the board. Every escalation is recorded in the
   report alongside what triggered it and which tiers declined first.
3. **It is a ladder rung, not a parallel path.** A tool-using agent acting unattended has a far
   larger blast radius than a nudge, so it sits near the top of the change-4 ladder and is reached
   by escalation — never as a row's first response.

**The escalation prompt gives the supervisor permission to refuse, first.** A tool-using
agent handed a vague problem will investigate it thoroughly, which is exactly the wrong response to
a case that should not have been escalated. So the prompt is a contract:

- It states what each lower tier concluded and why it could not decide, and carries the evidence
  window. The supervisor does not redo triage.
- **It judges whether the request is warranted before doing anything else.** If the evidence does
  not support a real problem, it returns `spurious` with a one-line reason and stops — no repo
  reads, no test runs, no tool use.
- Otherwise it investigates, acts within the verbs available to it, and returns its finding.
- Either way the answer is structured and posted through the CLI.

Repeated `spurious` verdicts are a fact about the *rule that escalated*, not about the supervisor,
and are recorded per rule and surfaced in the panel. **Decided — a rule that escalates spuriously is
surfaced, never auto-narrowed.** The panel shows the per-rule spurious count and the operator
narrows the rule's escalation permission by hand (change 11). Auto-narrowing was rejected: a
controller that silently stops escalating a rule is a behaviour change nothing announced, which is
the same class of quiet failure as a hidden capability row.

The supervisor is also the operator's chat correspondent (change 2): the same seat, the same
structured-output channel, whether the prompt came from a rule or from a person.


### 9. Reroute becomes a verb

Row 5 needs work moved from an exhausted seat to a seat on another provider, and no such verb
exists. It needs: the provider recorded per seat, a resolver for "which other seat could take
this", and quota state that survives a restart — otherwise the controller reroutes straight back
into the exhausted seat on the next wake.


### 10. Restart authority — the controller is the restarter

> **Superseded:** "Restart is offered only where a co-located controller finds a supervisor. On the
> Pi appliance that is a systemd unit. On `npx` in a terminal, on Docker without a restart policy, on
> macOS and Windows, it mostly does not exist. **Recommend deferring row 7's remediation to a later
> card**, declaring it `{ enabled: false, reason: 'no supervisor detected' }` everywhere else."
> **Reason:** the premise was that the **board restarts itself** and therefore needs a platform
> supervisor to bring it back — which is why the research in `## Resolved Assumptions` §B went
> looking for systemd/launchd/Docker detection and concluded it was unreliable. That premise is
> wrong. The controller is a **separate, co-located process**; it can shut the board down and start
> it again itself. No platform supervisor is involved, and §B's finding — true as far as it goes —
> simply does not apply to this row. It was also the founding use case for the controller being a
> separate process at all: *an unexplained bug where the board needs restarting, or a memory leak*.
> Deferring it deferred the reason the design has its shape.
> **Replaced with:** row 7's remediation ships. The controller restarts the board.

**The mechanism belongs to the controller, not to this subtask's judgement chain.** Restarting the
board is process management and needs no model — see *The Controller Wakes on a Clock, Diagnoses, and
Reports*, which owns it. That placement matters for the stated use case: **a memory leak is
detectable mechanically** (an RSS threshold on the board process), so a board with no judgement
backend at all can still be configured to recycle a leaking board. Only the *model-judged* trigger —
"≥N seats stuck, no single cause, nothing else explains it" — belongs here.

**`POST /shutdown` is reachable, and the earlier limitation is void.** It is loopback-only and
refuses tailnet peers (`LocalApiServer.ts:12968-12975`). With the off-board placement cut, the
controller is always co-located and always passes that gate. The gate is not relaxed; it simply never
applied.

Three constraints carried forward unchanged, each still a bug if missed:

1. **The report entry is written before the shutdown call**, or the reason for the restart dies with
   the process that decided it.
2. **The rule reads `terminal.fleet.surviveBoard` and records what it saw.** Off (the default), a
   restart runs `disposeAll()` and kills every seat and agent CLI; on, the successor board adopts the
   live pty host and the restart costs almost nothing. Same verb, opposite blast radius — the report
   must say which one happened.
3. **The supervisor-presence probe does not gate this row.** It was introduced to answer "will
   something restart the board", and the controller now answers that itself. The probe's remaining
   job is narrower and is described in the controller subtask: *who restarts the **controller***,
   which is a fail-safe question — a dead controller means no automation, not a dead board.

## Host measurements — tier-1 judgement host, 2026-09-17

Measured on `patrick-Inspiron-7400` (100.74.181.81): i7-1165G7, 4 physical cores / 8 threads, 15 GB
RAM, Intel Iris Xe only so CPU inference, AVX-512 VNNI available. Ollama 0.34.1 bound to the tailnet
address only, `OLLAMA_KEEP_ALIVE=30m`, started after `tailscaled`. Models `gemma4:12b-it-qat`
(primary, 7.2 GB) and `qwen3:4b` (fallback, 2.5 GB).

These are observations that shaped the reply contract above. They are not requirements, and no code
reads them.

### This host is decode-bound — which inverts the Pi appendix

**Measured: prefill 228 tok/s, decode 5.6 tok/s — a 40x gap.** The sizing appendix below says
*"prefill throughput is the binding constraint"*; that is correct for the Pi 400 / Cortex-A72 it was
measured on and **inverted here**.

**Scope this number carefully: it is a fact about that laptop, not about judgement hosts.** The
Inspiron has Intel Iris Xe only, so this is pure CPU inference with no GPU offload. A host with
usable VRAM changes the decode figure substantially — a 12B QAT model at ~7.2 GB partially offloads
onto 6 GB of VRAM, and a 4B model at ~2.5 GB fits entirely and is faster again. **Which end of the
call binds is a property of the specific host, and there are at least three regimes in play** (A72:
prefill-bound; CPU-only x86: decode-bound; GPU-offloaded: decode much cheaper). Do not generalise any
of them into a design rule.

What *is* general: a one-line reply is never worse than a paragraph on any of the three. The reply
contract above is chosen because it is cheapest everywhere, not because of this one measurement.

**The dominant lever is therefore output length.** A 160-token answer costs ~28s of decode on this
host; the one-line `CLASS:` reply costs under a second. This is the measurement behind cutting the
reason line, and it is why no future change should reintroduce prose into a tier-1 reply casually.

**Correction to the note this came from, which overstated the consequence.** The report concluded
that *"trimming board fields from the prompt buys almost nothing"*. That does not follow from its own
numbers. At 228 tok/s, the whole-board dump that `_callModelForAction` currently sends — thousands of
tokens of `JSON.stringify(planSummaries, null, 2)` — is on the order of **13 seconds of prefill**,
which roughly doubles a 13.4s call. Per token input is 40x cheaper; in absolute terms the board dump
is large enough that trimming it still pays. **Both levers stay in the plan**: the rule declares the
fields its condition needs *and* the reply is one label.

### Thinking mode, and why this does not break the endpoint contract

`gemma4:12b-it-qat` defaults to thinking, and Ollama suppresses thinking tokens from the response
body. Observed: a first run spent 41s generating a full 160 tokens, returned `done_reason=length` and
an **empty** response. With native `"think": false` the same call answers correctly in 13.4s.

The note concluded the controller should therefore call Ollama's native `/api/generate`. **That
conclusion is rejected, and the premise is wrong.** Ollama's OpenAI-compatible endpoint *does* expose
this: `reasoning_effort` is accepted on `/v1/chat/completions` and maps to the internal `Think` field,
with `"high"`/`"medium"`/`"low"` enabling it and **`"none"` mapping to `think = false`**. It is real
but undocumented — ollama/ollama#14820 exists precisely because the only way to discover it is to read
`openai/openai.go`, with docs PR #14821 against it. The native `think` parameter is indeed ignored on
`/v1`; `reasoning_effort` is the spelling that works there.

This matters more than a parameter name. Dropping to `/api/generate` would make the controller
**runtime-aware**, which this plan forbids in as many words: *"Whether it answers from `localhost`, a
tower on the LAN, or a tailnet host is configuration the controller never inspects."* A controller
that special-cases Ollama acquires a per-runtime branch for every future backend, and the tier list
stops being a list of URLs.

**What the controller does:**

- Send `reasoning_effort: "none"` on every judgement call. On a backend that does not recognise it,
  an unknown field is ignored — the same posture as every other optional parameter, and the same
  reason the reply format needs no schema.
- Treat **an empty reply with `done_reason=length` as a failed validation**, not as an answer. It is
  the `unknown` path: the rule did not run, and it escalates. A thinking model that never emits a
  visible token is indistinguishable from a broken one, and both are handled by the contract already
  written above.
- Record `reasoning_effort` and the observed `done_reason` in the report entry, so "the model thought
  itself out of an answer" is a diagnosable fact rather than a silent nothing.

**Open, and cheap to close:** ollama/ollama#15288 reports this exact symptom for Gemma 4 on the
OpenAI endpoint and is closed with *use the native endpoint* as its workaround, but against Ollama
**0.20.0** — this host runs **0.34.1**. Before any code is written, re-run the failing call as
`POST /v1/chat/completions` with `reasoning_effort: "none"` on 0.34.1. If it answers, nothing in the
plan changes. If it still returns an empty body, the finding is a live Gemma-4-specific bug and the
right response is to move tier 1 to a model that honours it — **not** to give the controller a
runtime-specific code path.

### Scenario accuracy, and the contract the benchmark actually tested

Five unambiguous board scenarios (stalled seat, healthy board, seat awaiting answer, silent seat with
a free alternate, empty board), temperature 0, one run each: **5/5 correct both with and without a
reason line**, 8.3s vs 15.0s average.

**The accuracy result is adopted; the recommendation attached to it is not.** The benchmark asked the
model for a bare CLI call over a closed verb set of `clear` / `reroute` / `nudge` / `noop`, and its
recommendation was that the controller do the same. That is the design this plan explicitly rejected:
*"the controller composes rules; it does not invent actions"*, and *"remediation selection, once the
cause is known, is mostly mechanical"*. A model that emits verbs can emit a verb the matrix would not
have chosen for that row, and nothing downstream would catch it. **The model emits a cause; the
controller looks up the remediation.** The timing result transfers unchanged — a one-token class label
is if anything cheaper than a verb — so nothing is lost by keeping the contract.

Its caveats are recorded and acted on rather than waved through: the scenarios were unambiguous by
construction, at one run each and temperature 0, so this measures the common case. That is precisely
why the reason survives at tier 2, where the cases that defeated tier 1 live.

### Running the judgement host on a different machine from the board

**Only do this when the board host cannot run the model itself.** Co-locating the model with the
board is simpler in every respect — see the all-in-one note in *The Controller Wakes on a Clock*. The
constraints below are the price of splitting, and none of them exist when you do not.

Where the split is forced (a Pi 400 board, which cannot run a model at usable speed), it holds for an
on-board controller as much as a remote one — the controller placement and the model URL are independent (see the placements
table in *The Controller Wakes on a Clock*). With the board on the Pi and the model on
`100.74.181.81:11434`, one wake puts exactly two things on the tailnet: the prompt out, and one line
back. Against 5.6 tok/s decode the network hop is noise and is not worth optimising.

Four constraints this topology creates, none of which are visible from either machine alone:

1. **`OLLAMA_KEEP_ALIVE` must exceed the wake interval.** The measured host runs `30m` against a
   5-minute wake, so the model stays resident. Invert them and *every* judgement call pays a 7.2 GB
   load from disk first. This is a coupling between two settings on two machines with nothing
   connecting them, so the controller records the observed first-token latency in the report — a
   sudden jump is this, and nothing else looks like it.
2. **The model call needs its own connect deadline, not the CLI's.** `switchboard api --timeout`
   governs board calls (`cli.ts:563`); the controller's model client is separate code. A closed laptop
   lid does not refuse a connection, it black-holes it — no RST, so a bare connect waits on the OS
   default, which is far longer than a wake interval. The deadline covers connect, not just read, and
   a timeout is a failed validation: the rule did not run, and the report says the model host was
   unreachable rather than that the row was clean.
3. **The endpoint is unauthenticated, and tailnet membership is the entire gate.** Ollama bound to a
   tailnet address carries no token. Anything on the tailnet can prompt it. That is acceptable under
   the current single-user posture and is the reason the model endpoint must never be bound to a
   non-tailnet interface. Redaction is therefore not optional politeness — it is the only thing
   standing between a log tail and a host the board does not control.
5. **A cloud tier makes the board's outbound internet access a requirement, and that must be
   declared.** A configuration whose only judgement backend is a hosted API — a Pi board with no local
   model, reaching Gemma through Google's OpenAI-compatible surface
   (`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`, AI Studio key) — needs
   the board host to reach the public internet. Nothing else in this product does. An appliance on an
   isolated LAN therefore *cannot* run that tier, and the capability probe must report it as
   unreachable with that reason rather than as a transient failure. The API key goes to
   `encryptedSecretsStore` like every other credential.
6. **A third-party tier ships evidence off the network on every wake, indefinitely.** With a local or
   tailnet model an unredacted slice leaks to a machine the operator owns. With a hosted tier it
   leaves for good. Redaction moves from important to load-bearing, the tier's `operator` field must
   be visible in the panel, and the smallest window that answers the rule is not an optimisation but
   the control.
4. **Record which model URL answered, in every entry.** Two machines, one config: "which model
   answered this classification" must be answerable after the fact, not inferred from what was
   configured at read time. Same rule as the board target's `source`.

**Redaction placement follows from this.** The controller always runs on the board host, so the raw
log tail — the file whose own docblock says it echoes tokens, env and paths — is read over loopback
and redacted **before anything leaves the machine**. There is no supported arrangement in which an
unredacted slice crosses a wire. What does leave, in the split-model and hosted-tier configurations,
is the redacted evidence window, which is why its size is a control and not an optimisation.

### Duty cycle

13.4s per call on a 5-minute wake is a 4.5% duty cycle, ~68 kWh/yr — within a couple of dollars of
leaving the machine idle. Noted because it settles whether a standing controller is worth running at
all; nothing in the design depends on it.

## Verification Plan

### Automated Tests

- A seat whose log tail ends in a question is **not** nudged or cleared — row 3 fires, not row 2.
- A seat reporting a quota error is stood down and not re-dispatched on the following wake.
- With the model host **powered off** (not merely refusing), a pass completes inside its wake interval
  and the report names the skipped judgement rows.
- A judgement row fed a deliberately invalid model reply applies **no** remediation and reports the
  row as not run — a malformed answer is not a decision.
- Every applied remediation in the report names its rule, its rung, its evidence, the command run and
  the model that answered.
- The supervisor seat is never diagnosed by the controller's own matrix, and a deliberately stalled
  supervisor produces no self-escalation loop.
- A subject with an open supervisor escalation is not escalated again on the following wake.
- A case whose remediation is unavailable is never escalated to any tier, and the report says why.
- With tier 2 configured, no supervisor wake occurs without tier 2 having declined first; with tier 2
  absent, tier 1 reaches the supervisor directly.
- A deliberately spurious escalation returns `spurious` with no repo read and no tool use, and the
  verdict is attributed to the rule that escalated.
- The global escalation ceiling, when reached, is reported rather than falling silent.
- With tier 1 configured and tiers 2 and 3 absent the controller runs and names the missing tiers —
  and the same holds for every other prefix of the backend list, including supervisor-only.
- A classification tier 1 declines is escalated to tier 2 before any supervisor wake.
- The tier list resolves its endpoints, models and key-set flags from the existing
  `agentControlProviders` rows; no second endpoint store is introduced, and a provider edited in the
  existing config row is the provider the controller calls.
- A reroute resolves a target seat by recorded provider; with the provider unrecorded the row reports
  unavailable rather than picking a seat. Quota stand-down state survives a board restart.
- No code added by this subtask reads, writes or migrates `routed_to`, `dispatched_agent`,
  `dispatched_ide`, `dispatched_terminal`, `queue_position`, `released_at`, `outcome` or `workflow`.
- The controller sends **no** `response_format`, `format`, `grammar`, `guided_json` or
  `structured_outputs` field as a *requirement*: assert a judgement call succeeds end to end against a
  stub endpoint that ignores every such parameter and returns only the two-line text reply.
- The model is never asked for a remediation, a verb, a column id or a command line: assert the
  prompt's answer vocabulary is the eight class labels and nothing else, and that the remediation
  applied comes from the matrix row, not from the reply.
- A reply whose `CLASS:` value is outside the closed set, or that has no `CLASS:` line at all, applies
  no remediation and reports the row as not run.
- A **tier-1** call requests `CLASS:` alone — assert the prompt contains no request for a reason,
  rationale or explanation, and that a tier-1 reply containing prose still parses on its `CLASS:` line.
- A **tier-2** call requests `REASON:` before `CLASS:`, and a tier-1 call never does.
- A tier-1 reply that fails validation escalates to tier 2 rather than being retried indefinitely or
  coerced into the nearest valid class.
- The supervisor's structured output reaches the board with no scrollback parsing; a malformed payload
  is reported, not dropped.
- Row 7's model-judged trigger fires only on the declared threshold and never on a single seat's
  classification; the restart mechanism it calls is the controller's, verified in that subtask.
- The controller sends `reasoning_effort: "none"` on every judgement call, and contains **no**
  runtime-specific branch: grep the controller sources for `/api/generate`, `/api/chat` and a literal
  `ollama` and assert zero hits. One request shape for every backend.
- An empty reply carrying `done_reason=length` is treated as a failed validation — no remediation
  applied, row reported as not run, escalated — and the report entry names the `done_reason`.
- A tier-1 prompt contains no request for a reason, rationale or explanation; a tier-2 prompt does.
- Every report entry naming a judgement result also names the model URL that answered it, together
  with that tier's declared `locality`, `operator` and `costClass`.
- A deployment whose **only** configured tier is a hosted API works end to end: assert the controller
  runs, judgement rows are available, and no code path assumes a tier is local or free.
- On a host with no route to the public internet, a hosted tier reports unavailable **with that
  reason** ("no outbound internet") rather than as a transient model failure, and mechanical rows
  still run.
- With a metered tier configured, reaching the global ceiling is reported in the entry; assert the
  controller does not simply stop escalating silently.
- With the model host's interface down (black-holed, not refusing), the controller's model call aborts
  on its own connect deadline well inside the wake interval, and the report says the host was
  unreachable rather than reporting the row clean.

### Goal Invariants

1. Row 8 (`unknown`) is present in the shipped default matrix and is reachable — assert a judgement
   call returning an unparseable reply resolves to `unknown`, not to a neighbouring class.
2. The supervisor seat name appears in the controller's exclusion set, and a matrix evaluation over a
   fleet containing the supervisor never emits a row for it.
3. No `confirm(`, `window.confirm(` or `showWarningMessage` appears on any path added by this
   subtask.
4. No unredacted token, absolute path or env value drawn from a log tail appears in a report entry or
   in a recorded model request — **paired with:** the evidence window is still sufficient to identify
   the rule's trigger.

**Goal-vs-appearance:** a judgement chain that classifies every stuck seat as `unknown` satisfies
invariants 1-4 while achieving nothing the Goal asks for. So:

5. Against a fixture set of seat log tails — one ending in a question, one with a provider quota
   error, one with a non-zero exit, one with repeated identical output, one clean-but-silent — the
   matrix produces the **correct row** for each, and specifically does **not** produce row 2 (nudge)
   for the question or the quota case. Diagnosis accuracy, not loop liveness, is the measure.

## Appendix: sizing guidance, not specification

Measured on a Pi 400 (Cortex-A72, ARMv8.0 — no dotprod, no i8mm):

- Google's prebuilt `litert-lm` binary is compiled for ARMv8.1+ and dies with `illegal hardware
  instruction` on an A72 (LiteRT-LM issue #1847, open, no baseline build). On a Pi 5 it is
  excellent — 99 t/s prefill, 9 t/s decode, 1432 MB peak for Gemma 4 E2B.
  *Re-checked 2026-09-17: #1847 was opened 2026-04-03, is still **open**, has an assignee, carries no
  maintainer response, and no baseline ARMv8-A build has been published. The A72's flags are
  `fp asimd evtstrm crc32 cpuid` — no `atomics`/`lse`, no `sha2`, no `aes`, no dotprod, no i8mm.*
- By contrast **llama.cpp runs on the A72 without recompilation**: it selects CPU kernels by runtime
  dispatch and falls back on lower-feature CPUs, and a portable build is available explicitly via
  `-DGGML_NATIVE=OFF -DGGML_CPU_ARM_ARCH=armv8-a`. Ollama likewise installs and runs on a Pi 4. The
  constraint on the 400 is throughput, not compatibility — which is what the measurements below say.
- The GGUF fallback via llama.cpp does run on an A72, at 1.3–2.4 t/s prefill and 1.5–1.8 t/s
  decode — measured, and judged unusable for agent work.

**Prefill throughput is the binding constraint, not RAM** — *on the A72*. See `## Host measurements`
above: on the i7-1165G7 tier-1 host the ratio inverts (prefill 228 tok/s, decode 5.6 tok/s), and
output length becomes the dominant cost. Which end binds is a property of the host, not of the
design; read both sections together. Below roughly the A72 figures above, the
judgement rows are not worth arming; the controller should run mechanical-only. A 5-minute wake has
no latency pressure, so where headroom exists it should buy judgement quality (a larger model)
rather than speed.

These are observations to help an operator choose. They are not requirements, and no code reads
them.


## Resolved Assumptions

Both items previously listed as uncertain were researched on **2026-09-17** and are settled. This
section is authoritative: do not re-open these, and do not send anyone to re-research them.

### A. Constrained output across local inference runtimes

**Settled: validate-and-reject remains the guard. No runtime's grammar may be assumed present.** The
original reasoning was right and one of its three premises was wrong.

**Read this section as evidence, not as a requirement.** Change 7 now asks the model for a two-line
text reply whose only machine-consumed value is one enum label, so the controller needs no structured
output facility from any runtime. Nothing in the table below gates a deployment; it records *why* a
grammar is never depended on, and what an operator gains if one happens to be available. What is
actually true:

| runtime | constrained output | reachable via `/v1/chat/completions`? |
| --- | --- | --- |
| **llama.cpp / llama-server** | GBNF grammars; a JSON-Schema→GBNF converter | **Yes.** `response_format` accepts `{"type":"json_object"}` and `{"type":"json_schema","schema":{…}}`. An earlier bug (ggml-org/llama.cpp#11988, `json_schema` ignored on the OAI endpoint) is **closed**, fixed by PR #12168. The alternative **LLGuidance** backend is **off by default** — it needs `-DLLAMA_LLGUIDANCE=ON` *and* a Rust/cargo toolchain, so it is absent from stock builds. |
| **Ollama** | JSON Schema, compiled to a llama.cpp grammar | **Partially, and unreliably.** The native field is `format`. On the OpenAI endpoint, OpenAI's nested `response_format: {type:"json_schema", json_schema:{name, schema}}` shape is **not honoured** (ollama/ollama#10001, **open**, no maintainer fix), and property order is **not preserved** through the compat layer, which changes model output. |
| **vLLM** | xgrammar and guidance backends; choice / regex / json / grammar / structural_tag | **Yes, but renamed.** `guided_json`, `guided_regex`, `guided_choice`, `guided_grammar`, `guided_decoding_backend` were **deprecated in v0.12.0** in favour of `structured_outputs: {json: …}`. A client sending the old field against a new server gets no constraint. |
| **LM Studio** | `json_schema`, same shape as OpenAI | **Yes.** GGUF models use llama.cpp grammar sampling; MLX models use Outlines. Ships an explicit warning: *"Not all models are capable of structured output, particularly LLMs below 7B parameters."* |
| **MLX-LM** | via Outlines logits processors | Only through a server that wires it (LM Studio, mlx-omni-server). Bare `mlx_lm` is a library seam, not an endpoint parameter. |
| **LiteRT-LM** | **Yes** — LLGuidance backend (`LlGuidanceConfig`: regex, JSON Schema, Lark) and `ExternalConstraintConfig`, set through `ConversationConfig::Builder`/`OptionalArgs.decoding_constraint` | **Undetermined.** Google's own `litert-lm serve` (port 9379) documents only `model` and `messages` and says nothing about `response_format`. Third-party wrappers do pass schemas to the native constrained decoder. So the capability exists in the runtime and is not documented on the endpoint the controller talks to. |

**The controller holds a URL, not a runtime.** On every row above the grammar is reachable only
through a *specific* configuration — a non-default build flag, a non-OpenAI request field, a renamed
parameter, or an undocumented server path. None of that is visible from a URL. The plan's position
stands unchanged and is now evidenced.

**Two measurements that argued the reply format down to plain text:**

- **Schema coverage collapses on complex schemas.** JSONSchemaBench (Guidance / Outlines / llama.cpp
  / XGrammar / OpenAI / Gemini) measures empirical coverage at ~93–96% on easy schemas but **3–41%**
  on its "GitHub Hard" set — Outlines 3%, XGrammar 28%, llama.cpp 39%, Guidance 41%.
  Compliance-when-accepted was highest for Guidance throughout. The controller avoids this band
  entirely by sending no schema.
- **Tier 1 may be too small to emit structured output at all.** LM Studio documents that models below
  ~7B often cannot, which lands squarely on the plan's "small local model" tier. Emitting one label
  from a labelled list is a much easier task than emitting a valid object, so the plain-text reply
  format is also what keeps tier 1 viable at that size. Where a tier-1 reply still fails to parse,
  the tier-1 → tier-2 escalation gate already covers it — validation failure is a designed-for
  outcome, not an exception.

**On whether constraining hurts quality — the literature disagrees, and the plan's split is on the
safe side of the disagreement.** *Let Me Speak Freely?* (EMNLP 2024 Industry) finds strict JSON mode
significantly degrades **reasoning** tasks while **improving classification** accuracy, and recommends
the two-step "NL-to-Format" pattern, which recovered nearly all the loss. JSONSchemaBench finds the
opposite sign on reasoning, measuring up to **+4%** from constrained decoding. Both agree on
classification. The controller's judgement rows are closed-set **classification**, which is the case
neither paper disputes; the "fix it" work that needs real reasoning is tier 3, an agent seat with no
schema on it. Mitigation adopted: no reason at tier 1 at all, and reason-before-answer at tier 2,
where the ambiguous cases are (change 7).

### B. Detecting a process supervisor from inside the supervised process

**Settled, and the answer is worse than the plan assumed — which strengthens change 10's deferral.**
Change 6's fourth probe and change 10's availability gate both assume "supervisor present" is
determinable. Per platform:

| platform | can the process tell it would be restarted? |
| --- | --- |
| **systemd** | **Partially.** `$INVOCATION_ID` is set on activated units and is the usual signal, but it is **inherited across login boundaries** — an interactive SSH or serial-console shell carries it, and `dotnet/extensions#2525` is a shipped false-positive report of exactly this. Worse, it proves *"I am a unit"*, not *"I will be restarted"*: a unit with `Restart=no` sets it too. A truthful probe must resolve its own unit name from `/proc/self/cgroup` and read `systemctl show --property=Restart <unit>`. |
| **launchd** | **No.** There is no API to read a job's `KeepAlive` from inside it. Undetectable. |
| **Docker / Podman** | **No.** The restart policy lives in `HostConfig.RestartPolicy`, readable only host-side via `docker inspect`. Nothing inside the container exposes it. |
| **Kubernetes** | **Only via the API server.** `restartPolicy` (default `Always`) is a Pod-spec field; reading it needs a service account, RBAC and a network call. |
| **runit / s6 / OpenRC** | **No standard signal.** No documented in-process way to determine supervision or restart intent. |

**Consequences written into the plan:**

1. **Change 10's deferral is confirmed as correct, on stronger grounds than cost.** Row 7 is not
   merely expensive to support off-systemd — on macOS, Docker and the BSD-style supervisors it is
   **not knowable** whether a restart would be recovered. A board restart that nobody brings back is
   the worst outcome in the plan.
2. **Three states, not two — the fallback rule applies to this probe.** `supervisor present`,
   `supervisor absent` and `supervisor undetectable on this platform` are three different facts, and
   the last is the common case. Collapsing "undetectable" into "absent" is the quiet-wrong-answer
   pattern; collapsing it into "present" risks an unrecoverable board. The probe returns
   `{ enabled, reason, source }` with `source` naming the signal it used (`invocation-id+restart-prop`,
   `none`, `platform-undetectable`).
3. **`$INVOCATION_ID` alone is never sufficient.** Where it is the only signal available the probe
   reports `undetectable`, not `present`.

---

**Recommendation: Send to Lead Coder.** Complexity 8 — multi-file, multi-surface, introduces a new
long-running client, new board state with a concurrency contract, and composes with five existing
sweeps that mutate the same rows.

---

**Recommendation: Send to Lead Coder.** Complexity 7 — five interacting judgement rules, an
unattended tool-using agent in the loop, and three new pieces of board state behind reroute.

---

## Implementation summary (2026-09-17)

The judgement half shipped, standalone-only. A new `src/standalone/judgement/` module holds the
closed eight-class set and its `CLASS:`/`REASON:` parser, an OpenAI-compatible model client that
sends `reasoning_effort: "none"` with no `response_format`/grammar field and has a CONNECT-covering
deadline, the ordered tier chain (tier 1 asks `CLASS:` alone; tier 2 asks `REASON:` then `CLASS:`;
`unknown` escalates to the next tier and is terminal only at the last), the supervisor prompt
contract with its `spurious`-first refusal path, and the local per-provider key read from the
existing encrypted secrets store.

The board gained a resolved judgement-tier endpoint (endpoints/models/keySet from the existing
`agentControlProviders` rows, order/metadata from `controller.judgement`), quota and escalation
state in the config table, and a supervisor-post endpoint that validates a closed verdict set and
refuses a late answer. Reroute is built on the seat's recorded `cliFamily` (now surfaced on
`ptyListTerminals`) with a role-compatible, different-provider resolver; an unrecorded provider
reports the row unavailable rather than guessing. Rows 3, 5, 6 and 8 evaluate; row 7 declares
itself unavailable via a new `declaredUnavailable` field on the matrix row.

The supervisor is excluded from its own checklist, escalation is gated by criteria (one open
escalation per subject, N stuck passes, last tier consulted, not the supervisor, not parked) rather
than a rate limit, and quota stand-down is re-read from the board at the top of every wake. The
declared global ceiling is controller state and is reported when reached. Untested in this run by
directive — the plan's verification checks remain the gate.

## Fix round (2026-09-17)

Review found change 8 constraint 1 unmet: the supervisor exclusion lived only downstream of
diagnosis, so a supervisor seat holding a quiet card still became a subject and could be nudged or
cleared by rows 1/2/4. The exclusion is now explicit and applied BEFORE any rule: an exported
`controllerExclusionSet(supervisorSeat)` is built from the configured supervisor seat and passed to
`collectSubjects`, which skips any card whose `ownerSeat` is in the set. An excluded seat never
becomes a subject, so no row — mechanical or judgement — is ever emitted for it; the downstream
checks in `escalationGate` and `resolveRerouteTarget` remain as defence in depth.

**Re-dispatch 2026-09-17:** the card was re-staged to Coding-coder-2. Verified the implementation is
present and intact in the tree (`src/standalone/judgement/`, controller integration, board routes,
supervisor exclusion), `protocol-catalog.json` in sync, no forbidden runtime strings and no confirm
gates. No new work was required.



