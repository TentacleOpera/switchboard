# A Team Commits Once, As Its Head — Members Never Commit Their Own Subtasks

## Goal

Make a team produce **one commit per completed body of work**, authored by its head, instead of a scatter of per-subtask commits from its members. A commit is a completed body of work; a team's body of work is the set of subtasks it finished. So a non-head member of a live team is told not to commit — it reports to its head — and the head commits the block once the body is done.

### Problem analysis and root cause

**No such rule exists today.** Commit behaviour is resolved from **role alone**: `resolveSeatPromptOptions` (`KanbanProvider.ts:5277`) reads `gitCommitStrategyByRole?.[role] ?? 'notSpecified'` and nothing in the resolution chain knows whether the seat is standing inside a team. A `coder` is a `coder` whether it was dispatched from the board on its own or is one of three seats under a lead.

That single axis cannot express what is actually wanted:

| Context | Desired |
| :--- | :--- |
| Coder dispatched from the board, working alone | commits its own work |
| Coder inside a team, driven by its head | does **not** commit — the head closes the body |

Setting `gitCommitStrategy: 'dontCommit'` on the `coder` role to get the second breaks the first. There is no configuration of the current surface that produces both.

**Consequence, observed.** On 2026-08-17 two coders (`lead-1-coder-1`, `lead-1-coder-2`) worked file-disjoint subtasks of *Teams You Can See, Start and Trust* in one shared tree. `lead-1-coder-1` finished first and committed `226b7f09` — sweeping in its peer's in-flight `terminals.html` / `terminals.js` work plus ~40 files of unrelated churn. Four subtasks of one feature produced four commits (`226b7f09`, `a7941d32`, `ceb9f551`, `2a89238d`), none of which is the feature.

The staging-scope half of that incident is fixed by `agent-commits-sweep-the-whole-shared-tree.md`. This plan fixes the other half: **a member should not have been committing at all.** With the head as the single committer the intra-team collision cannot occur — there is one writer of history per team, and it writes when the body is complete.

**Why this needs no new setting.** The obvious shape — a `commitAuthority` dropdown on the team definition — was considered and rejected. It invents a preference where a rule was described, and it adds a role × context grid to a config surface that is already the hardest thing in the product to reason about. Team membership is a fact the delivery layer can already read, so **context does the gating** and there is nothing to find, set, or get wrong. Role config keeps working unchanged for every seat that is not a team member.

**Why the seat path only.** The gate applies where a prompt is delivered to a seat (`ptySendPrompt`), not on the board dispatch path. That is deliberate, not an omission: a board dispatch **bypasses the head entirely** — the head receives no callback, never learns the work happened, and would never commit it. Gating there would produce work that nobody commits. A board dispatch to a team member therefore keeps its role config: the operator is managing that card, so the seat closes it. **Commit authority follows whoever is managing the work.**

**Blast radius.** Prompt text only. No verb, schema, board or DB write changes. A seat that is not a live team member is byte-identical to today.

## Metadata

**Complexity:** 6
**Tags:** feature, reliability, backend, refactor

## User Review Required

None. The no-new-setting decision, the seat-path-only scope, the head-is-the-committer rule and the shared-predicate extraction are all decided below.

## Complexity Audit

### Routine

- Reading two config keys the same function already reads a few lines later.
- Overriding one field on an already-resolved options object.

### Complex / Risky

- **Head identity is not on the group — it is on the standing order.** `TerminalGroup` is `{ id, name, members: string[], [k: string]: any }` (`standingOrders.ts:37`) and `members` holds the head *plus* every child, flat, with no head marker. The head name lives in the **order** row: `selectOrders` (`standingOrders.ts:100-135`) excludes it from `team` scope at `:117` with `if (o.parent && targetName === o.parent) { return false; }`, and the mirror `team-head` branch (`:120-131`) requires `!!o.parent && targetName === o.parent && group.members.includes(targetName)` at `:130`. So "is this seat a non-head team member?" is **exactly the existing `team` scope predicate**, and "is it the head?" is exactly `team-head`. Do not re-derive either from the team id — `teamId` is `'team_' + encodeURIComponent(headName).replace(/[^a-zA-Z0-9_]/g, '_')`, which is lossy and cannot be inverted back to a head name.

