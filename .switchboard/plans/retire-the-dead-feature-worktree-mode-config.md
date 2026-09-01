# `feature_worktree_mode` provisions nothing and can only be read — retire the flag the removal left behind

## Goal

Delete `feature_worktree_mode`: the config key, its normalizer, its only remaining writer, its read,
its broadcast field, and the contract test pinning the restore machinery. The behaviour it once
governed was deleted deliberately; the flag survived, and a stale value on an existing install is
now readable state that describes a capability the system no longer has.

### Problem Analysis

**The provisioning was removed, and the code says why in its own words.** `stageForQueue`
(`KanbanProvider.ts:8667`):

> *"Staging provisions NO worktrees. This loop used to cut one integration worktree per staged
> feature whenever `feature_worktree_mode` was `'per-feature'`, and **that is the defect**, not the
> timing:*
>
> *— Stage two features and you get two sibling branches off the default branch. Neither can see the
> other's work, and nothing recorded that one needed the other — the exact clash the consolidation
> existed to remove. **The dependency edges that would have said so are persisted in
> `plan_dependencies` and this path never read them.***
>
> *— It contradicts the mission design… "It does not provision a worktree per stream. A mission
> carries a `maxExtraWorktrees` field … which is 0 by default and which a mission of type `mission`
> may never exceed 1." Per-unit-of-work provisioning is precisely what that forbids.*
>
> *— Once the toggle was on it was mandatory and unbounded. Worktrees are opt-in, and the opt-in
> carries a COUNT, not a per-feature rule.*

The conclusion is explicit: *"Opt-in provisioning belongs on the mission (`maxExtraWorktrees`, 0 by
default)."* Parallel checkouts require a curated mission with dependency edges and a deliberate
launch — never a mode a scheduler can read.

**What survived the removal:**

| Survivor | Site | State |
| :--- | :--- | :--- |
| The only writer | `KanbanProvider.ts:2534` — Mission Control disarm restore | Writes back a value nothing sets |
| The read | `KanbanProvider.ts:15213` | `normalizeFeatureWorktreeMode(await db.getConfig(...))` |
| The broadcast | `KanbanProvider.ts:15273` | Ships `featureWorktreeMode` in a payload |
| The normalizer | `normalizeFeatureWorktreeMode` | Exists to make legacy values render |
| The contract test | `worktree-strategy-control-contract.test.js` | Pins the restore machinery, by count |
| Shipped config rows | every install that ever set it | `'per-feature'` on old installs, unreachable now |

**No UI writes it.** The webviews carry zero references to `feature_worktree_mode`; the radio it was
built for is gone. `agent-groups-worktree-mode` ("Spawn in own worktree", `kanban.html:3332`) is a
*team group* setting — `group.worktreeMode === 'auto'` — a different axis with a different owner.

So the key's entire remaining lifecycle is: a legacy value sits in config, gets normalized, gets
read, gets broadcast, and — if a Mission Control session arms and disarms — gets written back to
itself. It governs nothing.

### Root Cause

The same failure this repo has already diagnosed twice.
`retire-queue-sequencing-auto-orchestrator.md`: *"A blocking group-then-sequence step was designed,
then removed once individual enqueue landed. The removal took the behaviour and left the flag, the
dep, the constant, and the prose. The docblocks then became the most authoritative-looking
description of a design that no longer exists — and they mislead readers into describing removed
behaviour as current."*

That is exactly what happened here, and it has already cost something concrete: a sibling plan
(`scheduled-jobs-get-a-when-condition-rules-not-just-clocks.md`) was drafted scoping its readiness
predicate by this mode, on the reasonable-looking inference that a live, normalized, broadcast
config key describes live behaviour. On an old install carrying `'per-feature'`, that would have
freed a lane whose working tree was occupied.

### Non-goals

- **Not touching `worktrees`, `plans.worktree_id`, or mission provisioning.** Those are live.
- **Not touching `group.worktreeMode`** (`agent-groups-worktree-mode`). Different axis, live.
- **Not removing `useWorktreesPerPlan`.** A per-role prompt add-on where the agent creates its own
  worktree; out of scope and separately owned.
- **Not deleting the Mission Control arm/disarm restore *pattern*** — only this key's participation
  in it. The pattern exists because forcing and restoring a user setting across a crash was a real
  defect; if no other key rides it, that is a finding for a follow-up, not a licence to delete it
  here.

## Metadata

**Complexity:** 3
**Tags:** backend, cleanup, refactor, reliability

## User Review Required

- **Confirm nothing consumes the broadcast `featureWorktreeMode`.** It is shipped in a payload
  (`:15273`); a webview reading it would break on removal. The webview grep is clean, but confirm
  no external agent surface reads it before deleting the field.
- **Confirm the disarm restore has another rider.** If `feature_worktree_mode` is the *only* key
  `mission-control_prior_*` restores, removing it strands the whole restore path and
  `worktree-strategy-control-contract.test.js` loses its subject. Establish that before editing the
  test — the test exists because a crash once left a forced value in place, and that lesson must
  survive whatever replaces it.

## Complexity Audit

### Routine

- Deleting a read, a broadcast field and a normalizer with no remaining callers.

### Complex / Risky

- **The contract test asserts by COUNT, deliberately.**
  `worktree-strategy-control-contract.test.js:87-90` counts occurrences of
  `mission-control_prior_feature_worktree_mode` in `KanbanProvider` and fails on a mismatch —
  *"asserted by COUNT, not presence, so a left-behind writer fails."* Any edit that removes one of
  the two sites and not the other fails loudly, which is correct and intended. The test is rewritten
  in the same commit, not adjusted until green.
