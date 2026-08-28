# Compose standing orders from a library instead of installing monoliths

## Goal

Standing orders must be **stored as references and composed at delivery**, not stored as prose and installed per team. A team is told what applies to its actual shape — reviewer seat present or not, feature or plan, head or seat pacing, orchestrator present or not — and it is told the *current* wording of each obligation, because the wording lives in code and is resolved when the block is rendered.

This is the same contract the prompt add-ons already have: the database stores **which**, code holds **what**.

> **Superseded:** the original framing — "Replace the fixed per-team order bodies with a library of small, named order fragments composed for the situation."
> **Reason:** composition alone does not fix the failure this plan exists to prevent. The original Proposed Changes composed at install time and wrote the composed prose into config (changes 3–5), which reproduces the freeze in a new shape: change a fragment body and nothing already installed moves. The plan says so itself, in its own risk list: *"Stale installed orders are the delivery problem, not the composition. Bodies live in DB config; changing the composer changes nothing already installed."* It then proposed recomposition triggers as the answer, and the trigger list — team wiring, pacing change, roster change, queue-mode change — does not include the case that actually occurs, which is that the code changed.
> **Replaced with:** compose at **delivery**, and persist fragment ids rather than fragment text. The axes, the fragment registry, and the applicability predicates are unchanged and remain the core of the work; only the moment of composition and the persisted shape move.

### Problem Analysis

Standing orders today are **monolithic bodies installed per team**, not composed per situation. Four constants, each a long paragraph, each installed wholesale:

| Constant | Installer | Scope |
|---|---|---|
| `AGENT_GROUP_CALLBACK_INSTRUCTION` (`teamWiring.ts:54`) | `wireSpawnedTeam` | team |
| `SEAT_QUEUE_DONE_ORDER_BODY` (`:154`) | `applySeatPacingOrders` | team + team-head |
| `TEAM_QUEUE_DONE_ORDER_BODY` (`:314`) | `applyTeamQueueOrders` | team + team-head |
| `GLOBAL_QUEUE_DONE_ORDER_BODY` (`:178`) | `installGlobalQueueDoneOrder` | global |

**Four failures follow.** Three from installing per team rather than per situation; the fourth from persisting the text at all.

1. **Contradiction.** `TEAM_QUEUE_DONE_ORDER_BODY` (`teamWiring.ts:343-354`) tells a seat to move a feature to `CODE REVIEWED` via `POST /kanban/dispatch`; the head body forbids exactly that without a reviewer seat. Both are installed on the head. Neither is conditioned on the team's shape.

   > **Superseded:** "The seat body tells any seat to move a feature to `CODE REVIEWED` on a board check."
   > **Reason:** `remove-the-seat-orders-code-reviewed-clause.md` shipped. `SEAT_QUEUE_DONE_ORDER_BODY` (`teamWiring.ts:160-168`) now says "Do not move cards".
   > **Replaced with:** the contradiction persists on `TEAM_QUEUE_DONE_ORDER_BODY`, not the seat body. Root cause unchanged.

2. **Wrong-source routing.** Diagnosed in `context-aware-completion-reporting.md`: *"orders 2 and 3 are installed per team, not per dispatch source. A team with seat pacing on gets order 2 for ALL completions, even work that came from the file-based queue."* Nothing of that plan shipped.

3. **Unconditional instructions that should be conditional.** The head order posts a report to `.switchboard/orchestrator/reports/` (`:769`, `:819`) whether or not an orchestrator is running. A report nobody reads is not a signal.

4. **Persisted prose goes stale silently, and no gate catches it.** *(New — this is the failure that motivated the revision.)*

#### Failure 4, observed 2026-08-28

A `Coding` team lead was delivered a standing order instructing it to `POST /kanban/dispatch` with `{"plan":"<the FEATURE planId>","targetColumn":"CODE REVIEWED"}` — an instruction removed from the codebase three days earlier. It obeyed. The measured chain:

