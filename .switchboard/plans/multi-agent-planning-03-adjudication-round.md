# Multi-Agent Planning 03 — Adjudication Round: Resolving Divergence Against the Code

## Goal

Resolve the split, contradicted and singleton claims surfaced by the divergence map by dispatching bounded, self-contained verification tasks back to the fleet, folding the verdicts into the map, and re-running synthesis with fewer open questions.

Depends on `multi-agent-planning-02-divergence-map.md` for the map. Without this plan, unresolved claims ship as open questions — a working outcome, just a weaker one. This plan converts open questions into settled facts where the code can settle them.

### Problem analysis and root cause

**This is the one phase where cross-agent information sharing is safe, and understanding why is the whole design.** The reason to keep investigators' findings apart during generation (plan 01) is that agents who read each other's findings anchor collectively, producing correlated error — four agents in confident agreement about a fiction. That risk is entirely a *generation*-phase risk. By the time the divergence map exists, the independent hypotheses have already been formed and recorded; sharing information now cannot corrupt hypothesis generation, because generation is over. So the rule that falls out is: **findings stay apart during generation, and are deliberately put in contact during resolution.**

Note what this does *not* require: no messaging mechanism changes between the phases. Under teams the isolation in phase 1 is a filesystem-scoping property, not a comms switch (plan 01, blocker 3), so phase 3 does not "turn comms back on" — it hands one agent the two competing claims **inside the prompt body**. The transport is identical in both phases.

The corollary is that no message bus is required. Adjudication traffic is 1→1, lead→worker, short, and factually bounded: *"Investigator B asserts the importer auto-creates a projects row at `src/x.ts:42`; Investigator C asserts it is resolve-only. Read it and report which, with a citation."* That is exactly the shape the existing point-to-point dispatch already handles well (the Link-up path — modal at `src/webview/terminals.js:8233+`, relaying via `POST /terminals/verb/ptySendPrompt` at `:8862`). The elaborate shared-channel machinery that a general agent-coordination bus would need buys nothing here — the traffic pattern that actually matters is a star, not a mesh. The tree agrees: every relationship preset in `src/services/linkPresets.ts` is head↔member (`direction` is `head-receives` or `member-receives`, `:59-119`), and there is no peer-to-peer preset at all. The star is not a simplification this plan is imposing — it is the only topology the shipped vocabulary can express.

**Root cause of why the naive implementation fails.** Three concrete failure modes, none of which are hypothetical:

