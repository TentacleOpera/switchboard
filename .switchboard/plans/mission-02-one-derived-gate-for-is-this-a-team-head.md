# Mission 02 — One Derived Gate for "Is This a Team Head"

Subtask of the feature **Every Batch Move Becomes One Declared Thing — a Mission or a Fan-Out Pipeline** (`8ecfdaee`). The feature file carries the full argument and the constraints binding every subtask. This plan is self-sufficient on its own scope and, where the two disagree, **this plan wins** — it is the source of truth for the seat implementing it.

## Goal

`isCodingTeamHead` answers for any role that heads a team, and no call site
passes a literal `'lead'`.

## Problem

`KanbanProvider.isCodingTeamHead` opens with `if (role !== 'lead') return false;`
and its caller at `:7003` hard-codes `'lead'`. So a `coder`-headed Coding team
and a `reviewer`-headed Review team are not "team heads", and the batch branch
at `:7588` never fires for them.

This is the **third** instance of the same assumption. Commit `7a78665b` fixed
the pair-dispatch call sites by deriving the set with
`pairDispatchingHeadRoles()`; this one and the batch branch remain. Every
instance encodes "a team head is a `lead`", which was true of the Feature team
and has never been true of the others.

### Verified against HEAD (2026-09-20) — there are **four** literal sites, not two

| Site | Literal | What it gates |
| :--- | :--- | :--- |
| `KanbanProvider.ts:6928` | `if (role !== 'lead') return false;` | the gate itself |
| `KanbanProvider.ts:7003` | `this.isCodingTeamHead(workspaceRoot, 'lead')` | `resolveTeamHeadColumns` (which columns get the Move-All cap label) |
| `KanbanProvider.ts:7578` | `else if (plans.length > 1 && role === 'lead')` | the **batch branch** — `batchMode`/`driveMode`/`featureMode` and the cap are set inside it |
| `TaskViewerProvider.ts:8829` | `if (role === 'lead' && …)` | the extension host's batch cap arm |
| `standalone/bootstrap.ts:3623` | `if (targetRole === 'lead' && …)` | the standalone host's batch cap arm |

`isCodingTeamHead`'s own doc (`:6919-6926`) explains the role string is a
routing hint used for the `agentNames[role]` fallback, not an identity — which
is exactly why the `role !== 'lead'` guard is wrong: it refuses to even look up
the team of a coder-headed or reviewer-headed terminal.

## Metadata

- **Tags:** backend, refactor
- **Complexity:** 4
- **Feature:** 8ecfdaee-8187-4e16-aa6a-e6975c864aba

## User Review Required

No. This is a correctness fix to a gate that already exists; the derived set is
a strict superset of today's `{'lead'}` for the shipped five teams, so no
working path narrows.

## Complexity Audit

### Routine

- Deleting the `role !== 'lead'` guard and replacing it with a membership test
  against a derived head-role set.
- Replacing the four literals with the role actually being dispatched
  (`role` / `dispatchSpec.role` / `targetRole`) or with the derived predicate
  where the branch is a pure "is this a team head" question (`:7578`).
- A grep gate for `'lead'` literals at these sites.

### Complex / Risky

- **The derived set must NOT be `pairDispatchingHeadRoles()`.** See the
  Superseded callout below — that function excludes exactly the two teams this
  plan exists to unblock.
- **`:7578` is a branch condition, not a call.** Widening it changes which
  batch dispatches enter batch mode (`batchOptions.batchMode = true`,
  `driveMode = true`, `featureMode = true`, capped at `TEAM_BATCH_PLAN_CAP`).
  For a `coder`-headed Coding team that is a *behaviour* change — but it is the
  change this feature wants (Mission 03/04 route those batches to a mission
  instead; this plan makes the gate answer honestly so that routing can be
  keyed on it).
- **`resolveTeamMembersForHead` is the identity half.** The gate must still be
  false for a terminal that heads no team, so the roster check stays; the
  derived set only replaces the role pre-filter. A role in the set whose
  terminal resolves no roster stays false — do not let the widening turn
  "unknown role" into "team head".
