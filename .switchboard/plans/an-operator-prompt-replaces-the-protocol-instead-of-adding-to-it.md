# An Operator's Team Prompt Replaces the Protocol Instead of Adding to It

## Goal

An operator can add text to what a team's seats are told. An operator can never remove,
replace, or stale the orders that make a team function. System orders are composed from
code at delivery, never persisted, and always present; `terminals.standingOrders` holds
only what a human authored.

### Problem analysis

**Measured on this host, 2026-09-13, against the live board DB.** Six rows at
`terminals.standingOrders`, every one carrying an `instruction` body and a `definitionId`:

| id | scope | teamId | names `api-server-port.txt` |
| :--- | :--- | :--- | :--- |
| `66935310…` | `team` | `team_Coding` | yes |
| `4126e05a…` | `team-head` | `team_Coding` | yes |
| `4476af31…` | `team` | `team_Feature_20Implementation` | yes |
| `context-aware-completion:…` | `team-head` | `team_Coding` | yes |
| `context-aware-completion:…` | `team` | `team_lead_1` | no |
| `composed-head:team_lead_1` | `team-head` | `team_lead_1` | yes |

Two of the three teams no longer exist. The live team, `team_Coding`, has **no
`context-aware-completion` member row at all** — the completion protocol shipped by
*Context-Aware Completion Reporting for Teams* was never installed on it. Five of six rows
instruct an agent to reach the API "against the port in `.switchboard/api-server-port.txt`",
a bare relative path with no scheme and no host, which `team-state-endpoint-access-contract`
forbids reaching an agent at all.

**Why the live team has no protocol.** `teamWiring.ts:1837`:

```ts
const teamOrder = teamPromptInstruction
    ? makeStandingOrder(headName, '', teamPromptInstruction, 'team', groupId)
    : makeFragmentStandingOrder(headName, '', teamFragments, 'team', groupId);
```

and identically for the head at `:1864`. A team definition carrying a `prompt` gets the
operator's body **instead of** `team.member.completion`, `team.member.work`,
`team.external-member.callback`, `team.git-safety` and `seat.subagent-policy`. Not
appended — replaced. Filling in the prompt box in the team gallery silently uninstalls the
protocol for that team, and nothing reports it.

The same substitution happens again at render. `standingOrders.ts:530`:

```ts
export function resolveStandingOrderInstruction(o, ctx) {
    if (typeof o.instruction === 'string') { return o.instruction; }
    if (!Array.isArray(o.fragments) || o.fragments.length === 0) { return ''; }
    return composeStandingOrderFragments(o.fragments, ctx).text;
}
```

A body short-circuits the fragments. So even a row carrying both would deliver only the body.

**The evidence the loss was noticed and worked around.** `66935310`'s body contains the
git-safety rule as prose — a hand-pasted copy of `GIT_SAFETY_DIRECTIVE`. Someone hit the
missing protocol and patched it by retyping it into the definition. That copy is now
frozen text on disk that no code change can reach.

**Why frozen text cannot be repaired in place.** The library (`standing-orders-library-definitions-and-sync.md`)
made the definition the top of the chain:

```
code constant ──once, at creation──▶ definition ──re-synced every read──▶ assignment ──▶ agent
              ▲ never repeated
```

`reSyncAssignmentsFromDefinitions` (`teamWiring.ts:2447`, the lazy wrapper over
`reSyncAssignmentsToDefinitions`) keeps assignments equal to their definition on every read.
Nothing syncs a definition from the source constant, so a definition minted on 2026-08-28
outranks `src/` forever. The plan chose the denormalized copy over a join at delivery for
one stated reason: *"Old builds that don't know about `definitionId` see the `instruction`
copy and work as before."* That is backward compatibility for a feature that has never
shipped to a user.

**The apparatus built to compensate.** `migrateCodingTeamOrders` (`teamWiring.ts:2112`),
`PRE_REWRITE_CALLBACK_INSTRUCTION` (`:114`), `CONTEXT_AWARE_COMPLETION_ORDER_VERSION`
(`:393`), `describeStandingOrderMigrations` (`:2293`), `reconcileSystemFragmentRows`
(`:471`), and the hand-maintained client mirror `migrateCodingTeamOrdersClient`
(`terminals.js:11725`). None of it solves a user problem. All of it keeps a cache coherent
with a function that was always cheaper to call.