1. **The claimant will defend its claim.** Sending "you said X, is X true?" back to the agent that asserted X invites motivated reasoning; the agent's context contains the reasoning that produced X and it will restate it. Adjudication has to go to an agent with no stake in either side.
2. **The investigators may not exist any more — and under teams, that is a certainty, not a risk.** Plan 01 provisions investigators as `scope: 'per-team'` members, which are parented to the head, and `kill(head)` cascades to every child (`src/standalone/ptyFleetService.ts:647`, cascade at `:654`). So the phase-1 seats are *designed* to die with the run; even short of teardown they have ended their turns and may have been `/clear`ed or reused. Any adjudication prompt written as "reconsider what you concluded earlier" is unanswerable in that state. Prompts must be **self-contained** — claim, counter-claim, citations and file paths inline — so a fresh agent with no history can answer them. This constraint and failure mode (1) resolve each other: self-contained prompts are answerable by a neutral agent, which is who should be answering.

   **Teams supplies the right seat for this: a `shared`-scope member.** A member declared `scope: 'shared'` is spawned *unparented*, is reused across teams by the stable name `${teamName}-${label||role}`, and sits outside `liveDelegateCount()` and outside head-owned teardown (`spawnDelegates`, `src/standalone/ptyFleetService.ts:448`, shared branch at `:471`, doc comment at `:439-447`). That is precisely an adjudicator's required shape: it survives the investigators, it is structurally not one of them, and a second run reuses the same seat rather than spawning a new one. Declare the adjudicator as a shared member of the planning team rather than inventing a seat type.

   > **Superseded:** "A member declared `scope: 'shared'` … sits outside both delegate caps and outside head-owned teardown … The seat's `scope` is the load-bearing choice: `shared` keeps the adjudicator outside both delegate caps (`MAX_DELEGATES_PER_PARENT = 8`, `MAX_LIVE_DELEGATE_PTYS = 32`)."
   > **Reason:** Half wrong, verified 2026-08-16. It is outside both caps at the **`spawnDelegates`** layer, which filters shared members out of its arithmetic (`ptyFleetService.ts:457`, `.filter(d => d.scope !== 'shared')`), and outside `liveDelegateCount()` in both hosts, which counts only handles with a `parentInstanceId` (`bootstrap.ts:1938-1939`, `TaskViewerProvider.ts:11331-11336`). But the **pre-flight** in `instantiateAgentGroupCore` does *not* filter — it sums every member regardless of scope (`agentGroupInstantiation.ts:77-79`) while its own comment at `:73` claims to "Mirror spawnDelegates' own arithmetic exactly". The two disagree, and the pre-flight runs first and refuses the whole team.
   > **Replaced with:** the `shared` adjudicator is exempt from the caps **at spawn time and in the live count**, but is **counted against `MAX_DELEGATES_PER_PARENT = 8` by the pre-flight**. Practical constraint: `investigators + shared adjudicator ≤ 8` in one team definition. At plan 01's recommended 3–5 investigators this is slack, but an 8-investigator roster plus this seat is refused before anything is created — and the error will read as a delegate-cap failure for a seat that is not, in fact, a delegate. If that ceiling ever binds, the fix is upstream (make the pre-flight filter `scope !== 'shared'` like `spawnDelegates` does), not a workaround here.

   **A second consequence of plan 01's team-prompt split.** Plan 01 now carries the run-invariant half of the brief as the team definition's `prompt`, delivered as one `team`-scoped standing order to **every member of the group** — and `wireSpawnedTeam` pushes shared children into that group alongside the per-team ones, so the adjudicator receives it too (`selectOrders`, `standingOrders.ts:104-111`, gates on `group.members.includes(targetName)` and excludes only the head). That is correct for the callback clause and actively wrong for the isolation clause: the team prompt's "write only to your own output path, never read a sibling's draft" rule would be delivered to the one seat whose entire job is to read across the investigators' claims. Resolve it deliberately — either word the isolation rule so it is scoped to drafting ("while authoring a draft plan…"), or give the adjudicator its own team so it gets its own prompt. Do not leave it to the adjudicator to notice the contradiction.

3. **Adjudication can live-lock.** A verdict is itself a claim, and a claim can be disputed. Without a stop condition, verdict-on-verdict traffic keeps agents' turns alive indefinitely — the ping-pong failure that any inter-agent messaging design hits at three or more participants. Needs a read watermark (only claims newer than last adjudicated), a bounded round count, and an explicit rule that a verdict is not itself adjudicable.

**Why the existing dispatch is the right substrate anyway.** Investigators at phase 3 are idle — they have ended their turns — so stdin delivery is correct and carries no interrupt risk. This is the dispatch case, not the mid-flight coordination case, and `switchboard-contracts` #9 states the property this phase depends on: a message delivered to an idle agent terminal *is* the turn. The write path (`sendPromptToPty`, `src/standalone/ptyPromptDelivery.ts:36`) is a blind chunked bracketed paste with **no idle gate** — the `ptySendPrompt` verb checks only `handle.status !== 'active'` (`bootstrap.ts:1442`), which distinguishes alive from exited, never busy from idle. That is a real hazard when messaging a *working* agent and harmless against an idle one. It does hold a per-terminal send lock (`withTerminalLock`, `ptyPromptDelivery.ts:24`, applied at `:41`), so two adjudications aimed at the same seat serialize rather than interleave their pastes — relevant to Race Conditions below, and the reason concurrent dispatch to one adjudicator is safe even though concurrent *verdict writes* are not.