- **Shipped config rows on ~4,000 installs.** Per `CLAUDE.md`, state that shipped must be migrated,
  not assumed absent. The row is *dropped on read* rather than deleted by a destructive write —
  the same pattern `GlobalIntegrationConfigService.DROPPED_SOURCES` uses (`:502-508`), which keeps
  the value inert in storage until the next legitimate write and never rewrites a user's blob to
  remove a key.
- **`normalizeFeatureWorktreeMode` may have other callers.** `agentPromptBuilder.ts:673` and `:806`
  reference the mode in comments only, and `feature-worktree-guardrail-contract.test.js:120-124`
  asserts *"the inert featureWorktreeMode prompt plumbing stays out"* — so the prompt builder must
  stay clean of it. Removing the normalizer must not tempt anyone to re-add plumbing that test bans.

## Edge-Case & Dependency Audit

- **An install mid-Mission-Control-session on upgrade** has a parked
  `mission-control_prior_feature_worktree_mode`. Removal must not leave that orphan key readable as
  though it meant something; it is dropped on read alongside its subject.
- **Both composition roots.** The read and broadcast are in `KanbanProvider`, shared by both hosts,
  so removal reaches both — but verify rather than assume, per `CLAUDE.md`.
- **`feature-worktree-guardrail-contract.test.js` keeps its assertions; only its prose changes.**
  Its `worktreeActive` parameter is not the mode — `agentPromptBuilder.ts:1824` derives it as
  `worktreePaths.length > 0`, true for *any* worktree the agent stands in, whoever cut it. The test
  asserts that a host-owned worktree selects the **standard** guardrail rather than the narrowed one,
  which is the regression gate for a disjunct that once *"silently handed `git worktree remove`
  permission to an agent standing inside a worktree it neither created nor owns."*

  Under the mission rule that invariant is needed **more**, not less: a mission provisions the
  worktree, the host owns it, and the agent inside it must still not be able to remove it. Deleting
  the assertion would reopen the hole in precisely the configuration the system is standardising on.

  So: retarget the header docblock (`:10`) and the inline comment (`:77`) from
  `feature_worktree_mode = 'per-feature'` to *"a mission-provisioned worktree, within
  `maxExtraWorktrees`"*, and leave every `assert` untouched. The file's `:120` assertion — *"the
  inert featureWorktreeMode prompt plumbing stays out"* — also stays: it bans the mode from the
  prompt builder, which this plan's direction reinforces.

  This also resolves the apparent conflict with `stageForQueue`: the test never asserted that
  provisioning happens, so there was never a contradiction and the removal is complete.

## Proposed Changes

1. **Retarget the guardrail test's prose, keep its assertions.** `:10` and `:77` explain the
   scenario via `feature_worktree_mode`; they now name a mission-provisioned worktree bounded by
   `maxExtraWorktrees`. No `assert` changes.
2. Delete the read (`:15213`) and the broadcast field (`:15273`).
3. Delete the disarm restore writer (`:2534`) and its `PRIOR_KEY`, subject to the review question.
4. Delete `normalizeFeatureWorktreeMode` once callerless.
5. Drop `feature_worktree_mode` and `mission-control_prior_feature_worktree_mode` on config read,
   never by destructive write.
6. Rewrite `worktree-strategy-control-contract.test.js` to pin the surviving lesson — a forced
   setting is never left in place by a crash — against whatever key still rides that path, or
   retire it with that lesson recorded if none does.

## Verification Plan

### Automated Tests

1. **No source file outside a migration or comment references `feature_worktree_mode`.** A grep
   gate. This is the assertion whose absence let the key outlive its behaviour.
2. **A config row carrying `'per-feature'` is inert.** Seed it, run staging, assert **no worktree is
   provisioned** — the guarantee `stageForQueue` already claims, now pinned against the legacy value
   rather than the default.
3. **The row is not destructively rewritten.** Round-trip a config blob carrying the key plus
   unknown siblings; assert the siblings survive and the key is filtered from execution, matching
   the `DROPPED_SOURCES` precedent.
4. **`normalizeFeatureWorktreeMode` has no callers.**
5. **The prompt builder stays clean** — `feature-worktree-guardrail-contract.test.js:120` still
   passes, so the removal does not re-open the plumbing that test bans.
6. **Every guardrail assertion still passes unchanged.** The whole file runs green with only its
   comments edited. If an assertion has to change to accommodate this plan, the plan is wrong.
6. **Both hosts.** Neither root reads or broadcasts the field after removal.

### Goal Invariants

- **Worktrees are provisioned by a mission, bounded by `maxExtraWorktrees`, or not at all.** There
  is no per-feature, per-team or per-plan rule by which the system cuts a checkout on its own —
  parallel checkouts follow curated dependency edges (`plan_dependencies`) and a deliberate launch.
- **An agent never owns a worktree it did not create.** A mission-provisioned worktree is host-owned;
  the agent standing in it gets the standard guardrail and no `git worktree remove`. Pinned by
  `feature-worktree-guardrail-contract.test.js`, which this plan preserves.
- No config key describes a worktree strategy the system cannot perform.
- No scheduler, rule or readiness check can infer checkout isolation from a setting.

### Manual

- Upgrade an install carrying `'per-feature'`; stage two features; confirm no branches are cut and
  the board behaves as under `'none'`.
- Arm and disarm a Mission Control session; confirm no forced value is written or restored.