> **Superseded:** the apparatus list previously named `OLD_HEADPROMPT_V2_FRAGMENT` (`:611`) as a member of this set.
> **Reason:** `OLD_HEADPROMPT_V2_FRAGMENT` no longer exists in `src/` — it was deleted in a prior session (recorded in `memo-team-wiring-carries-frozen-strings-silent-fallbacks-and-unaddressable-teams.md`, "Resolved (user, this session): change 2 — delete `OLD_HEADPROMPT_V2_FRAGMENT`"). `grep -rn OLD_HEADPROMPT_V2_FRAGMENT src/` returns nothing. Citing it as a live compensating artifact is a stale reference a coder would waste time hunting.
> **Replaced with:** the five live artifacts above (`migrateCodingTeamOrders`, `PRE_REWRITE_CALLBACK_INSTRUCTION`, `CONTEXT_AWARE_COMPLETION_ORDER_VERSION`, `describeStandingOrderMigrations`, `reconcileSystemFragmentRows`) plus the client mirror. `OLD_HEADPROMPT_V2_FRAGMENT` is removed from both the apparatus list here and the deletion list in change 4 — there is nothing to delete.

`migrateSystemOrdersToFragments` (`:2211`) would convert these rows to fragments and end
the problem. It has **zero call sites**, and `teamWiring.ts:460` records why:

> *"It rewrites ANY team-scoped row to the canonical member list and strips `instruction`,
> which would destroy an operator-authored team prompt (`teamPromptInstruction` from a team
> definition is stored exactly that way)."*

System-authored text and operator-authored text are the same field on the same row, so the
one transform that would fix this cannot be run.

**Nothing prunes.** There is no `releaseTeam`/`stopTeam`/`disbandTeam` in `src/`. The only
removal path for any order is `removeReviewerCallbackOrder`, one narrow pair row.
`agentGroupInstantiation.ts:138` says it plainly: *"nothing ever pruned orders."*

### Root cause

Derived state was persisted. A team's system orders are a pure function of code plus the
team's shape — recomputable at delivery, worth nothing in storage. Storing them created a
cache that can disagree with its source, and every layer above exists to close that gap.
Storing them in the same field as operator text then made the gap unclosable, because
nothing can rewrite one without risking the other. And giving the operator's text the same
slot made it a replacement rather than an addition, so the protocol became optional.

### Non-goals

- **Another recogniser, stamp, or migration.** Teams have never shipped to a user. The
  persisted rows are dropped, not converted. Adding a seventh way to recognise stale text
  is the failure this plan ends.
- **Removing the library.** Definitions remain the shared store for authored text, which is
  what they are good at. Only system orders leave the store.
- **Changing any fragment's wording.** `standingOrderFragments.ts` bodies are out of scope;
  this plan changes how they reach a seat, not what they say.
- **A UI for the change.** No banner, no notice, no migration report.

## Metadata

- **Complexity:** 7
- **Tags:** backend, refactor, reliability

## User Review Required

None.

## Complexity Audit

### Routine

- Deleting dead/duplicate constants and their contract pins once the runtime callers are gone.
- Removing the `instruction`-short-circuit in `resolveStandingOrderInstruction` and appending the body after composed fragments.
- Dropping the six persisted system rows (clean break — teams never shipped).
- Removing the `reconcileSystemFragmentRows` call sites (no system fragment rows remain).

### Complex / Risky

