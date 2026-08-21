# Board sync is a seam with no interface — extend RemoteProviderCapabilities to cover it and add the contract test that keeps it symmetric

## Goal

Make "every provider stays in parity" an invariant CI enforces rather than an instruction each agent re-scopes. Board sync — the half that carries kanban columns and feature structure — has no capability declaration and no contract test, which is why repeated parity work landed truthfully and left the important half asymmetric.

### Problem Analysis

There are **two seams**, and only one of them has an interface.

`RemoteProvider.ts:65` declares `RemoteProviderCapabilities` — `pull`, `push`, `archive` — and all three providers implement it:

```
ClickUpRemoteProvider.ts:23   { pull: true, push: true, archive: false }
LinearRemoteProvider.ts:30    { pull: true, push: true, archive: true  }
NotionRemoteProvider.ts:42    { pull: true, push: true, archive: true  }
```

Its docblock already states the right principle — *"gate callers on these, never on `kind`"* — and *"gates UI honestly (no toggle offers a capability a provider lacks)"*. Parity across this seam is genuinely complete.

**Board sync has no interface at all.** It is three separately-named services with no shared type, no capability flag, and no test:

| | Board push (columns, features) | Board pull (columns back) | Filed as |
|---|---|---|---|
| Notion | `NotionBackupService` | `restoreFromNotion()` | "backup" |
| ClickUp | `ClickUpSyncService` | — | "sync" |
| Linear | `LinearSyncService` | — | "sync" |

`NotionBackupService` creates its own Notion database schema (`:219`) and writes `'Kanban Column'` as a select, `'Feature'` as a self-relation, plus `'Plan ID'`, `'Status'`, `'Complexity'`, `'Tags'`, `'Repo Scope'`, `'Is Feature'` (`:558-575`). `restoreFromNotion()` (`:96`) reads it back, applies columns keyed on `planId` (`:155`), and resolves feature relations in a second pass (`:173`). That is a two-way board sync wearing the word "backup".

Meanwhile there is no `NotionSyncService` and no `NotionAutomationService`, against `LinearSyncService`/`LinearAutomationService`/`LinearDocsAdapter` and the matching ClickUp trio. Each tracker implements the other's missing half.

**And nothing enforces symmetry.** `ls src/test/ | grep -iE "provider|parity|capab"` returns nothing. So ClickUp's `archive: false` and a Notion-only board restore both pass every gate silently.

### Root Cause

Parity was measured against the seam that *had* a declaration. The seam that actually carries board state was never enumerated, so the instruction had nothing to attach to. Compounding it, the naming hides the relationship: an agent reading `NotionBackupService` beside `LinearSyncService` sees two unrelated concerns, not two implementations of one capability.

The codebase already knows how to make an invariant stick — the loopback guards are a single-source module *plus* a contract test forbidding a second copy. Provider capabilities have the module and not the test.

### Non-goals

- Not implementing ClickUp or Linear board restore. Those are separate plans; this one declares the capability and makes their absence *visible and asserted* rather than invisible.
- Not moving Notion's implementation behind the interface — also a separate plan, sequenced immediately after this one.
- Not adding new capabilities beyond board sync. The point is to close the seam that carries board state, not to enumerate everything a tracker could theoretically do.

## Metadata

**Complexity:** 4
**Tags:** architecture, providers, parity, contract-test

## User Review Required

None.

## Complexity Audit

### Routine
- Adding fields to an existing interface and updating three declaration sites.

### Complex / Risky
- **The exemption mechanism is the whole design.** A test that simply demands all-true fails on day one and gets disabled. It must accept explicitly declared exemptions carrying a reason, so an asymmetry is a visible, reviewed decision with a name attached — and removing an exemption is how a later plan proves it landed.
- **Deciding the capability granularity.** Too coarse (`boardSync: boolean`) and it cannot express "pushes but cannot restore", which is the exact current state of ClickUp and Linear. Too fine and every provider carries a dozen flags nobody gates on.
- **A boolean cannot distinguish a working implementation from a stub, and that is the flaw that produced this problem.** `ClickUpRemoteProvider.fetchCommentDeltas` (`:119-121`) is `return { deltas: [], nextCursor: sinceCursor };` — it satisfies the interface and does nothing. ClickUp nonetheless declares `pull: true`, and the interface docblock admits the split in prose: *"Provider can pull/ingest state + comments (Linear, Notion). ClickUp = state-pull only (no comment bus)."* A test comparing declarations sees `pull: true` on all three, calls it symmetric, and passes. **The asymmetry hides inside a `true`.** Two things follow: the capability set must be split to the granularity that actually varies (`pullState` and `pullComments` are different capabilities, not one `pull`), and the test must assert that a declared capability *does something* — the empty-stub shape, returning an empty collection plus the input cursor unchanged, is mechanically detectable.
- **The enumerated surface must extend past `RemoteProvider`, or the next capability drifts the same way.** Board sync escaped notice precisely because it lived outside the one interface that had a declaration. The same is true today of `ResearchSourceAdapter` — `LinearDocsAdapter:15` and `ClickUpDocsAdapter:16` both implement it and Notion implements it nowhere — and of the automation services, where `LinearAutomationService` and `ClickUpAutomationService` exist and no Notion equivalent does. If the enumeration covers only one interface, this plan fixes one instance rather than the pattern.