Also pass `clearBeforePrompt` explicitly on every adjudication send. The omitted-field default is `false` in both hosts, which is the right default here — but note `switchboard-contracts` #10 still documents the old config-default behaviour and is **stale on this point** (re-confirmed 2026-08-16: `bootstrap.ts:1445-1447` and `TaskViewerProvider.ts:2768-2775` both resolve an absent field to `false`, not to the config value). There is a third state the contract also omits: `clearBeforePromptFromConfig: true` asks the host to resolve `switchboard.terminal.clearBeforePrompt` on the caller's behalf — it exists for the webview drop path, which cannot read config itself, and is stripped before reaching the delivery layer. Do not rely on the contract text for this field; rely on the explicit payload.

**Blast radius.** Additive on top of plan 02. Adds dispatch traffic and one more artifact in the run directory. If the adjudication budget is exhausted the behaviour degrades exactly to plan 02's — open questions in the emitted plan.

## Metadata

**Tags:** feature, backend, reliability
**Complexity:** 5

## User Review Required

**One decision:** the adjudication budget — how many claims per run are worth verifying, and how many rounds. Every adjudication is a dispatch and a turn, so an unbounded map on a contentious problem could cost more than the original run. Recommend capping by claim count (verify the N highest-impact disputed claims) rather than by round count, since impact is what the user cares about.

## Complexity Audit

### Routine

- Selecting rows from the divergence map by bucket.
- Dispatching a prompt to an idle terminal via the existing PTY delivery path.
- Appending verdicts to a map artifact.

### Complex / Risky

- **Adjudicator selection must exclude both parties.** Route each disputed claim to an agent that asserted neither side. The `shared`-scope adjudicator seat makes this structural rather than a routing rule — it never investigated, so it cannot be a party — which is why it is preferred over reusing a surviving investigator. Never route to the claimant.
- **The adjudicator inherits the planning team's prompt, isolation clause included.** See Problem analysis (2). A seat told "never read a sibling's draft" and then asked to adjudicate across drafts has been handed contradictory instructions, and the failure is silent — a refusal or a hedged verdict reads like an underdetermined claim. Scope the isolation clause to drafting, or give the adjudicator its own team.
- **The `shared` seat is cap-exempt at spawn but cap-counted at pre-flight.** `investigators + adjudicator ≤ 8` per team definition. Size the roster against that, and read a pre-flight refusal as a roster problem rather than a live-fleet problem.
- **Prompts must be self-contained.** Phase-1 context is gone by now. Inline the claim, the counter-claim, both citations and the file paths; assume the recipient has no memory of the run.
- **Live-lock prevention is not optional.** Watermark on adjudicated claims, a hard round cap, and a rule that a verdict is terminal — not itself a claim to adjudicate. Without all three this deadlocks under load, and it will deadlock unattended at the worst possible time.
- **A verdict must be falsifiable, not a vote.** The adjudicator's answer is only worth anything if it carries a citation that a human or a later pass can check. "C is right" without a `file:line` is another opinion; the point of this phase is to replace opinion with code.
- **Unresolvable is a legitimate verdict.** Some disagreements are genuinely underdetermined by the code — e.g. two readings of intended behaviour where the code supports both. The adjudicator must be able to return "underdetermined" and have that flow through to an open question, rather than being pressured into picking a side. Forcing a verdict on an underdetermined claim manufactures exactly the false confidence the whole design is built to avoid.
- **Impact ranking, not map order.** Adjudicating in map order spends the budget on whatever happened to sort first. Rank by how much the claim changes the plan if it flips — a disputed root cause outranks a disputed file path.
- **A surviving `shared` seat accumulates standing orders and is nobody's responsibility.** It is outside head-owned teardown by design, so it stays live after the run and keeps its team-scoped order — and nothing in the system prunes standing orders (`agentGroupInstantiation.ts:85`, "nothing ever pruned orders"). Over many runs against differently-named heads it can collect several team orders at once. The operator must be able to see and close it; treat the seat as a visible resource with an owner, not an implementation detail.

## Edge-Case & Dependency Audit

