# The remote command vocabulary is closed at two verbs, because the third one turns a reviewed-plan pipeline into a remote shell

## Goal

Complete the cloud-to-local control loop — a remote agent triggers work, the local fleet does it and pushes, the remote agent sees the outcome — and close the vocabulary that loop speaks. The remote surface may **author content** and **move a card**. It may not carry an instruction. Writing that boundary down is the point of this plan; the connective work is small.

### Problem Analysis

**The loop is already built, and it is three small pieces short of working unattended.** Today: a remote agent sets an issue's status to the execution-trigger state; `RemoteControlService._poll()` picks it up within `pingFrequencySeconds` (default 60); `_applyStateMirror` (`:288`) calls `onColumnMove`, which dispatches the local agent; the agent works, commits, pushes, and posts a completion comment via `postManagedComment`; the remote agent reads it. What is missing:

1. **No auto-start.** The poller needs a manual `start()`. `kanban-startup-reconciler.md` is the plan that closes it; until then the loop runs only if the operator started it, which is the opposite of the away-from-desk use case it exists for.
2. **No dispatch acknowledgement.** `_applyStateMirror` discards `onColumnMove`'s result, so the interval between "I sent the order" and "I know it landed" is invisible — `remote-control-dispatch-acknowledgment-writeback.md`, complexity 4.
3. **SaaS-only transport.** Reaching the loop requires a Linear or Notion workspace. `remote-authoring-over-the-shared-store-as-a-provider-kind.md` adds a store-backed one.

**And the natural next request is the dangerous one.** Once the loop works, the obvious ask is "let the cloud agent just tell the orchestrator what to do" — a free-text instruction queue. That single step removes the invariant the whole design currently rests on.

**The invariant: what gets executed was reviewed.** The remote surface's only command is a column move, and a column move dispatches *a plan file that already exists*. A plan is authored, materialised into `.switchboard/plans/`, imported, and advanced through columns a human moved it into. So the worst a compromised remote surface can currently do is **dispatch an already-reviewed plan at the wrong moment**. Bad, recoverable, bounded. It cannot cause novel code to run, because it cannot author the thing that runs and trigger it in one motion.

A free-text instruction channel collapses authoring and triggering into a single write. That is the entire difference.

### The mechanism: a typed switch table, and why it is stricter than what ships today

The boundary above is a rule; this is how it is expressed in the transport. The remote surface writes **typed switches** — booleans and enums naming operations — never text. The extension owns every prompt, built by the same trusted path that builds dispatch prompts today. Execution results are appended to a **logs table** the remote surface may read. So the remote side *invokes* named operations; it never *describes* one.

**This is narrower than the current remote surface, not merely narrower than the hypothetical queue.** Today a remote agent writes an issue description or Notion page body — free text — and `RemoteControlService._pollDescriptions()` pulls it into the plan file that becomes prompt input. A typed switch table removes that text channel entirely. Adopting it for the store transport is a security improvement over the shipped SaaS path, and the SaaS path's text channel is then the looser of the two, which is worth stating rather than leaving as an inconsistency.

**But typed switches alone do not close the loop, because a switch can select a row.** If the switch is `dispatch_plan_id = <uuid>` and plan bodies may be remotely authored (`remote-authoring-over-the-shared-store-as-a-provider-kind.md`), the sequence is: author a plan, flip the switch at it, and the extension builds a prompt *from that body*. Arbitrary text reaches an agent through a strictly-typed channel. The two designs compose back into the hole each closes separately.

So the division of labour is exact, and both halves are required:
- **Typed switches** stop the remote surface authoring the *prompt*.
- **The review gate** (decision 2) stops it authoring *what the prompt is built from*.

Neither is sufficient. A closed vocabulary over unreviewed content is a text channel with extra steps.

**Correction — the gate is about review, not about remoteness.** An earlier revision of this section framed remotely-authored plans as the hazard. That does not hold up. A plan is markdown, not code, and the agents that consume it already read ticket bodies, PR and review comments and fetched web pages, so a plan body adds almost nothing to the injection surface. More to the point, the realistic scenario is not a malicious author — it is *the operator's own agent, having read a poisoned ticket, writing a plan nobody intended*. A **local** agent reading that same ticket produces the identical outcome; a `/switchboard-cloud` session authoring plans is exactly this case. Nothing in the risk is remote-specific.

So the invariant is transport-neutral: **an agent-authored plan is reviewed before it is dispatched**, whatever wrote it and wherever that ran. That is already what the column workflow does, which means the gate is not a new restriction on remote work — it is the existing workflow stated as an invariant so a trigger mechanism cannot route around it.