- The team's group row (`terminals.agentGroups` → `group-coding-mswk2w8r`) was created **2026-08-17T01:29:20Z**, snapshotting `NEW_CODING_HEAD_PROMPT` as it stood that day into the group's `headPrompt` field.
- `NEW_CODING_HEAD_PROMPT` was then rewritten three times — 08-19 (`team-lead-role-boundaries-no-card-move-no-plan-rewrite.md`), 08-21 (`team-heads-must-not-move-cards.md`), 08-25 (`209cd7fc`, the one-release-signal work).
- Nothing re-reads the constant for an existing group. `migrateAgentGroups` (`teamWiring.ts:843-900`) neutralises an exact-value match on `OLD_SEEDED_AGENT_GROUP` and adds member-shape defaults. **It never touches `headPrompt`.**
- The 08-21 plan added `PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT` precisely to heal snapshots like this. `209cd7fc` rewrote the prompt again and deleted every `PRE_*` snapshot constant with it. `grep -rn PRE_CARD_MOVEMENT_RULE src/` returns nothing.
- On **2026-08-28T00:01:32.922Z**, `wireSpawnedTeam` minted a **brand-new** definition (`6dd79838`) and assignment (`4126e05a`) from the 08-17 group copy. The row is 27 minutes old; its text is 11 days old.
- `migrateCodingTeamOrders` could not have caught it regardless: its `team-head` recogniser is gated on `o.id.startsWith(TEAM_QUEUE_ORDER_ID_PREFIX)` (`:1955`), a prefix minted only by `applyTeamQueueOrders` (`:465-466`). `wireSpawnedTeam` mints plain UUIDs via `makeStandingOrder`. **That recogniser can never fire on a `wireSpawnedTeam`-written head order.**

Every gate was green. The code was correct, current, and compiled into the running build. Only the data was wrong.

#### Why the definitions library does not solve this

`standing-orders-library-definitions-and-sync.md` (CODE REVIEWED, 08-23) shipped a definitions library, and it is the right shape for operator reuse. It is the wrong shape for tracking a code default, by explicit design:

> "When a definition is edited, all assignments with that `definitionId` get their `instruction` field updated — **a sync operation, not a join at delivery time**. This keeps the delivery path (`selectOrders` / `renderOrder`) unchanged: it still reads `instruction` from the assignment row."

Two consequences:

- **The sync edge runs definition → assignment only.** There is no edge from a code constant to a definition. Nothing ever compares a definition against `NEW_CODING_HEAD_PROMPT`.
- **Definitions are identified by their text.** `ensureStandingOrderDefinition` (`standingOrders.ts:193`) dedupes with `defs.find(d => d.instruction === instruction)`, and `name` defaults to `instruction.slice(0, 60)`. Reword a body and you do not get a new version of the same definition — you get an unrelated one. `StandingOrderDefinition` is `{ id, name, instruction, createdAt }`: **no provenance field**, so a join at delivery would have nothing to join on.

And the library sits downstream of the freeze anyway: `wireSpawnedTeam` computes `headInstruction` from `opts.headPrompt` — the group snapshot — and *then* calls `ensureStandingOrderDefinition` on it (`:1620-1646`). The library made the copy shared. It did not make it live.

#### The contrast that names the fix

- **Add-ons store flags.** `resolveSeatPromptOptions` (`KanbanProvider.ts`) reads `noSubagentsByRole`, `gitCommitStrategyByRole`, `skipTestsByRole` — booleans and enums. The text is code constants (`NO_SUBAGENTS_DIRECTIVE`, `buildGitPolicyBlock`) assembled at delivery by `buildSeatDirectiveBlock`. Reword one and every seat has it on the next prompt, with no migration and no re-spawn.
- **Standing orders store prose.** Reword one and nothing existing ever sees it.

That single storage decision is the whole bug class. Machine-to-machine settings copies make it visible — they carry prompt text across a version boundary — but a long-lived team on one machine has the same problem.

### Root Cause

Each installer was added by the feature that needed it, and each wrote the full text its feature required, into the database. Nothing owned the whole set, so overlap accumulated as new paragraphs rather than shared fragments; and because the text is the stored value, every correction needs a recogniser to find the copies it must replace. The recogniser treadmill is the second-order cause: `209cd7fc` stepping off it is what produced failure 4.

## Metadata

**Complexity:** 7
**Tags:** backend, refactor, reliability

## User Review Required

None. The axes below are the design and are stated as decisions, not options.

## Complexity Audit

### Routine

- A fragment registry: named bodies with an applicability predicate.
- A composer taking `{ reviewerSeat, workKind, pacing, orchestratorPresent, attended }` and returning the ordered fragment set.
- Replacing the four installers with fragment-id writes.

### Complex / Risky