**Race Conditions** — concurrent adjudications writing verdicts to one artifact need distinct keys per claim, or atomic append. Two adjudicators assigned the same claim (through a selection bug) must not produce two verdicts that silently overwrite one another; key verdicts by claim id and detect duplicates. The *dispatch* side is already safe: `sendPromptToPty` serializes sends per terminal through `withTerminalLock`, so two prompts aimed at the same adjudicator queue rather than interleaving their bracketed pastes. The verdict-write side has no such protection and must supply its own. Separately, the shared-seat *reuse* check is serialised per name through `_sharedMemberChain` (`ptyFleetService.ts:485-500`), so two heads starting concurrently cannot both spawn the same adjudicator.

**Security** — none new. Existing authenticated dispatch surface.

**Side Effects** — additional dispatch traffic and token spend. A verdict artifact in the run directory. Re-running synthesis after adjudication may change the emitted plan set — if plan 02 already wrote plans to `.switchboard/plans/`, re-synthesis must update those files rather than emit a second set, or the board gains duplicate cards. Prefer adjudicating *before* first emission; if that ordering cannot be guaranteed, the re-synthesis path must be an update, not an insert. A live `shared` terminal persists past the run.

**Dependencies & Conflicts** — requires the divergence map from plan 02, and the **teams feature** for the adjudicator seat. Shares the dispatch path with plan 01's fan-in but at a different phase, and unlike plan 01 it deliberately puts competing findings in contact — though that contact happens in the adjudication prompt's own body, not through any messaging change, so no phase transition is required. The seat's `scope` is the load-bearing choice: `shared` keeps the adjudicator outside head-owned teardown and outside `liveDelegateCount()`, at the cost of it *surviving* the run and of still being counted by the per-head pre-flight (see the Superseded callout above). A `per-team` adjudicator would instead die with the run, which defeats the point.

**Project-PRD interaction (Browser Switchboard).** This phase reuses `ptySendPrompt` on the **terminals** rail (`LocalApiServer.ts:3780`), which is outside the panel verb rails the PRD's return-contract ratchet and `verbSchemas.ts` govern, so no ratchet or schema obligation is incurred. Should adjudication instead be exposed as a panel verb, PRD contracts #4/#5/#7 bind in full — return-in-body, permissive field-accurate schema, allowlist/catalog parity, and wiring in **both** hosts.

## Dependencies

`multi-agent-planning-02-divergence-map.md` — provides the claim buckets and citations this plan resolves.

The **teams feature** — specifically the `shared` member scope, which supplies a stake-free adjudicator seat that outlives the investigators, and the team-scoped standing order (into which `reports-to-head` is folded), which carries verdicts back to the head without polling.

## Adversarial Synthesis

**Risk Summary.** The dominant risk is live-lock: verdicts are themselves claims, and without a watermark, a hard round cap and an explicit "a verdict is terminal" rule the loop runs until something is killed — worst in an unattended run. Second is the adjudicator's instruction conflict: it inherits the planning team's prompt including plan 01's sibling-isolation clause, which contradicts its job and fails silently as a hedged verdict. Third is the cap asymmetry — the `shared` seat is exempt at spawn but counted by `instantiateAgentGroupCore`'s pre-flight, so an oversized roster is refused with a misleading delegate-cap error. Mitigations: all three stop conditions shipped together and tested as a set; scope the isolation clause to drafting or give the adjudicator its own team; size rosters to `investigators + adjudicator ≤ 8` and treat that refusal as a roster problem. Everything else degrades gracefully to plan 02's open-question behaviour.

## Implementation