- **Extract the predicate; do not copy it.** Both hosts must answer the same question the standing-orders path already answers. Add one exported helper to `standingOrders.ts` — the module that already owns this logic and is already imported by both hosts — and have `selectOrders` use it too, so a future change to team-scope semantics cannot make the two disagree. A second hand-written membership test in `TaskViewerProvider.ts` and a third in `bootstrap.ts` is the drift this codebase repeatedly pays for.

- **The seat block rides every `ptySendPrompt`, including operator-typed text and coder→lead reports.** So an operator typing "commit this" into a team coder's pane gets a prompt carrying `Do NOT commit`. **Accepted.** It is a standing property of the seat, not a reply to that message, and the operator has two clean escapes: dispatch the card from the board, or take the seat out of the team. Adding a message-vs-dispatch discriminator here would duplicate machinery to weaken the one rule the plan exists to state.

- **This forces a clause where today there is none.** Members currently resolve `notSpecified` → *no commit clause at all* → they commit when told to. After this change they resolve `dontCommit` → an explicit "Do NOT commit. Leave all changes in the working tree for the user to review." That prose is wrong in one word for this case (the work goes to the *head*, not the user), but `GIT_COMMIT_CLAUSES.dontCommit` is shared with the board path and must not be reworded for a team-only case. Emit the shared clause and let the team prompt — already delivered as a team-scoped standing order — carry the "report to your head" half, which it already does.

- **The gate MUST be symmetric, or the team's work is never committed by anyone.** Gagging members while leaving the head on its own config produces the exact hole this plan rejects for the board path: `resolveSeatPromptOptions` defaults `gitCommitStrategy` to `notSpecified`, and this workspace's stored `lead` config carries no `gitCommitStrategy` key — so a head today receives **no commit clause at all**. Gag the members, leave that untouched, and a team completes a body of work that nobody is told to commit. So the head is forced to `whenDone` by the same rule that forces members to `dontCommit`. One rule, two directions.

  This is the more invasive half — it *creates* a commit instruction where an operator may have set none, and it overrides an explicit `dontCommit` on a head. **Accepted:** being the head of a live team is itself the statement that this seat closes the team's work, and a team whose head does not commit has no path to a completed body of work at all. An operator who wants no commits from a team removes the seat from the team or dispatches from the board, both of which restore role config exactly.

- **Interaction with the trailer work.** Once the head is the sole committer, the head's commit must carry the plan ids of the **subtasks it is closing**, not of the head's own (empty) dispatch record. That resolution is owned by `lead-dispatched-commits-carry-no-stage-trailers.md` and is a hard dependency for the review handoff, not a nicety.

## Edge-Case & Dependency Audit

**Race Conditions** — a team started, stopped and restarted rewrites `terminals.groups`. A prompt composed mid-rewrite could read a stale roster and mis-gate one message. Bounded and self-correcting: the next send reads the new roster, and the failure mode is a member briefly keeping (or losing) its commit clause, never lost work.

**Security** — none. No new input from any wire; outbound prompt text only.

**Side Effects** — non-head members of a live team gain an explicit `Do NOT commit` clause. Every other seat — solo coders, board dispatches, heads, reviewers, ungrouped terminals — is byte-identical to today.

**Migration** — none. This reads existing config keys (`terminals.groups`, the standing-orders key) written by shipped code, and adds no key of its own. Teams already on disk work unchanged; the gate is computed at delivery time, not stored.

**Dependencies & Conflicts** — touches `src/services/standingOrders.ts` (`selectOrders`, `:100-135`), `src/services/TaskViewerProvider.ts` (`_ptyHostVerb`, `:589-637`), `src/standalone/bootstrap.ts` (`deliverPrompt`, `:274-316`), and `src/test/seat-safeguards-fleet-prompt-path.test.js`. **Same files and same function bodies as `lead-dispatched-commits-carry-no-stage-trailers.md` and `a-lead-dispatched-plan-is-never-registered.md`** — all three edit the seat-block composition in both hosts, and the trailer plan additionally extends the same test file. Strict one-stream-per-file: serialise all three, never concurrent.

**Intra-function ordering (binding on the implementer, not just the plan order).** Inside `_ptyHostVerb` / `deliverPrompt` the three plans' edits must sit in this order, because each reads what the previous one produced:
1. `a-lead-dispatched-plan-is-never-registered` parses the **original** `payload.data` / `text` — it must run before any block is appended, so its parse site is the topmost of the three.
2. **This plan's** config hoist + `resolveTeamStanding` — must precede the seat-options override *and* the trailer plan's `planIds` lookup, both of which read `standing`.
3. `lead-dispatched-commits-carry-no-stage-trailers` resolves `planIds` from `standing.members` and passes them into `buildSeatDirectiveBlock`.