- **Both composition roots.** The cap arms live one per root
  (`TaskViewerProvider.ts:8829`, `bootstrap.ts:3623`). A change that lands in
  one root only is a divergence with no gate (AGENTS.md) — this plan's diff
  must touch both.

> **Superseded:** "The qualifying set is **derived from the team definitions**,
> following `pairDispatchingHeadRoles()`, so a new team shape cannot reintroduce
> the gap."
> **Reason:** `pairDispatchingHeadRoles()` (`teamWiring.ts:1245-1257`) adds a
> `headRole` **only when the team has a `coder` or `intern` member**
> (`hasCheaperSeat`, `:1252-1254`); its own doc says so — *"For the shipped five
> that is `lead` (Feature team: coder + intern) and `coder` (Coding team:
> intern). Planning, Review and Multi-agent planning have no cheaper coding seat
> and are correctly excluded."* Reusing it verbatim would leave the Review
> team's `reviewer` head and both `planner` heads still answering **false**,
> failing this plan's own verification bullet ("returns true for … the Review
> team's `reviewer` head") and leaving the batch branch dark for Review.
> **Replaced with:** derive the set from **`headRole` of every enabled team
> definition** — a new sibling helper beside `pairDispatchingHeadRoles` (e.g.
> `teamHeadRoles(definitions)`, same file, same derived-not-hand-listed
> contract), unioned with the head roles of live group rows
> (`resolveDefinitionForGroup` / `terminals.groups`, so a hand-added team counts
> too). `pairDispatchingHeadRoles()` remains what it is for (pair dispatch) and
> is not modified.

## Edge-Case & Dependency Audit

**Race Conditions**

- None new. The gate is a read of config + roster; both are already read on
  every board refresh.

**Security**

- No new trust boundary. The role string reaching the gate comes from the
  dispatch path or the board, never from an unauthenticated body without
  validation.

**Side Effects**

- `resolveTeamHeadColumns` (`:7002`) uses the gate to decide which columns get
  the Move-All cap label. With a widened gate, a coder-headed Coding team's
  columns become labelled too — the intended consequence, and the reason the
  per-column call was removed in the first place (`:6995-6997`).
- Widening `:7578` means a batch to a `coder`/`reviewer` head now enters batch
  mode and is capped at five instead of receiving one uncapped prompt. Until
  Missions 03–05 land, that is a *smaller* change than today's unbounded
  prompt; after they land, those batches never reach the prompt builder at all.

**Dependencies & Conflicts**

- **Mission 03** keys the batch→mission routing on this gate. Landing M03 first
  would route on a gate that still answers `false` for coder/reviewer heads —
  i.e. the mission would never be created for exactly the teams the feature is
  about. **M02 lands before M03 and M05.**
- **Mission 05** keys the planner fan-out/rounds split on the planner-headed
  team that is live; it reads the same definition set.
- No conflict with `pairDispatchingHeadRoles`' callers (`KanbanProvider.ts:13089`,
  `:13219`, `:6971`): this plan adds a helper, it does not change that one.

## Dependencies

- `7a78665b` — the commit that fixed the pair-dispatch call sites by deriving;
  this is the same repair at the remaining sites.
- `two-teams-can-share-a-head-role-and-routing-decides-between-them` — a
  second team may share a head role; this gate must answer "this terminal heads
  a team", never "this role names the team", so it stays correct once that plan
  lands.

## Adversarial Synthesis

Key risks: the derivation named in the original plan (`pairDispatchingHeadRoles`)
excludes the two heads this plan exists to unblock, and the literal `'lead'`
exists at four sites across both composition roots, not two. Mitigations: derive
from all team `headRole`s plus live group rows; keep the roster check as the
identity half so an unknown role cannot pass; make the diff touch both roots.

## Proposed Changes

### 1. `isCodingTeamHead` takes the role it is asked about seriously (`src/services/KanbanProvider.ts:6927`)

- **Logic:** replace `if (role !== 'lead') return false;` with a membership test
  against the derived head-role set. Keep the `agentNames[role]` fallback for
  `targetTerminal`-less callers, keep `'No agent assigned'` returning false,
  keep `resolveTeamMembersForHead` as the final answer.