1. Select adjudication candidates from the map: split, contradicted and singleton buckets. Rank by impact — how much the plan changes if the claim flips — and take the top N within the configured budget.
2. For each candidate, choose an adjudicator with no stake. Prefer the planning team's `shared`-scope adjudicator seat — unparented, outside head-owned teardown, surviving the investigators, and structurally not a party. Fall back to an investigator that asserted neither side only if that seat is unavailable. Never the claimant.
3. Resolve the adjudicator's standing-order conflict before the first run: either scope plan 01's isolation clause to drafting, or declare the adjudicator in its own team definition so it receives its own prompt. Whichever is chosen, verify the delivered text — the conflict is invisible at the call site.
4. Compose a self-contained adjudication prompt — claim, counter-claim, both citations, file paths, and the required answer shape (verdict + citation, or `underdetermined`). Assume the recipient has no memory of the run.
5. Dispatch via the existing PTY delivery path. Recipients are idle at this point, so stdin delivery is correct and needs no idle gate. Pass `clearBeforePrompt` explicitly rather than relying on the omitted-field default or on the stale contract text.
6. Leave standing orders **on**, as in phase 1. There is nothing to lift: plan 01 no longer suppresses them, and the team-scoped order carrying `reports-to-head` is the verdict return path — it is what makes the adjudicator POST its verdict back to the head without being polled. Suppressing them here would cost this phase its return channel for the same reason it would cost phase 1 its completion signal.
7. Collect verdicts into a `verdicts.md` artifact keyed by claim id; reject and flag duplicate verdicts for the same claim rather than overwriting.
8. Enforce the stop conditions: watermark so an adjudicated claim is never re-dispatched, a hard round cap, and a rule that a verdict is terminal and not itself adjudicable.
9. Fold verdicts into the map, then re-run plan 02's synthesis. Claims refuted by verdict are dropped; claims confirmed are promoted with their verdict citation; `underdetermined` claims flow through as open questions.
10. Ensure re-synthesis updates any plan files plan 02 already emitted rather than emitting a duplicate set.
11. Give the surviving `shared` seat an explicit end-of-run disposition — leave it live and visible for reuse (the default, and the reason it does not leak a terminal per run) or close it deliberately. Silence here means an accumulating terminal nobody owns.

## Proposed Changes

### Adjudication candidate selection (new)
- **Context:** The divergence map has no notion of which disagreements are worth paying to resolve.
- **Logic:** Filter to disputed buckets, rank by plan impact, cap by budget.
- **Edge Cases:** Spending the whole budget on trivia because the map sorted that way; an empty candidate set (fully unanimous run) must skip the phase cleanly.

### Adjudicator seat declaration (team data)
- **Context:** `shared` scope gives a stake-free, teardown-surviving, name-reused seat — but it inherits the planning team's prompt and is counted by the per-head pre-flight.
- **Logic:** Declare the adjudicator as a `shared` member; size the roster to `investigators + adjudicator ≤ 8`; resolve the isolation-clause conflict by scoping the clause or by separating the team.
- **Edge Cases:** A pre-flight refusal misread as a live-fleet problem; the adjudicator silently declining to read drafts because the team prompt told it not to; accumulated team-scoped orders on a long-lived seat.

### Self-contained adjudication prompt (new)
- **Context:** Phase-1 investigators may be exited or cleared; nothing today composes a stake-free verification request.
- **Logic:** Inline claim, counter-claim, citations and required answer shape; route to a non-party adjudicator.
- **Edge Cases:** Claimant self-adjudication; a prompt that assumes prior context; an adjudicator pressured into a verdict where the code is genuinely silent.

### Verdict collection + stop conditions (new)
- **Context:** No watermark or round cap exists, so verdict-on-verdict traffic can live-lock.
- **Logic:** Keyed verdict artifact, watermark on adjudicated claims, hard round cap, verdicts terminal.
- **Edge Cases:** Duplicate verdicts overwriting each other; a claim re-entering the queue after adjudication.

### Re-synthesis hand-back
- **Context:** Plan 02 may already have emitted plans into the watched `.switchboard/plans/`.
- **Logic:** Fold verdicts into the map and re-synthesize as an update to existing plan files.
- **Edge Cases:** Duplicate board cards from a second emission; a `shared` adjudicator seat left running after the phase ends, invisible to head-owned teardown.

## Verification Plan