What *is* remote-specific is narrower and does not change the rule: the credential is likelier to be misplaced than local machine access, no human is necessarily present at the moment of authoring, and provenance is less visible. Those argue for a visible provenance marker on agent-authored cards and for applying the gate uniformly — not for treating remote authoring as suspect. Remote authoring is a shipped capability and a wanted one; it is not the thing being defended against.

**Three further properties the switch table needs:**

1. **Edge-triggered, not latched.** A boolean left `true` fires on every poll — one flip becomes a dispatch every `pingFrequencySeconds`. Use request rows (id, claimed-at, completed-at, outcome) rather than persistent flags, so a request is consumed exactly once and a retry is explicit.
2. **The logs table is untrusted on read.** It is safe for the remote surface to read; the hazard is the reverse direction. If the local orchestrator ever reads logs back into its own context — retry reasoning, "what happened last time" — a log line carrying agent output that carries attacker-controlled text from a ticket becomes an injection path into the local fleet. The extension writing the log does not make its contents trustworthy.
3. **Versioned switch definitions, unknown switches ignored.** A switch's meaning lives in the extension and will change. A stale cloud session flipping a repurposed switch must be a no-op, never a guess — so definitions carry a version, and an unrecognised switch is dropped with a logged refusal rather than best-effort matched.

**Why this is sharper here than in most products: the fleet reads untrusted content for a living.** Switchboard's agents routinely consume Linear issue bodies, Notion pages, ClickUp tasks, GitHub PR and review comments, fetched web pages, and — once `ticket-metadata-as-first-class-board-state.md` lands — imported ticket descriptions and comment threads stored on the board. All of that is text written by people who are not the operator.

So if an agent that reads such content also holds write access to a command channel, the architecture is a confused deputy: text arriving from a ticket can instruct the agent to write the command queue, and the local controller will execute it because executing that queue is its job. Prompt injection becomes code execution, on a machine holding every repository the operator works on, their SSH keys and their credentials. Nothing about that chain requires a bug — each link works as designed.

**Token scoping does not help here, and it is important not to believe it does.** `libsql-shared-store-turso-and-self-hosted-sqld.md` records that Turso supports table+action scoping, which genuinely narrows *board data* damage: a credential minted `-p all:data_read -p <queue>:data_add` cannot corrupt `plans`, `features` or `projects`. But **no table permission makes a command channel safe**, because the local controller executes the contents of that table by design. A token scoped to insert into an instruction queue is a token that can run code. Scoping protects integrity, not execution, and conflating the two is how this ships by accident.

### Root Cause

The remote surface was built as a *mirror* — a place to see and nudge board state — so its command vocabulary grew from what a board can do (move a card) rather than from what an agent might want to say. That accident is a good design, and nothing currently records it as deliberate, which is precisely how it gets widened by a well-meaning feature request.

### Non-goals

- Restricting what a *locally* dispatched agent may do. Local agents execute code; that is the product.
- Removing the execution-trigger state. It is the loop's whole point.
- Blocking remote authoring. Content is fine — `remote-authoring-over-the-shared-store-as-a-provider-kind.md` covers it.
- A permission system. Switchboard operates no service and enforces no authorisation; this is a vocabulary boundary, not an access-control layer.

## Metadata

**Complexity:** 4
**Tags:** security, backend, reliability, api, docs, feature

## User Review Required

Yes — three decisions.

1. **Is the vocabulary closed, or closed-by-default?** Recommendation: **closed**, and expressed as the typed switch table above rather than as a documented convention. Not a setting, not an advanced toggle — a schema that cannot carry an instruction, plus a contract test, so widening it requires changing a table definition and arguing with a comment. A toggle is a feature request away from being on by default in someone's fork.
1b. **Does the SaaS transport keep its text channel?** The switch table makes the store transport stricter than Linear/Notion, whose descriptions are pulled into plan bodies. Recommendation: **leave the SaaS text channel as-is and rely on the review gate for it** — removing it would break the shipped remote-authoring workflow — but record that the two transports have different tightness, so nobody assumes the switch table's guarantees apply to Linear.
2. **Does a trigger require the plan to be in a reviewed column?** Recommendation: **yes, and for every trigger path rather than only remote ones.** The invariant is that executed work was reviewed; the origin of the plan is irrelevant, since a local agent reading a poisoned ticket authors the same plan a remote one does. So a move into an execution-triggering column is refused for any plan that never passed review, whoever initiated it. This is the control that survives even if the vocabulary is later widened, and scoping it to remote triggers only would leave the identical local hole open.
3. **Credential separation.** Recommendation: **an agent that reads untrusted external content must not hold the credential that can trigger execution.** Two credentials, two trust zones — an authoring/read token for content-consuming agents, and a triggering credential the operator holds. This is the mitigation that actually breaks the confused-deputy chain; the vocabulary boundary limits the damage, separation prevents the chain.