- **Edge cases:** an empty/unknown role still returns false (the `agentNames`
  lookup yields nothing → no origin name → false). A role in the set whose
  terminal heads no team returns false via the roster check.

### 2. One derived resolver, beside the existing one (`src/services/teamWiring.ts`, next to `pairDispatchingHeadRoles`)

- **Logic:** `teamHeadRoles(definitions = DEFAULT_TEAM_DEFINITIONS): Set<string>`
  — every `headRole` of a definition that is enabled, plus the head roles of
  live group rows read from `terminals.groups` (a hand-added team counts). One
  function, so a new team shape cannot reintroduce the gap — the same contract
  `pairDispatchingHeadRoles` documents for itself.
- **Edge cases:** a team definition with no `headRole` is skipped (the existing
  guard shape at `:1250`). Disabled teams (`enabled: false`, e.g. Multi-agent
  planning) are **included** — the gate answers "would this head a team", and
  the automated-dispatch policy is what decides whether it may receive work
  (`resolveAutomatedDispatchExclusions`, `:758`).

### 3. No call site passes a literal `'lead'`

- **Logic:** `:7003` → `isCodingTeamHead(workspaceRoot, role)` with the role the
  caller is actually resolving, or a direct roster/predicate call;
  `:7578` → the same derived predicate instead of `role === 'lead'`;
  `TaskViewerProvider.ts:8829` and `standalone/bootstrap.ts:3623` → the derived
  predicate instead of `role === 'lead'` / `targetRole === 'lead'`.
- **Edge cases:** at `:7578` the surrounding `plans.length > 1` guard stays —
  this is a batch branch, and a single plan still routes by complexity
  (Mission 06).

## Verification Plan

### Automated Tests

- **Returns true for the Coding team's `coder` head and the Review team's
  `reviewer` head; false for a role heading no team.** Extend
  `batch-move-team-prompt-contract.test.js` (which already asserts the lead
  cases at `:221-232`) with the coder/reviewer/planner rows — note its existing
  assertion *"`${role}` must never gate as a team head"* for non-lead roles is
  the assertion this plan inverts, so it must be rewritten, not appended to.
- **No call site passes a literal `'lead'`** — a grep gate over the four named
  sites (source text, in the style of the repo's existing source-text contract
  checks).
- **The Feature team's existing behaviour is unchanged**, asserted directly:
  `isCodingTeamHead(ws, 'lead', 'Coding-lead') === true`,
  `(ws, 'lead', 'Solo-lead') === false` (the existing assertions at `:221-227`
  must keep passing unmodified).
- **Both roots**: the standalone cap arm (`bootstrap.ts:3623`) and the extension
  cap arm (`TaskViewerProvider.ts:8829`) each call the derived predicate —
  assert by source text, since neither root is exercised by the shared unit
  suite.

### Goal Invariants

- **Positive:** for every `headRole` in `DEFAULT_TEAM_DEFINITIONS`, a terminal
  that heads that role's team gates `true` — the set of true answers equals the
  derived set, not `{'lead'}`.
- **Negative:** no call site of `isCodingTeamHead` in `src/` passes the literal
  `'lead'` (grep), and the batch-branch condition at `KanbanProvider.ts:7578`
  no longer contains `role === 'lead'`.
- **Negative:** a role that heads no team gates `false` even when it is a valid
  role string (`'intern'`, `'tester'`, `'researcher'`).
- **Positive:** `pairDispatchingHeadRoles()` still returns exactly `{lead, coder}`
  — this plan must not widen the pair-dispatch set as a side effect.

## Constraints

**No hand-dispatch on the Coding team.** `ptySendPrompt`-to-a-seat was
deliberately removed from its head prompt; nothing here may put it back.

**Derive the pipeline order and the head-role set** — never hand-keep either.
`_PIPELINE_POSITION` shipped wrong once when it was hand-kept.

**Nothing may be silently dropped.** Every plan is delivered or visibly queued.

**Teams are unreleased dev work** — clean break, no migration shims.