- **Rewriting `resolveTeamStanding` to source team membership from `groups` (gated by `isSpawnedTeamGroup`) instead of from `team`/`team-head` order rows.** Change 1 emits synthetic system orders keyed on `standing.inTeam`/`standing.isHead`; today `resolveTeamStanding` (`standingOrders.ts:286`) derives those from the very rows change 3 deletes. Without this rewrite the whole feature is a no-op (see Adversarial Synthesis). This is the load-bearing step and the one most likely to be missed.
- **The `isSpawnedTeamGroup` discriminator.** A naive "membership from `groups`" rewrite would treat Link-up pair groups as teams and deliver team protocol to non-team seats — a quiet wrong answer. `isSpawnedTeamGroup` (`teamWiring.ts:1212`) already encodes the team/non-team split; the rewrite must use it.
- **Contract-test fallout is wider than the original deletion list.** `PRE_REWRITE_CALLBACK_INSTRUCTION`, `NEW_CODING_HEAD_PROMPT`, `NEW_CODING_HEAD_PROMPT_CLIENT`, `AGENT_GROUP_CALLBACK_INSTRUCTION`, and `EXTERNAL_HEAD_CALLBACK_INSTRUCTION` are pinned — for existence AND for byte-identity/content — by at least seven contract suites. Deleting the constants breaks the pins; the tests must be rewritten, not merely re-run.
- **Both-hosts parity of the composition context.** `selectOrders`/`renderStandaloneOrdersBlock` consume `subagentPolicy`, `customSubagentName`, `hasRegisteredRounds` threaded from each root; a root that drops one silently composes a different block, and a `Promise<void>` seam makes "never wired" and "working" the same value.

## Edge-Case & Dependency Audit

- **Race Conditions:** `wireSpawnedTeam`'s standing-order install is already serialised through `mutateStandingOrders`' module chain. Change 3 removes the team/team-head writes from that mutator; the pair-row writes remain in the same mutator call (do not split into a second `mutateStandingOrders` — that reopens the read-modify-write window the existing comment at `teamWiring.ts:1857` warns of). `selectOrders` is a pure synchronous function called per delivery; composing synthetic orders inside it adds no async and no shared state.
- **Security:** No new credentials, endpoints, or auth surfaces. The `api-server-port.txt` bare-path rows are deleted, not preserved — the regression guard (Goal Invariants) asserts they are gone from the persisted store.
- **Side Effects:** Deleting the six persisted rows is irreversible for those rows. Teams have never shipped, so no external install depends on them. Operator-authored definitions in the library are untouched. The webview `applyStandingOrdersClient` (`terminals.js:11760`) renders persisted `instruction` rows for the operator-facing panel; after the rows are gone it renders nothing for teams — correct, because system orders were never operator-visible content. Verify no webview path independently composes/delivers an order body to an agent (the host owns delivery).
- **Dependencies & Conflicts:**
  - `resolveTeamStanding` is consumed by `selectOrders` (`standingOrders.ts:430`), `resolveHasRegisteredRoundsForSeat` (`:390`), `compositionContext` (via `standing.teamId`), and by both composition roots (`TaskViewerProvider.ts:1271`, `bootstrap.ts:594`) for the seat-block gate. The rewrite must preserve its return shape (`{ inTeam, isHead, teamId?, headName?, members }`) so all four consumers keep working.
  - `seat-safeguards-fleet-prompt-path.test.js:1364` asserts `selectOrders`' source text contains `resolveTeamStanding(` — the rewrite keeps that call, so the pin stays green.
  - `link-presets-mirror-contract.test.js` asserts the reports-to-head template is byte-identical to `AGENT_GROUP_CALLBACK_INSTRUCTION`. If `AGENT_GROUP_CALLBACK_INSTRUCTION` is deleted, that pin must move to the fragment body (or the constant is retained as the single source the fragment references).

## Dependencies

- `sess_prior_team_wiring` — the `wireSpawnedTeam` / `migrateCodingTeamOrders` / context-aware-completion lineage (the apparatus this plan deletes).
- `sess_standing_orders_library` — `standing-orders-library-definitions-and-sync.md`; definitions remain the store for authored text.

## Adversarial Synthesis