## Dependencies

- `agent-commits-sweep-the-whole-shared-tree.md` — the other half of the `226b7f09` incident (staging scope). Independent; either order.
- `lead-dispatched-commits-carry-no-stage-trailers.md` — consumes this plan's outcome (the head becomes the seat whose commit needs team-scoped plan ids). Land this first, or accept that the trailer plan's team-scoped resolution has no committer to serve yet.

## Adversarial Synthesis

**Risk summary.** The dominant risk is a half-applied gate: gagging members without forcing the head to `whenDone` leaves a team whose completed body of work nobody is told to commit, because a head's shipped default is `notSpecified` and emits no commit clause at all. Next is re-deriving team membership instead of reusing the predicate `selectOrders` already runs — head identity lives on the standing-order row, not on the group, and the team id cannot be inverted to recover it, so an independent implementation will get the head wrong and silence the one seat that is supposed to commit. Second is scope: gating the board path as well as the seat path produces work that nobody commits, because a board dispatch never reaches the head. Third is the shared `dontCommit` prose, which says "for the user to review" and must not be reworded for a team-only case. Mitigations: one exported predicate in `standingOrders.ts` consumed by `selectOrders` and both hosts; the board path is explicitly out of scope with the reason stated; the team prompt already carries the report-to-your-head half.

## Proposed Changes

### `src/services/standingOrders.ts` — one exported predicate, two consumers

- **Context:** `TerminalGroup` (`:37`); `selectOrders` (`:104-134`), whose `team` and `team-head` branches already encode head-vs-member.
- **Logic:** export a pure helper beside `selectOrders`:

```ts
/** Team standing of a seat, derived from the SAME facts `selectOrders` uses:
 *  the group roster (`terminals.groups`) plus the head name carried on each
 *  team-scoped order's `parent`. Returns `inTeam: false` when no live team
 *  claims the seat — never a guess. */
export function resolveTeamStanding(
    targetName: string,
    orders: StandingOrder[],
    groups: TerminalGroup[]
): {
    inTeam: boolean;
    isHead: boolean;
    teamId?: string;
    headName?: string;
    /** The resolved group's `members` array VERBATIM — head included, flat,
     *  in stored order. `[]` when `inTeam` is false. Returned because the
     *  head's commit trailers need its members' plan ids
     *  (`lead-dispatched-commits-carry-no-stage-trailers.md`) and that plan
     *  must NOT re-resolve the group: re-deriving the roster from `teamId` is
     *  impossible (the id is a lossy slug of the head name) and re-deriving it
     *  from `groups` is the second membership test this helper exists to
     *  prevent. One resolution, one roster, two consumers. */
    members: string[];
}
```

  Then rewrite `selectOrders`' `team` / `team-head` branches to call it, so the two cannot diverge.