## Complexity Audit

### Routine

- Wiring the dispatch acknowledgement at `_applyStateMirror`, reusing `postManagedComment`.
- A reviewed-column precondition on remotely-initiated dispatch.
- Documenting the vocabulary in the remote protocols and the workflow file.

### Complex / Risky

- **The boundary has to be enforced where commands enter, not where they execute.** There are several entry points — the provider poll, the store queue, the API — and a check at the dispatch site would be the wrong place: by then the instruction has already been accepted as legitimate. The enforcement belongs at the parse of what a remote surface said, and it should be one function so it cannot be forgotten at a fourth entry point.
- **"Reviewed" is a column, and columns are configurable.** A precondition naming a column by string breaks the moment someone renames one, and fails open if written carelessly. It needs to key on the column's role rather than its label, and fail closed when the role cannot be resolved.
- **The acknowledgement is a security surface, not just UX.** Once dispatch posts a receipt, that receipt is the operator's audit trail for what a remote surface caused. It must record which credential initiated and which plan was dispatched, and it must be posted even when the dispatch is *refused* — a refusal nobody can see is indistinguishable from a trigger that silently did not fire.
- **Injection reaches the trigger through content, not only through commands, and not only remotely.** Even with a closed vocabulary, a surface that can author a plan *and* move cards can author then trigger. That is why decision 2 matters — the review gate is what stands between "can author" and "can execute what it authored". The gate must be transport-neutral: an agent authoring locally from a poisoned ticket is the same exposure, so gating only remote triggers leaves the equivalent local path open while looking as though the class is handled. That appearance is worse than not gating at all.
- **The threat model must be written down for the right reader.** This is a published extension with ~4,000 installs, most of them single operators who will never think about any of this. The default posture has to be safe without configuration, and the risky composition should be difficult to assemble by accident rather than merely documented.

## Edge-Case & Dependency Audit

**Race conditions**
- A remote trigger arriving while the plan is mid-review, or being moved locally at the same moment. The review precondition is evaluated at dispatch under the store's ordering, not at poll time.
- Two transports (Linear and the store) triggering the same plan. Idempotent dispatch, and the acknowledgement should record both attempts rather than swallowing the second.

**Security**
- The credential that can trigger must not be the credential handed to content-consuming agents. This is the load-bearing control.
- Attribution is not authorisation (`sync-owner-lease-and-write-attribution.md`): the receipt records which credential acted, which is forensics, not prevention.
- A refused trigger must be visible. Silent refusal trains operators to distrust the loop and hides probing.
- Nothing here should imply Switchboard protects the operator from a leaked triggering credential. It does not; it limits what that credential can express.

**Side effects**
- `switchboard-remote.md` documents the execution-trigger flow and is the natural home for the stated vocabulary.
- The orchestration protocol and the external-team-lead protocol both describe remote-initiated work and need to agree.
- The dispatch acknowledgement changes remote card comment volume; the existing managed-comment markers should keep it legible.

**Migration**
- The acknowledgement is additive. The review precondition could refuse a trigger that previously succeeded — a behaviour change for anyone remotely dispatching unreviewed plans today. It should ship with a clear refusal message naming the reason, and be called out in the release note rather than discovered.

## Dependencies

- **Requires** `kanban-startup-reconciler.md` for the poller to run unattended, which is what makes the loop useful away from the desk.
- **Includes or coordinates with** `remote-control-dispatch-acknowledgment-writeback.md` — the receipt is both this plan's audit trail and that plan's UX fix.
- **Pairs with** `remote-authoring-over-the-shared-store-as-a-provider-kind.md`, whose queue is the third entry point the boundary must cover.
- **Depends on the trust posture in** `libsql-shared-store-turso-and-self-hosted-sqld.md`, and corrects one reading of it: table scoping narrows data damage, never execution.

## Adversarial Synthesis