1. A split claim dispatched for adjudication returns a verdict carrying a `file:line` citation, and the losing side is dropped from the final plan.
2. A singleton claim confirmed by adjudication survives into the final plan; one refuted is dropped — verifying the phase resolves against code rather than by agent count.
3. No adjudication is ever routed to the agent that asserted the claim under test.
4. An adjudication prompt is answerable by an agent with no run history — verified by dispatching one to a freshly spawned terminal with no prior context.
5. A claim whose code genuinely supports both readings returns `underdetermined` and appears in the emitted plan as an open question, rather than being forced to a verdict.
6. Verdict-on-verdict traffic does not occur: a verdict is not re-dispatched for adjudication, and an adjudicated claim is not re-selected in a later round.
7. The round cap terminates a contentious run, and the residue degrades to plan 02's open-question behaviour rather than hanging.
8. Re-synthesis after adjudication **updates** the plan files plan 02 emitted; the board card count is unchanged, with no duplicates.
9. A fully unanimous run skips this phase without error and without dispatching anything.
10. The adjudicator seat is not one of the phase-1 investigators — verified structurally by confirming it is the team's `shared`-scope member, which survives the head-kill that removes every `per-team` investigator. A run whose investigators have already been torn down still adjudicates successfully.
11. The `shared` adjudicator seat is reused, not re-spawned, on a second run in the same session — the name-keyed reuse path in `spawnDelegates`, and the reason it does not leak a terminal per run.
12. The adjudicator's **delivered** standing-orders block does not instruct it to avoid reading sibling drafts — checked in the delivered text, not in the team definition. This is the instruction-conflict test and it cannot be verified at the call site.
13. A team definition of 8 investigators plus one `shared` adjudicator is refused by `instantiateAgentGroupCore`'s pre-flight (per-head cap), while 7 + 1 is accepted — pinning the cap asymmetry so a later change to the pre-flight is caught rather than silently widening the roster.
14. `npx tsc --noEmit` introduces no new errors against the pre-existing baseline (re-verified 2026-08-16: exactly 5 `TS2835` errors at HEAD, unrelated).

### Automated Tests

- Unit: candidate selection filters to disputed buckets, ranks by impact, and returns an empty set (no dispatch) for a unanimous map.
- Unit: the adjudication prompt builder never targets a claim's asserting agent, and emits claim + counter-claim + both citations with no reference to prior context.
- Unit: the stop-condition state machine — watermark rejects a re-submitted adjudicated claim, the round cap terminates, and a verdict submitted as a claim is refused.
- Unit: verdict collection keyed by claim id flags a duplicate instead of overwriting.
- Contract: the per-head pre-flight counts a `shared` member while `spawnDelegates` does not — a regression test on the asymmetry, so whichever way it is later resolved, the roster ceiling changes visibly.

## Recommendation

Complexity 5 → **Send to Coder**, after plan 02's map format is settled — the adjudication prompt is a function of the map's claim schema, so building it first would mean rewriting it. The live-lock stop conditions are the part to get right; everything else degrades gracefully, but a deadlocked adjudication loop in an unattended run does not.

> **Improved 2026-08-16 — two code-verified corrections.** (a) The `shared` adjudicator is **not** outside both delegate caps: `spawnDelegates` and `liveDelegateCount()` exempt it, but `instantiateAgentGroupCore`'s per-head pre-flight counts it, contradicting its own "mirror spawnDelegates exactly" comment — so `investigators + adjudicator ≤ 8`. (b) Following plan 01's team-prompt split, the adjudicator now *inherits the investigators' isolation clause*, which contradicts its job and fails silently; resolving that is a new Implementation step. Also recorded the reuse serialisation (`_sharedMemberChain`), the un-pruned standing orders on a surviving seat, and the `clearBeforePromptFromConfig` third state the stale contract #10 also omits.
>
> **Revised 2026-08-15 to sit on the teams feature.** The design stands as authored; two things are now concrete rather than open. The adjudicator is the planning team's **`shared`-scope member** — unparented, reused by name, and surviving the teardown that removes the investigators — which turns "route to a stake-free agent" from a routing rule into a structural property. And the phase no longer "turns comms back on": under teams, phase-1 isolation was a filesystem-scoping property, so the transport is identical in both phases and only the prompt body changes.
>
> **Citation freshness (2026-08-16).** All `file:line` references re-verified against the working tree. `ptyFleetService.ts` lives at **`src/standalone/`**, not `src/services/`. `terminals.js` link-up modal 8045→8233, relay POST at 8862. `ptyPromptDelivery.ts` `sendPromptToPty` :36 and `withTerminalLock` :24 both still exact. Prefer symbol names over line numbers on re-read.