- **This changes text agents obey.** A composed set that omits a fragment silently removes an obligation — a seat that no longer reports completion presents as a hung queue, not an error. Every axis needs a case asserting the emitted set, not just that composition ran.
- **Delivery-time composition must not become a second scoping mechanism.** `selectOrders` already resolves membership from the registered group and uses `parent` on team-scoped rows to exclude the head from member delivery (`standingOrders.ts:374-377`). The composer consumes that resolution; it does not re-derive it.
- **The delivery path is on the hot loop.** Standing orders ride on every message carrying the block, including turn-end notifications. Composition must be pure, synchronous once its context is resolved, and free of DB reads that `selectOrders` has not already made.
- **The client mirrors the resolver.** `terminals.js:10353-10354` states the contract: *"Keep in sync with `src/services/standingOrders.ts` — the marker string is the contract"*, and `:10667` mirrors `applyStandingOrders`. Composition stays server-side; the client renders what it is given. Under this plan the client must render `instruction` when present and must never attempt to resolve a fragment id — a fragment-id row reaching an un-updated client would otherwise render blank.
- **Two hosts.** `loadEffectiveStandingOrders` is shared, but the installers are reached from three composition roots (`extension.ts`, `bootstrap.ts`, `agentGroupInstantiation.ts`). The registry and composer must live in the shared services layer with no `vscode` import.
- **Orchestrator presence is the one axis with no clean signal.** Reviewer seat comes from the roster, work kind from the card, pacing from the team's stored field. `orchestratorArmed` is a legacy key renamed to `missionControlArmed` (`autobanState.ts:394-395`); `orchestratorActive` does not exist. If `missionControlArmed` is not trustworthy liveness, drop the axis from v1 rather than composing on a guess.

## Edge-Case & Dependency Audit

**Mixed rows are the normal state, not a transitional one.** Operator-authored orders are literal text forever; system orders are fragment ids forever. `renderOrder` must handle both permanently, not as a migration window.

**Migration.** One-time, and small — see Migration below.

**Security.** Fragments contain endpoint paths and localhost ports, never credentials. The composer must not interpolate anything caller-supplied into a fragment beyond validated names (`validateInstruction`, `standingOrders.ts:363`). Fragment ids arriving over the API must be validated against the registry and rejected if unknown — an unknown id must never render as empty text.

**Side effects.** Emitted orders get shorter and more specific, changing prompt sizes on every message that carries the block.

**Ordering.** After the task-complete endpoint (a fragment names it) and after the Orders tab (so a composed set can be inspected).

## Dependencies

- **Requires** `add-a-task-complete-endpoint-for-the-lead.md` — the completion fragment calls that route.

  > **Superseded:** *"**Not yet implemented** — no `task/complete` endpoint exists in `src/`. This is a blocking dependency; plan 3 cannot be coded until it ships."*
  > **Reason:** verified against HEAD 2026-08-28. `POST /kanban/task/complete` exists and is live (`LocalApiServer.ts:1776`, `:1930`), `NEW_CODING_HEAD_PROMPT` already instructs the head to call it, and the atomic-team lifecycle work extended it to resolve and clear the accepted coding seat.
  > **Replaced with:** dependency satisfied. Not blocking.

- **Wants** `add-an-orders-tab-to-agent-control.md` first, for verification by eye. **Already shipped** (`kanban.html:2918`, `:3710`).
- **Supersedes** `context-aware-completion-reporting.md` (unbuilt — no `CONTEXT_AWARE_COMPLETION_ORDER_BODY` in `src/`). Mark it superseded rather than building it alongside.
- **Converges with** `standing-orders-library-definitions-and-sync.md` (shipped).

  > **Superseded:** *"this plan does not build on the `StandingOrderDefinition` model — its fragment registry is a separate, code-defined structure. If the two should converge … that is a design decision for the user."*
  > **Reason:** leaving them separate ships two libraries with the same name and different semantics, and leaves the shipped one storing prose — which is failure 4. The convergence is one optional field, not a redesign.
  > **Replaced with:** `StandingOrderDefinition` gains an optional `fragmentId`. A definition carrying one is a library view of a registry fragment and renders from code. An operator editing such a definition **forks it**: `fragmentId` is dropped and the edited text becomes a literal, which is the correct semantics — an operator who rewrote an order does not want it silently replaced on the next release. Operator-created definitions are unchanged.

- **Absorbs** `remove-the-seat-orders-code-reviewed-clause.md` — already shipped.

## Adversarial Synthesis