Key risks: a free-text instruction channel collapses authoring and triggering into one write, removing the invariant that executed work was reviewed; the fleet consumes untrusted external text for a living, so an agent holding a command-channel credential is a confused deputy turning prompt injection into code execution on a machine holding every repo and key; token scoping appears to mitigate this and does not, because executing the queue is the controller's job; and a closed vocabulary alone is insufficient, since a remote surface that can author *and* move could author then trigger. Mitigations: the vocabulary is closed by contract test rather than by setting; remotely-initiated dispatch requires a reviewed column, resolved by role and failing closed; triggering credentials are separated from the credentials given to content-consuming agents; and every dispatch and every refusal posts a receipt naming the credential and the plan.

## Proposed Changes

1. **State the vocabulary** — a remote surface may author content and move a card. Nothing else. Documented in `switchboard-remote.md` and the remote protocols, with the reasoning, not just the rule.
2. **One enforcement point** at the parse of remote intent, covering every transport (provider poll, store queue, API), so a fourth entry point cannot bypass it.
3. **A reviewed-column precondition** on dispatch from any trigger path — not remote-only — keyed on column role rather than label, failing closed when the role cannot be resolved.
3b. **A visible provenance marker** on agent-authored cards, so a reviewer sees what wrote a plan without consulting a queue or a comment history. This is the mitigation for the genuinely remote-specific part (no human present at authoring time, less visible origin), and it serves local agent authoring equally.
4. **Dispatch and refusal receipts** via `postManagedComment`, naming the initiating credential and the plan — the operator's audit trail for what a remote surface caused.
5. **Credential separation guidance**: the triggering credential is not the one given to agents that read tickets, pages, PR comments or the web. Stated wherever a credential is configured.
6. **A typed switch table and an append-only logs table** for the store transport: request rows consumed exactly once, versioned switch definitions, unknown switches dropped with a logged refusal, and no text column through which an instruction could be expressed.
7. **A contract test** asserting no remote transport can deliver a free-text instruction into a prompt, that the switch schema carries no free-text column, and that widening the vocabulary fails CI.
8. **Auto-start via the reconciler** so the loop runs unattended, which is the capability all of this exists to make safe.

### Migration

The receipt is additive. The review precondition may refuse a trigger that previously worked; ship it with a refusal message naming the reason and call it out in the release note.

## Verification Plan

- **The loop, unattended:** with the reconciler running and no human present, a remote trigger dispatches a reviewed plan, the fleet works and pushes, and a completion comment returns. Assert the whole cycle with no manual `start()`.
- **Receipt on dispatch and on refusal:** assert both post, and that each names the initiating credential and the plan. Assert a refusal is never silent.
- **Vocabulary closure:** attempt to deliver a free-text instruction through each transport — provider status/description, store queue, API. Assert every one is refused at the same enforcement point, and that adding a transport without wiring it into that point fails a test.
- **Review gate:** remotely trigger a plan that never passed review. Assert refusal with a reason. Rename the reviewed column; assert the gate still holds, keyed on role. Make the role unresolvable; assert it fails closed.
- **Author-then-trigger:** as a remote surface, author a plan and immediately attempt to trigger it via a switch. Assert the review gate blocks the sequence — the test that proves typed switches plus a review gate is stronger than either alone, and the one that would fail if only the switch table were implemented.
- **Switch schema:** assert the switch table has no free-text column, that an unrecognised switch is dropped with a logged refusal rather than matched, and that a stale definition version is refused.
- **Edge-triggering:** submit one request row and leave it in place across several poll cycles. Assert exactly one dispatch, and that a retry requires a new row rather than re-firing the old one.
- **Log as untrusted input:** write a log line containing text that impersonates instructions, then exercise any local path that reads logs back. Assert nothing in that text influences a prompt or a dispatch.
- **Credential separation:** with one credential configured for authoring and reads and another for triggering, assert the authoring credential cannot trigger, at the database level where scoping permits and at the application level otherwise.
- **Injection end to end:** seed a ticket body containing text instructing the agent to trigger execution. Run the import and a normal agent turn. Assert nothing dispatches — the scenario this plan exists for, tested as a scenario rather than as a unit.
- **Idempotency:** two transports triggering one plan. Assert one dispatch and a receipt recording both attempts.

## Outstanding Questions

- **Resolved:** the gate applies to every trigger path and does not key on the plan's origin — the risk is not remote-specific, since a local agent reading the same poisoned ticket authors the same plan. Provenance should still be visible on the card, for review quality rather than for gating.
- Is there a legitimate remote verb beyond authoring and moving — pausing the fleet, cancelling a dispatch — that is a *control* rather than an *instruction*? Cancellation in particular is safe in a way execution is not, and refusing it may be over-tight.
- For self-hosted sqld, if table+action scoping is unavailable, does credential separation have to be enforced entirely in the application, and is that acceptable?