**Risk summary.** The dominant risk is the missing `resolveTeamStanding` rewrite: change 1 keys synthetic system-order emission on `standing.inTeam`, but `resolveTeamStanding` today derives that flag from the `team`/`team-head` order rows that change 3 deletes, so without an explicit rewrite the feature is a silent no-op — every team loses its protocol while the contract test can be written to pass against a mocked standing. Second is the `isSpawnedTeamGroup` gate: a naive group-membership rewrite delivers team fragments to Link-up pairs. Third is the contract-test fallout: at least seven suites pin the constants being deleted (for existence, byte-identity, and content), and the original plan both under-enumerates them and frames some as "regression: must still pass" when they must in fact be rewritten. Mitigations: make the `resolveTeamStanding` rewrite an explicit change with its own invariant; gate the rewrite on `isSpawnedTeamGroup`; enumerate every affected contract suite and split "rewrite" from "still-passes" in the Verification Plan.

## Proposed Changes

### 1. System orders compose at delivery and are never persisted

`selectOrders` (`standingOrders.ts:420`) gains the system orders itself: for any seat whose
`standing.inTeam` resolves, emit a synthetic order built from the canonical member list
(`team.member.completion`, `team.member.work`, `team.external-member.callback`,
`team.git-safety`, `seat.subagent-policy`), or the head list for `standing.isHead`. Built
per delivery from `STANDING_ORDER_FRAGMENT_IDS` and the live composition context, with no
row on disk and no `teamId` lookup — a team has its protocol because it is a team, not
because a row was once written for its head's name.

The synthetic `team` order carries `parent = headName` (preserving the existing head-exclusion
check at `:452`) and `teamId = group.id`; the synthetic `team-head` order carries
`parent = headName` (targeting the head at `:466`) and `teamId = group.id`. Both flow through
the existing `renderOrder`/`resolveStandingOrderInstruction` path unchanged.

A code edit to a fragment is then live on the next prompt for every team, including teams
started months ago.

> **Clarification (strictly implied by change 1, called out because it is the load-bearing step):** `resolveTeamStanding` (`standingOrders.ts:286`) MUST be rewritten in the same change. Today it derives `inTeam`/`isHead`/`teamId`/`headName`/`members` by iterating the persisted `team` and `team-head` order rows (`:302-345`). Change 3 deletes those rows, so the unrewritten resolver returns `inTeam: false` for every seat and change 1's synthetic emission never fires — the protocol is silently lost. The rewrite sources team identity from `groups` instead: find the group whose `members` includes `targetName` AND for which `isSpawnedTeamGroup(group)` (`teamWiring.ts:1212`) is true; `isHead = group.head === targetName` (fall back to `group.name`); `teamId = group.id`; `headName = group.head || group.name`; `members = group.members`. The `isSpawnedTeamGroup` gate is mandatory — without it, Link-up pair groups (non-team groups in `terminals.groups`) qualify as teams and receive team protocol fragments, the codebase's named fallback failure mode. The return shape is unchanged so `selectOrders` (`:430`), `resolveHasRegisteredRoundsForSeat` (`:390`), `compositionContext`, and both roots' seat-block gates keep working. `resolveTeamStanding`'s `orders` parameter becomes unused for team resolution but is retained in the signature to avoid a wide call-site change (or removed in the same diff if the call sites are updated together — implementer's choice, but the audit is the call sites, not the parameter).

### 2. A body adds to the fragments; it never replaces them

Delete the short-circuit at `standingOrders.ts:530`. `resolveStandingOrderInstruction`
composes fragments when present and appends `instruction` after them. A row carrying only a
body renders only that body — which is correct, because after change 1 the system half no
longer lives on rows at all.

### 3. `wireSpawnedTeam` writes only what the operator authored

Delete both ternaries (`teamWiring.ts:1837`, `:1864`). When a team definition carries a
`prompt` or `headPrompt`, persist it as an ordinary authored row. When it does not, persist
nothing. The `teamExists` / head-exists checks on `(scope, teamId)` go with them: no system
row occupies a slot, so "this head name was wired before" stops deciding what a team is
told. `reconcileSystemFragmentRows` is deleted — there are no system fragment rows left to
reconcile. The `CONTEXT_AWARE_COMPLETION_ORDER_VERSION` stamp and the `version` field go
with the ternaries (no system row is minted to stamp).

### 4. Delete the staleness apparatus (and its contract pins)

Remove `migrateCodingTeamOrders` (`teamWiring.ts:2112`), `PRE_REWRITE_CALLBACK_INSTRUCTION`
(`:114`), `CONTEXT_AWARE_COMPLETION_ORDER_VERSION` (`:393`) and the `version` field,
`describeStandingOrderMigrations` (`:2293`), `migrateSystemOrdersToFragments` (`:2211`),
`reconcileSystemFragmentRows` (`:471`), and the client mirror `migrateCodingTeamOrdersClient`
(`terminals.js:11725`) with its `PRE_REWRITE_CALLBACK_INSTRUCTION` (`terminals.js:11566`) and
`NEW_CODING_HEAD_PROMPT_CLIENT` (`terminals.js:11595`) constants.

> **Superseded:** the original deletion list named `OLD_HEADPROMPT_V2_FRAGMENT` (`:611`) for removal.
> **Reason:** that constant is already gone from `src/` (deleted in a prior session; `grep -rn OLD_HEADPROMPT_V2_FRAGMENT src/` returns nothing). There is nothing to delete.
> **Replaced with:** no action for `OLD_HEADPROMPT_V2_FRAGMENT`; the deletion list is the live constants above.

**Constant-survival audit (the part the original list left implicit).** `AGENT_GROUP_CALLBACK_INSTRUCTION` (`teamWiring.ts:73`) and `EXTERNAL_HEAD_CALLBACK_INSTRUCTION` (`:83`) survive only if a live runtime caller remains after change 3:

- `AGENT_GROUP_CALLBACK_INSTRUCTION` — after `migrateCodingTeamOrders` is deleted, its only runtime reference is the re-export at `agentGroupInstantiation.ts:11` (`export { AGENT_GROUP_CALLBACK_INSTRUCTION }`), which no file imports from that module (the three importers pull only `instantiateAgentGroupCore`/`instantiateExternalHeadedTeam`/`resolveExternalTeamTemplate`). So the re-export is dead and goes with the constant. The `link-presets-mirror-contract.test.js` reports-to-head template is byte-identical to this constant — if the constant goes, either retain the template as the single source or keep the constant and have the fragment reference it; the pin must move either way.
- `EXTERNAL_HEAD_CALLBACK_INSTRUCTION` — the `externalMemberCallback` fragment body (`standingOrderFragments.ts:217`) is a hardcoded copy byte-identical to this constant but does NOT reference it. After change 3 deletes the external-head team-prompt install path, the constant has no runtime caller. It goes, and the fragment's hardcoded body becomes the single source (or the fragment is changed to reference the retained constant — implementer's choice, but one source, not two).