**"Composition is over-engineering — just fix the two bodies."** Fixing the bodies is what produced them: each was correct for its feature and wrong as a superset. There are four axes of real variation; encoding them as conditionals inside two strings is the same object with worse ergonomics.

**"Then just fix the storage — keep installing, but add a `builtinId` and a recogniser."** That is the treadmill. It requires a snapshot constant per body per release, and the record is that they get deleted: `209cd7fc` removed the entire `PRE_CARD_MOVEMENT_RULE_*` family four days after it was added, and no gate noticed. Delivery-time resolution needs no snapshots because nothing is stored to go stale.

**"Delivery-time composition risks a blank block if the context is unresolvable."** Real, and the reason the fallback is explicit: an unresolved axis takes the fragment's declared default, never omission. The "completion always present" invariant asserts this directly.

**"Agents can reason about a superset — they are language models."** They can, and the evidence in this repo is that they do not reliably: on 2026-08-28 a lead holding both a "never move a card" rule and a "POST /kanban/dispatch to CODE REVIEWED" instruction acted on the second. Removing the choice is more reliable than expecting it to be made well.

**"Fragments will drift out of sync with each other."** A real risk, and the reason the Orders tab is a soft prerequisite: the composed set becomes readable. Drift you can see beats a monolith you cannot.

## Proposed Changes

1. **Fragment registry** — code-owned, host-agnostic: `{ id, body(ctx) => string, applies(ctx) => boolean, order }`, one entry per obligation (report completion, advance a feature, request the next item, commit, post an orchestrator report).
2. **`StandingOrder` gains `fragments?: string[]`.** `instruction` stays and remains authoritative when present. A row carries one or the other, never both.
3. **`renderOrder` resolves fragments at delivery** against the registry, using the context `selectOrders` has already resolved. A row with `instruction` renders verbatim, exactly as today.
4. **The four installers write fragment ids, never prose.** `wireSpawnedTeam` stops copying `group.headPrompt` into an order; `applySeatPacingOrders`, `applyTeamQueueOrders` and `installGlobalQueueDoneOrder` follow.
5. **`StandingOrderDefinition` gains `fragmentId?`.** Definitions carrying it render from the registry; an operator edit forks to a literal.
6. **Delete the recomposition-trigger concept.** There is nothing to recompose. Roster changes, pacing flips and queue-mode changes take effect on the next delivery because the context is read then.
7. **Group templates stop carrying `headPrompt` text.** A group with no `headPrompt` means "use the current default"; a group with one is an operator override and is honoured verbatim. This closes failure 4 at its source.
8. **Make the orchestrator-report fragment conditional** on orchestrator presence.
9. **Mark `context-aware-completion-reporting.md` superseded.**

## Migration

One-time. **Discriminate on scope, never on text.** Every `team` and `team-head` scoped row is system-written by construction — `wireSpawnedTeam`, `applySeatPacingOrders` and `applyTeamQueueOrders` are its only authors — so it is replaced with the equivalent `fragments` list **regardless of what text it currently holds**. Every other scope (`global`, `pair`, `role`) is preserved verbatim.

Text-matching is explicitly rejected as the discrimination rule, and this is the plan's most important migration decision:

> **Superseded:** an earlier draft of this section — "Recognise the four known monolithic bodies (and the current `NEW_CODING_HEAD_PROMPT` / `NEW_REVIEW_TEAM_HEAD_PROMPT`) by exact text match … leave every unrecognised row untouched as a literal. A row that is not recognised is an operator's, by definition."
> **Reason:** that premise is false, and it strands exactly the rows this plan exists to rescue. A **first-generation** system row is neither one of the four bodies nor the current head prompt — it is old system text — so "unrecognised ⇒ operator's" misclassifies it as a literal and freezes it permanently. The concrete case: a Review-team head still carrying `"Do NOT fix code yourself — send fix instructions to your coder at {coder}"` long after the ≤100-line self-fix threshold replaced it, round-tripping every one-line typo through its coder. That case was previously its own subtask of this feature (*Review-Team Head Orders: Supersede The First-Generation Text*, deleted 2026-08-28 — see the feature file for why); this section is where its requirement now lives. Text-matching also reintroduces the snapshot treadmill — a frozen constant per generation per team — which is what `209cd7fc` deliberately dismantled and what `team-scoped-role-routing.test.js:961-969` now pins shut (*"prompt text is never rewritten — deleting the snapshots was the point"*).
> **Replaced with:** scope-based provenance. No snapshot constants are added, no generation needs to be recognised, and an order frozen at *any* past generation converts on the first read. It also composes with the contract test rather than fighting it: `migrateAgentGroups` still never rewrites prompt text — the group's `headPrompt` is dropped (Proposed Change 7), not migrated.