- **Edge Cases:** a seat in no group, a team order whose `teamId` matches no registered group, and an order with an empty `parent` all yield `inTeam: false` **and `members: []`** — never `undefined`, so a consumer's `.filter(...)` is always safe without a guard. A seat that is both a head of one team and a member of another resolves as **head**, and `members` is the roster of the team it *heads* — a head's commit authority wins, because it is the seat other agents are reporting to, and the plan ids it must carry are its own team's.

  > **Superseded:** a return type of `{ inTeam, isHead, teamId?, headName? }`, with no roster.
  > **Reason:** It cannot serve its only other consumer. `lead-dispatched-commits-carry-no-stage-trailers.md` resolves a head's `planIds` as the union of its **members'** dispatch records and its written implementation reads a `roster` off this call — a value the declared type never produced. Two plans, one function, incompatible signatures: whichever landed second would either add the field anyway (making this plan's stated contract wrong) or hand-roll a second `groups.find(...).members` lookup in both hosts, which is exactly the drift the extract-the-predicate bullet above exists to forbid.
  > **Replaced with:** `members: string[]` on the return, defaulted to `[]`. The head-minus-self filtering is the **consumer's** job, not this helper's — this returns the group's roster as stored, and the trailer plan drops the head from it.

### `src/services/TaskViewerProvider.ts` — gate at the extension delivery layer

- **Context:** `_ptyHostVerb` resolves `seatOpts` at `:594-596` and composes at `:597`. The standing-orders branch below already reads both inputs this needs — `getConfigJson(STANDING_ORDERS_CONFIG_KEY, [])` at `:619` and the `terminals.groups` read at `:631-633`, both currently inside `if (applySO)` (`:618`).
- **Logic:** hoist those two reads (and the `migrateCodingTeamOrders(migrateTeamPairOrders(orders))` transform at `:625`) above the `if (applySeatBlock)` branch at `:589`, resolve standing, and override:

```ts
const standing = resolveTeamStanding(payload.name, effectiveOrders, groups || []);
const seatOpts = this._kanbanProvider
    ? await this._kanbanProvider.resolveSeatPromptOptions(role)
    : null;
const effectiveOpts = !seatOpts || !standing.inTeam
    ? seatOpts
    : { ...seatOpts, gitCommitStrategy: standing.isHead ? 'whenDone' : 'dontCommit' };
```

- **Edge Cases:**
  - Hoisting must not change standing-orders behaviour — the same migrated `effectiveOrders` array feeds both consumers, and `applyStandingOrders` keeps receiving exactly what it receives today.
  - **The hoist makes the config reads unconditional, and that is correct.** They are currently gated on `applySO`; after the hoist a send with `standingOrders: false` performs them too. Two DB reads on a path that already performs a `ptyListTerminals` round-trip is proportionate, and the alternative — reading them only when `applySO` — would silently drop the team gate for exactly the callers that suppress standing orders.
  - **`standingOrders: false` must NOT disable the gate.** Team standing is a fact about the seat, not an order delivered to it. A caller suppressing the orders block is asking for less prose, not for a member to regain commit authority. Pin this as a test case.
  - A read failure leaves `standing.inTeam` false and the seat behaves exactly as today; a degraded prompt beats a lost dispatch. Note the existing `try` at `:537` already wraps this whole region — do not add a second one.

### `src/standalone/bootstrap.ts` — same gate on the standalone host

- **Context:** `deliverPrompt` at `:246-319`; seat options resolve at `:281-283` and compose at `:284`. The same two config reads sit inside its `if (applyOrders)` branch at `:301` and `:310-312`, with the same migration transform at `:307`.
- **Logic:** identical hoist and override, keyed on `handle.friendlyName`, above the `if (applySeatBlock)` branch at `:274`.
- **Edge Cases:** this host's `applyOrders` branch has its own `try` (`:300`) separate from the seat block's (`:275`). The hoisted reads need one `try` of their own that yields `inTeam: false` on failure — do not hoist them inside either existing `try`, or a config read failure silently changes which of the two blocks is skipped.

### `src/test/seat-safeguards-fleet-prompt-path.test.js` — pin the rule and its scope

- **Logic:** add —
  1. `resolveTeamStanding` returns `{inTeam:true,isHead:false}` for a roster member that is not the order's `parent`, and `{inTeam:true,isHead:true}` for the parent.
  2. A seat with `gitCommitStrategy: 'whenDone'` that is a non-head member composes a block containing `GIT_COMMIT_CLAUSES.dontCommit` verbatim and **not** the `whenDone` text.
  3. A head whose role config carries **no** commit strategy (`notSpecified`, the shipped default) composes the `whenDone` clause — the symmetry guard. A head with an explicit `dontCommit` composes `whenDone` too, and the failure message states why.
  4. A seat in no group composes a block byte-identical to the same call before this change — the no-team path is untouched.
  5. Source-text: `selectOrders` calls `resolveTeamStanding`; neither host contains its own `g.members.includes(` membership test.
  6. Source-text: `buildKanbanBatchPrompt` contains no `resolveTeamStanding` call — the board path is deliberately ungated.
  7. `resolveTeamStanding` returns `members` equal to the group's stored `members` array **verbatim** (head included, order preserved) for both a member and the head, and `members: []` — not `undefined` — for a seat in no group, a `teamId` matching no group, and an order with an empty `parent`. This is the field `lead-dispatched-commits-carry-no-stage-trailers.md` consumes; an `undefined` here is a `TypeError` on its delivery path.
  8. A send with `standingOrders: false` to a non-head member still composes the `dontCommit` clause — suppressing the orders block must not restore commit authority. The gate reads team membership, not the orders payload flag.

## Verification Plan

### Automated Tests

1. `npm run lint`.
2. The extended `seat-safeguards-fleet-prompt-path.test.js` — eight new cases pass, all existing cases pass unchanged.
3. `standing-orders-marker-contract.test.js` and the team-scope cases in `stage-marker-commit-contract.test.js` pass unmodified — `selectOrders`' behaviour must be identical after the refactor.

### Manual

4. Start the Coding team. Send any prompt to `lead-1-coder-1` via `ptySendPrompt` and read it: the GIT POLICY block carries `Do NOT commit.`
5. Send the same prompt to `lead-1` (the head), whose role config sets no commit strategy: the block carries the `whenDone` clause — not silence. This is the step that proves the team's work has a committer.
6. Send the same prompt to an ungrouped coder terminal: byte-identical to before the change.
7. Dispatch a card from the **board** to `lead-1-coder-1`: the prompt carries its role strategy, not `dontCommit` — the board path is ungated by design.
8. Drive the reproduction: two team coders, file-disjoint subtasks, one shared tree. Both finish and report; neither has committed; the head commits once and `git show --stat` names both subtasks' files and nothing else.
9. Send to a team coder with `"standingOrders": false` in the payload: no standing-orders block, but the `Do NOT commit.` clause is still present.
10. Repeat 4–6 on the standalone host.

---

**Recommendation:** Complexity 6 → **Send to Lead Coder.**

---

## Completion Report

Implemented the team-commit gate on both delivery hosts. Added `resolveTeamStanding` to `standingOrders.ts` as the one exported predicate that derives team standing (inTeam, isHead, members verbatim) from the same facts `selectOrders` uses; rewrote `selectOrders`' team and team-head branches to call it so the two cannot diverge. In `TaskViewerProvider._ptyHostVerb`, hoisted the `loadEffectiveStandingOrders` and `terminals.groups` reads above the `if (applySeatBlock)` branch (inside the existing outer try, no second try), and overrode `seatOpts.gitCommitStrategy` to `dontCommit` for non-head members and `whenDone` for heads; deleted the duplicated inner reads so one resolution feeds both the gate and `applyStandingOrders`. In `bootstrap.ts` `deliverPrompt`, same hoist and override with its own try (yielding `inTeam: false` on failure) since that host has separate trys. `buildKanbanBatchPrompt` is ungated (board path bypasses the head). Eight test cases added to `seat-safeguards-fleet-prompt-path.test.js`; `node --check` passes. Files changed: `src/services/standingOrders.ts`, `src/services/TaskViewerProvider.ts`, `src/standalone/bootstrap.ts`, `src/test/seat-safeguards-fleet-prompt-path.test.js`. No issues encountered; not committed or staged per team-head policy.

## Review Findings

One CRITICAL and one MAJOR, both fixed. CRITICAL: `resolveTeamStanding` resolved headship only from the `team-head` scope, but `wireSpawnedTeam` writes that order only when a non-empty `headPrompt` was supplied — true for one of three shipped team types and no operator-created team that left the box empty — so every other team gagged its members to `dontCommit` while its head resolved `inTeam:false`, kept the shipped `notSpecified` default and received no commit clause at all, which is verbatim this plan's stated dominant risk; headship now also resolves from the always-written `team` order's `parent` (the same fact `selectOrders` uses for its head exclusion), as its own pass ahead of the member pass so "head wins" still holds, pinned by a new regression case in `seat-safeguards-fleet-prompt-path.test.js`. MAJOR: the `bootstrap.ts` hoist comment placed the bare token `applyStandingOrders` textually above `buildSeatDirectiveBlock` and turned the existing source-text ordering gate red — reworded, code unchanged. Files changed by this review: `src/services/standingOrders.ts`, `src/standalone/bootstrap.ts`, `src/test/seat-safeguards-fleet-prompt-path.test.js`. Validation: `seat-safeguards` 94/0, `standing-orders-marker` 55/0, `team-scoped-routing` 41/0, `multi-parent-terminals` 29/0, typecheck clean, lint 0 errors; verified live that a head now composes `whenDone`, a member `dontCommit`, an ungrouped seat is untouched, and the head still does not receive the members' team prompt. Remaining risks, both accepted as the plan argues: `selectOrders` ANDs the shared predicate onto its surviving inline test rather than replacing it (identical for a single-team seat, narrower only for the unreachable multi-team case), and the shipped Coding roster includes its reviewer seat, so a `ptySendPrompt` to it carries `Do NOT commit` — its real dispatch is the board path, which is ungated by design.