## Edge-Case & Dependency Audit

- `stateKeyToColumn(stateKey)` is already on the `RemoteProvider` interface and implemented by all three, so the remote-state-to-column *mapping* primitive exists everywhere. What is Notion-only is the bulk orchestration — fetch all, match by `planId`, apply columns, resolve features. The capability flags must describe the orchestration, not re-declare the mapping.
- The existing capability docblock promises UI is gated on capabilities and never on `kind`. New flags must be honoured the same way, or the UI will offer a restore button for a provider that has none.
- `archive: false` on ClickUp is a real, pre-existing asymmetry. It is the first test case for the exemption mechanism, and it must not be silently flipped to `true` to make the test pass.
- **Exemption reasons are not interchangeable and must be typed.** ClickUp has close and delete but no true archive, so `archive: false` is plausibly a *platform limitation* — permanently correct, and a plan to "fix" it would be waste. An absent board restore is *unbuilt work* — temporarily correct, and the exemption is a debt marker with a plan attached. A single freetext reason lets the two blur, and the blurring is how "we have parity" and "we have exemptions" both stay true forever. At minimum: a limitation exemption needs no plan reference and should never be removed; a not-yet-built exemption must name the plan that removes it.
- The contract test must fail on an *undeclared* asymmetry, not merely report it. A warning is what the current state already effectively is.

## Dependencies

- **Blocks** the Notion-behind-the-seam plan, the ClickUp board restore plan, and the Linear board restore plan. The test must exist before those implementations land, so each one proves itself by deleting an exemption rather than by assertion.

## Adversarial Synthesis

The tempting shortcut is to add `restore: boolean` to the existing object and stop. That gets a flag with nothing enforcing it — precisely the state that produced this problem, since `RemoteProviderCapabilities` already existed and still allowed the board seam to drift. The flag is not the fix; the test is.

The second temptation is to make the test a lint warning so it never blocks. An asymmetry that does not fail is an asymmetry that ships.

The third, and the one this plan was revised to close: keep `pull` as one boolean because splitting it touches three declaration sites. That leaves ClickUp declaring `pull: true` over an empty stub, and a test that compares booleans will certify it as parity. Every gate goes green and the asymmetry survives the very mechanism built to find it.

## Proposed Changes

1. **Extend `RemoteProviderCapabilities`** with board-sync capabilities distinguishing push from restore, documented in the same voice as the existing three.
2. **Split `pull` into `pullState` and `pullComments`**, so ClickUp's absent comment bus is a declared `false` rather than a `true` backed by an empty stub.
3. **Declare the current truth at every site** — Notion restorable, ClickUp and Linear not; ClickUp `pullComments: false` — so the object stops describing only half the system.
4. **Widen the enumeration past `RemoteProvider`** to cover `ResearchSourceAdapter` and the automation services, so Notion's two absences are visible rather than invisible.
5. **Add a provider capability contract test** that enumerates every provider and every capability and fails on any asymmetry lacking an explicit exemption.
6. **Assert that a declared capability does something.** Detect the empty-stub shape — an empty collection returned with the input cursor unchanged — so a `true` backed by a no-op fails rather than passing.
7. **Add a typed exemption declaration** distinguishing platform limitation from not-yet-built, the latter requiring a plan reference. Seed it with ClickUp `archive: false` and `pullComments: false`, the two absent board restores, and Notion's absent adapter and automation service.
8. **Gate the UI on the new flags**, honouring the interface's existing promise that no toggle offers a capability a provider lacks.

### Migration

None. Interface and test only; no persisted state and no behaviour change until a provider's declaration changes.

## Verification Plan

1. **The test fails on undeclared drift.** Flip one provider's capability to `false` without an exemption; confirm the suite goes red.
2. **The test passes on declared drift.** Add the matching exemption; confirm green, and that the exemption's reason and plan reference are required fields.
3. **Exemption removal is the proof of landing.** Confirm deleting an exemption with the capability still `false` fails.
4. **UI honesty.** Confirm no restore affordance renders for a provider declaring no restore capability.
5. **No behavioural change.** Full suite green with all three declarations at their current truth.
6. **`archive: false` survives.** Confirm ClickUp's pre-existing asymmetry is carried as an exemption and was not quietly flipped.
7. **A stub fails.** With ClickUp declaring `pullComments: true` while `fetchCommentDeltas` still returns an empty collection and the input cursor, confirm the suite goes red. This is the assertion that would have caught the original drift.
8. **The split is honest.** Confirm ClickUp declares `pullComments: false` with an exemption, and that `pullState` remains `true` for all three.
9. **The wider surface is covered.** Confirm the test sees Notion's absent `ResearchSourceAdapter` and automation service, and that both are carried as exemptions rather than passing unnoticed.
10. **Exemption types behave differently.** Confirm a not-yet-built exemption without a plan reference is rejected, and that a platform-limitation exemption needs none.

## Outstanding Questions

None.