**Cost of the scope rule:** an operator who hand-edited a team-head order through the Orders tab loses that edit, once. That is acceptable and is the correct trade — teams have never shipped, so the only affected rows are on development machines, and the repo's rule for unreleased state is a clean break. Operators who want a durable custom head order get the supported path instead: a forked definition (Proposed Change 5), which carries no `fragmentId` and is never touched again.

> **Superseded:** *"This is a behaviour change to ~4,000 installs, delivered as text agents obey."*
> **Reason:** three of the four installers are team installers, and the teams feature has never shipped to users. The install-base framing carried most of this plan's risk weight and does not apply to them. `installGlobalQueueDoneOrder` is the one to check individually.
> **Replaced with:** treat the team installers as unreleased state — clean break, no compat shim. Confirm `GLOBAL_QUEUE_DONE_ORDER_BODY`'s release status before touching it, and migrate that one if it shipped.

## Verification Plan

### Goal Invariants

- Every emitted set is the composition of fragments applicable to that team's actual shape, **at the moment of delivery**.
- Changing a fragment body constant changes what an already-wired team is told, on its next message, with no migration and no re-spawn.
- No emitted set contains an instruction contradicting another in the same set.
- A team with no reviewer seat is never told to move a card to `CODE REVIEWED`.
- A team with no orchestrator is never told to post an orchestrator report.
- Every seat retains exactly one completion obligation under every combination.
- An operator-authored order is never altered by a code change.

### Automated Tests

- **The staleness regression — this plan's core test.** Wire a team, snapshot its delivered block, change a fragment body constant, re-render with no migration, no re-spawn and no config write, and assert the delivered block carries the new text. This is the assertion whose absence produced failure 4; it fails against today's code and must pass after.
- **Axis matrix:** assert the emitted set for each combination of the axes. A missing fragment is a silently removed obligation, and only a per-combination assertion catches it.
- **No contradictions:** for every combination, assert no two fragments instruct conflicting card movement.
- **Completion always present:** every combination yields exactly one completion obligation — never zero (hung queue), never two (double-reporting).
- **Operator literal untouched:** a row with `instruction` and no `fragments` renders byte-identically before and after a registry change.
- **Definition fork:** editing a `fragmentId`-backed definition drops `fragmentId` and pins the text; a later registry change does not move it.
- **Unknown fragment id:** a row naming an id absent from the registry is reported, and never renders as empty text.
- **No prose written:** after wiring a team, assert no standing-order row and no definition contains any registry fragment's body text.
- **Old-generation rows convert:** seed a `team-head` row holding first-generation text that matches no current constant (e.g. `"Do NOT fix code yourself — send fix instructions to your coder at {coder}"`), migrate, and assert it becomes fragment ids and renders current text. Pins that the scope rule, not text-matching, is what discriminates — and that no generation of stale order can survive by being unrecognised.
- **Non-team scopes preserved:** `global`, `pair` and `role` rows are byte-identical before and after migration.
- **Group template carries no prompt:** after wiring, assert the group row has no `headPrompt`, and that a group *with* one is still honoured verbatim.
- **Client compatibility:** assert `terminals.js` renders `instruction` rows and does not attempt fragment resolution.
- **Server-side only:** assert no composition logic exists client-side, pinning the constraint `terminals.js:10353` already states.
- **Emitted size:** record emitted text length per combination, so the prompt-size effect is measured rather than assumed.

### Manual

Wire a Coding team with no reviewer seat. Confirm its head is never told to hand anything to review. Add a reviewer seat, send the head one message, and confirm the advance-to-review fragment appears without re-spawning the team.

## Outstanding Questions

- Is there a reliable orchestrator-liveness signal? The current key is `missionControlArmed` (or `missionControlSeat` for the seat assignment); `orchestratorArmed` is legacy and `orchestratorActive` does not exist. If `missionControlArmed` is not trustworthy liveness, drop that axis from v1.
- Does any fragment need to vary by role beyond head/member? The `role` scope exists in `StandingOrderScope` (`standingOrders.ts:3`) and is unused by these installers.