**Contract-test pins that MUST be updated or removed in this same diff (deleting the constants breaks them):**

| Suite (`test:contract:`) | Pins affected |
| :--- | :--- |
| `standing-orders-marker` | `PRE_REWRITE_CALLBACK_INSTRUCTION` exists in teamWiring.ts + terminals.js (`:231-236`); `AGENT_GROUP_CALLBACK_INSTRUCTION` exists + no shipped team prompt opens with it verbatim (`:310-339`); `NEW_CODING_HEAD_PROMPT` exists + load-bearing literals (`:444-510`); external-headed-team persisted row contains `EXTERNAL_HEAD_CALLBACK_INSTRUCTION` (`:1372-1384`) — this assertion must flip from "persisted row contains" to "delivered block contains the fragment". |
| `stage-marker-commit` | `NEW_CODING_HEAD_PROMPT_CLIENT` byte-identical to `NEW_CODING_HEAD_PROMPT` (`:357-358`); `PRE_REWRITE_CALLBACK_INSTRUCTION` exported (`:601-603`); `AGENT_GROUP_CALLBACK_INSTRUCTION` imported. |
| `coding-head-prompt` | `NEW_CODING_HEAD_PROMPT` (teamWiring.ts) and `NEW_CODING_HEAD_PROMPT_CLIENT` (terminals.js) byte-identical (`:62-88`). If the client mirror is deleted, this byte-identity pin must go with it; decide whether `NEW_CODING_HEAD_PROMPT` (the host constant, used only as the kanban.html template default's parity reference) stays or goes. |
| `team-state-endpoint-access` | `NEW_CODING_HEAD_PROMPT` content (`:146-149`); `PRE_REWRITE_CALLBACK_INSTRUCTION` declared in teamWiring.ts (`:164`). |
| `link-presets-mirror` | reports-to-head template byte-identical to `AGENT_GROUP_CALLBACK_INSTRUCTION` (`:148-168`). |
| `external-headed-team` | `EXTERNAL_HEAD_CALLBACK_INSTRUCTION` must not mention `ptySendPrompt` (`:372`). |
| `completion-asserted-never-inferred` | `NEW_CODING_HEAD_PROMPT` content (`:198-201`, `:415`). |

`loadEffectiveStandingOrders` keeps `migrateTeamPairOrders` (pair rows are operator-visible
Link-up state) and `reSyncAssignmentsFromDefinitions` (authored text still tracks its
definition). The `migrateCodingTeamOrders(migrateTeamPairOrders(raw))` call at
`teamWiring.ts:2480` drops its `migrateCodingTeamOrders` wrapper.

### 5. Drop the persisted system rows

One-time delete of the six rows measured above, and of the `standingOrderDefinitions`
entries they reference that were system-authored. Teams have never shipped, so this is a
clean break with no migration and no archival. Operator-authored definitions in the library
are untouched.

### 6. A team's seats cannot be left without the protocol

The operator-facing team editor keeps its prompt box. Its text is additive by construction
after changes 1–3, so there is no suppression path to guard and no setting to add. Assert
it instead: a contract test starts a team whose definition carries a `prompt` and checks
every required fragment is still in the delivered block.

## Verification Plan

> **Note:** Per the dispatching directive for this run, compilation and automated tests are NOT executed here. The checks below remain written down; they are the gate for the implementing coder.

### Automated Tests

1. **New** `src/test/standing-orders-additive-contract.test.js`, wired as
   `test:contract:standing-orders-additive` **and invoked from
   `.github/workflows/integration-tests.yml`** — defined-but-not-invoked is not a gate.
   Asserts: a team started with a definition `prompt` delivers every required member
   fragment **and** the operator text; the operator text appears after the fragments; no
   `scope: 'team'` or `'team-head'` row is persisted for a team with no authored prompt.
2. A fragment-body edit in `standingOrderFragments.ts` changes the block delivered to a
   team whose rows were written before the edit — the regression that motivates change 1.
   Fixture: a persisted authored row plus a pre-existing `teamId`, asserting the composed
   output tracks the constant.
3. Assert the persisted store contains **no** system-authored rows after a team start: the
   only rows with `scope` `team`/`team-head` carry an `instruction` and no `fragments`.
4. **Rewrite (these suites pin deleted constants and WILL break — update them in this diff, do not merely re-run):**
   `test:contract:standing-orders-marker`, `test:contract:stage-marker-commit`,
   `test:contract:coding-head-prompt`, `test:contract:team-state-endpoint-access`,
   `test:contract:link-presets-mirror`, `test:contract:external-headed-team`,
   `test:contract:completion-asserted-never-inferred`. See the table in change 4 for the
   specific pins.
5. **Regression (must still pass unchanged):** `test:contract:standing-orders-definitions`,
   `test:contract:team-wiring-roster-seats`, `test:contract:team-scoped-routing`,
   `test:contract:terminal-groups-headrole`, `test:contract:seat-safeguards` (the
   `selectOrders` calls `resolveTeamStanding` source-text pin at
   `seat-safeguards-fleet-prompt-path.test.js:1364` must stay green after the rewrite).
6. Extend `team-state-endpoint-access-contract.test.js` to assert against the **persisted
   store**, not only the constants. Its current grep gate passed at HEAD while five of six
   live rows named `api-server-port.txt`.

### Both composition roots

`teamWiring.ts` and `standingOrders.ts` are shared services, so changes 1–5 reach both
roots through the service. The audit is the wiring, not the verbs: confirm
`src/standalone/bootstrap.ts` and `src/extension.ts` each still resolve the same
composition context into `selectOrders`/`renderStandaloneOrdersBlock`. The load-bearing
options are `subagentPolicy`, `customSubagentName`, and `hasRegisteredRounds` — these are
threaded from each root (`bootstrap.ts:671-674`, `extension.ts` via
`TaskViewerProvider.ts:1385-1388` and `:2913-2916`) and a root that drops one silently
composes a different block. `pacing`, `externalHead`, `headRole`, and `members` are derived
inside `compositionContext` from `groups`/`roleMap` (not from root options), so they do not
diverge by omission. `orchestratorPresent` and `attended` are default-derived
(`orchestratorPresent: options.orchestratorPresent === true` → false; `attended: options.attended !== false` → true) — neither root wires them today, so they are NOT a
divergence risk; do not treat them as root-wired in the audit. The client mirror in
`src/webview/terminals.js` is deleted by change 4; verify no remaining webview path
renders an order body of its own (the host owns delivery; the client panel only displays
persisted operator rows).

### Goal Invariants

- Filling in a team definition's prompt box **adds** to what seats are told. There is no
  input to that box that removes a required fragment.
- Editing a fragment body in `src/` changes what an already-started team is told, on the
  next prompt, with no migration and no restart.
- No standing-order row on disk carries system-authored text. Every persisted row is
  something a human wrote.
- A team that no longer exists leaves nothing behind that can reach a live agent.
- `grep -rn "api-server-port.txt" src/` matches only comments, and the persisted store
  matches nothing.
- **Negative (paired):** `resolveTeamStanding` no longer reads `team`/`team-head` order rows
  for membership (absent *here*); team membership is resolvable from `groups` filtered by
  `isSpawnedTeamGroup` (resolvable *there*). A deletion of the rows without the resolver
  rewrite passes the "no system rows" invariant while the real goal — protocol delivered —
  is unmet; the paired positive catches that.

## Outstanding Questions

- **[user]** `NEW_CODING_HEAD_PROMPT` (`teamWiring.ts:791`) is the host constant byte-identical to the Coding template's default `headPrompt` in `kanban.html`; it is not used at runtime by `wireSpawnedTeam` (the template ships the text inline, not via the constant) and exists only as the parity reference for `coding-head-prompt-contract` and `stage-marker-commit`. — proceeding on the assumption that the constant stays (it is the template default's canonical source) and only the client mirror `NEW_CODING_HEAD_PROMPT_CLIENT` goes; confirm before the coder deletes the client mirror and updates the byte-identity pins accordingly.
- **[user]** `AGENT_GROUP_CALLBACK_INSTRUCTION` and `EXTERNAL_HEAD_CALLBACK_INSTRUCTION`: delete (no live runtime caller after change 4) and let the fragment/template bodies be the single source, OR retain one as the canonical source the fragment references. — proceeding on the assumption that both constants are deleted and the fragment bodies (`standingOrderFragments.ts:217` and the link-presets reports-to-head template) become the single source, with the contract pins moved onto those bodies; confirm if you prefer the constants retained as the single source.

## Implementation Summary

System standing orders are now composed at delivery time from the fragment library (`standingOrderFragments.ts`) via synthetic orders emitted in `selectOrders`, and `wireSpawnedTeam` persists only operator-authored rows — a team with no prompt writes no system row, and a team with a prompt writes only the operator text. `resolveStandingOrderInstruction` composes fragments first and appends the operator instruction after them, so filling in a team's prompt box adds to the protocol rather than replacing it. `resolveTeamStanding` was rewritten to source team membership from `terminals.groups` (gated by an inlined `isSpawnedTeamGroup` predicate) instead of from persisted order rows, and `loadEffectiveStandingOrders` now drops stale system-authored rows via `dropSystemAuthoredRows`. The staleness apparatus (`migrateCodingTeamOrders`, `describeStandingOrderMigrations`, `reconcileSystemFragmentRows`, `PRE_REWRITE_CALLBACK_INSTRUCTION`, `AGENT_GROUP_CALLBACK_INSTRUCTION`, `EXTERNAL_HEAD_CALLBACK_INSTRUCTION`, the client mirrors, and the `version` stamp) was deleted, and seven contract suites were rewritten to pin the new behavior; a new `standing-orders-additive-contract` suite was added and wired into npm and the integration workflow.
