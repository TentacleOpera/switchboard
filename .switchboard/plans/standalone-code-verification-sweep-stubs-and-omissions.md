# Standalone Parity by Code Verification — Sweep for Stubs, Omitted Wiring, Discarded Values and Gates That Pass Vacuously

<!-- board-collapse-audit -->
> **REDIRECT 2026-09-04 (Board Collapse audit).** This plan names `standalone-kanban-move-endpoint-not-wired.md` in its Shape 1 discussion and in **Dependencies & Conflicts**. That plan has been **deleted**: commit `cf57044b` wired `moveCard`, `onPhoneAFriend`, `clearTerminalContext` and both team-pacing resolvers into the standalone composition root, closing its defect — verified against a running board, `POST /kanban/move` returns 200.
> > 
> > The option-supply parity assertion it was going to add is now owned by **`a-composition-root-parity-gate-that-actually-fails.md`**, in the *Gates that mean something* feature. Read the dependency as pointing there. Do not wait for a plan that no longer exists.


## Metadata

**Complexity:** 5
**Tags:** standalone, parity, verification, audit
**Project:** Browser Switchboard

## Goal

Answer the standalone parity question by reading code rather than clicking UI: for every capability the docs describe, confirm a real implementation exists and is actually reached in the standalone composition root. The deliverable is a defect list, not a register of verdicts. This subtask runs **after** the four fix subtasks, because three of its seven sweeps are performed by guards those subtasks build.

### Problem analysis and root cause

Three parity efforts have now been declared complete and none answered the question. The first two passed on `{success: true}`. The third (`standalone-vs-extension-doc-parity-audit`) passed on catalog membership — 178 of its 286 `LIVE` rows cite *"verb available"* or *"in catalog"*, which is verb reachability and handler presence, the criterion its own evidence rules banned. Its register now records its own quality gate as FAILED.

The recurring cause is not carelessness. It is that **every instrument used so far measured reachability**, and in this codebase reachability is guaranteed independently of whether a feature works: `bootstrap.ts`'s `kanbanVerb` `default:` arm delegates every unmatched verb to `KanbanProvider.handleServiceVerb`, so every verb answers and every write lands whether or not the capability behind it exists.

The instrument that does work is code reading — and this is demonstrated, not assumed. A short review pass over the failed audit found four real defects by tracing call paths, none of which any of the three audits caught. A second pass while planning them found each was **larger than first traced**, which is itself the argument for the sweep:

1. **An optional callback never passed.** `LocalApiServer` takes `moveCard` as optional (`:55`) and fails closed without it (`:1383-1384`); `bootstrap.ts` never passes it, though it wires six sibling `kanbanProvider` delegates in the same block. A scan of the option surface found `moveCard` is **1 of 14** options the extension supplies and standalone does not, out of 40 optional options total.
2. **A write no reader consults — and one wrong reader that does.** `handleToggleKanbanColumnVisibility` (`TaskViewerProvider.ts:11082-11100`) stores `visibleAgents[columnId]` for custom columns; `_filterVisibleColumns` (`:4187-4200`), `_buildSetupKanbanStructure` (`:4201-4248`) and a third reader missed on first pass, `PlanningPanelProvider` (`:7332-7340`), all ignore it. The same write is mirrored into the **machine-global** agents file, where `getPtyVisibleRoles` (`GlobalIntegrationConfigService.ts:445-469`) merges it into the terminal role map and `terminals.js:6141` renders it — so a custom column id becomes a selectable agent role on every workspace on the machine.
3. **Values computed then discarded.** Eighteen `get*` arms in `SetupPanelProvider.ts` push their value and `return { success: true }`, inverting the contract at `local-api-server.md:171` and PRD contract #4. One more (`KanbanProvider.getFeatureWorktreeMode:11852`) pushes via a helper, so the value never exists in the arm at all.
4. **A retired feature still documented.** `planAutoFetch` was deleted in `4d335c3c` and replaced by a Scheduler source; **four** doc pages plus a page frontmatter description still describe it as live.

Each has a distinct signature that is invisible to reachability testing and obvious in the code. That is the case for this plan: not a more thorough audit, but the instrument matched to the defect class.

### The seven defect shapes to hunt

The sweep is defined by what it looks for. Each shape is drawn from a confirmed instance above, so none is speculative:

| # | Shape | Signature in code | Confirmed instance |
|---|---|---|---|
| 1 | **Omitted wiring** | An optional constructor/option callback consumed by a guard that fails closed, never supplied by one composition root | `moveCard`, and 13 more |
| 2 | **Orphan write** | State written under a key no reader consults, or read under a different key than it is written | custom column visibility |
| 3 | **Discarded value** | A value resolved, side-channelled (push/postMessage), then dropped from the return | 19 `get*` verbs |
| 4 | **Retired-but-documented** | Docs describe a capability whose implementation was deleted or replaced | `planAutoFetch` |
| 5 | **Literal standing in for live state** | A hardcoded constant where the extension reads real state | *(previously in the standalone state builders; fixed — retained as a regression class)* |
| 6 | **Cross-namespace write** | State written into a map shared with an unrelated namespace, where a reader for the *other* namespace consumes it | custom column id → terminal role picker |
| 7 | **Vacuously-green gate** | A CI check at its floor while the property it is cited as proving is violated | `verb-returns:check` baseline `Setup: 0` |

Shape 5 is included precisely because it was the dominant defect class three weeks ago and has since been fixed (`bootstrap.ts:394/403/417/427/446` now delegate to `getFullStateMessages`). It stays on the list as a regression class, not an open finding.

Shapes 6 and 7 are new, added after tracing shapes 2 and 3 to their ends. Shape 6 is the sharper sibling of shape 2: an orphan write is inert, whereas a cross-namespace write is *actively misread* — and it is harder to see, because the state does have a reader and does have an effect, just not the intended one. Shape 7 is the most important shape in the list for this feature, because it is the failure mode of the audits themselves: `SetupPanelProvider` sits at ratchet ceiling `0` — green, at floor, machine-"done" by the PRD's own definition — while hosting all eighteen instances of shape 3. A gate that measures an adjacent property and is cited as proving the real one is exactly how three audits passed.

### Why this runs last

The first pass framed the sweep as running first or concurrently, to avoid duplicating the option enumeration. Planning the fix subtasks inverted that. Three of the seven sweeps are no longer manual work:

- **Shape 1** is performed by the option-supply parity assertion `standalone-kanban-move-endpoint-not-wired.md` adds to `scripts/check-standalone-push-parity.js`, with its exemptions in `scripts/standalone-parity-allowlist.json`.
- **Shape 3** is performed by the bare-ack dimension `read-verbs-return-bare-ack-violating-documented-http-contract.md` adds to `scripts/check-verb-return-contract.js`.
- **Shape 5** is already performed by that same standalone script's existing no-hardcoded-view-state ratchet.

Running the sweep first means hand-deriving three lists that are about to become machine-checked, and then reconciling two enumerations of the same surface. Running it last turns three of the seven sweeps into "run the guard and read the output", and leaves the sweep's own effort where it is irreplaceable: shapes 2, 4, 6 and 7, which no guard covers.

## User Review Required

None.

## Complexity Audit

### Routine

- Running the guards the fix subtasks land, and reading their output.

### Complex / Risky

- **Reachability must not be counted, at all.** The prior audit's failure is repeatable by anyone who records "verb exists" as evidence. A finding here is a **traced path with a named break** — which caller, which callee, where the value or control flow stops. Anything less is not a finding.
- **A green gate is not evidence either — that is shape 7.** Do not record "the ratchet passes" as confirmation of any property. For each gate cited in support of a claim, read what it actually measures. `verb-returns:check` counts `break` statements, not returned data. `parity:check` proves allowlist ≡ catalog and that a generic dispatcher is in place — not that any arm works. `push-routing:check` counts raw `postMessage` calls. Each is a real guarantee about a real property; none is a guarantee about the property it is most likely to be cited for.
- **Both composition roots must be compared, not just standalone read.** Every one of the four confirmed defects was found by asking "what does the extension do here that standalone does not, or vice versa?" A sweep that only reads `bootstrap.ts` finds omitted wiring but misses shapes 2, 3, 4 and 6, which are in **shared** code and affect both hosts. Two of the four confirmed defects are not standalone-specific at all — do not assume the defect class is browser-only, and do not file a shared defect as a parity gap.
- **Shape 6 needs a different search than shape 2.** An orphan write is found by looking for a key with no reader. A cross-namespace write is found by looking for a state map with two writers whose key *domains* differ — a role map also written with column ids, a settings map also written with ids from elsewhere. Start from every shared `Record<string, boolean>`-shaped store and ask what populates it, not what reads it. `visibleAgents` is the known instance; the machine-global agents file's three keys (`startupCommands`, `visibleAgents`, `customAgents`) are the obvious place to look next, since all three are machine-global while much of what writes them is workspace-scoped.
- **Scope discipline.** This sweep produces defects, not verdicts, and not a register. The previous attempt's 387-row register is a genuine asset — the doc claims are enumerated and the corpus arithmetic is confirmed correct (61 files / 3,555 lines). Reuse it as the **claim list** to sweep against; do not re-derive it and do not re-verdict it row by row, which is what made the last pass unaffordable and unfinished.
- **Do not add browser automation.** Explicitly out of scope. Where a claim genuinely cannot be settled by reading code — a rendering or layout claim — record it as out of scope for this instrument and move on, rather than expanding the plan.
- **Findings land in open plans, not new siblings.** Both the orphan-write and discarded-value fix plans are deliberately scoped to sweep past their enumerated lists. A late finding of shape 2, 3 or 6 is an addition to an existing plan while it is open, not a new card.

## Edge-Case & Dependency Audit

**Race Conditions** — none introduced; the sweep is read-only.

**Security** — the sweep reads configuration and secret-handling paths. Record the shape of a defect, never a credential value. Note that standalone sets `allowSecretWritesOverHttp: true`; if that surfaces a finding, it is a finding, not an assumption to build on.

**Side Effects** — none. No host is driven, no workspace mutated.

**Dependencies & Conflicts** — the four confirmed defects already have plans: `standalone-kanban-move-endpoint-not-wired.md`, `custom-column-visibility-toggle-writes-state-no-reader-consults.md`, `read-verbs-return-bare-ack-violating-documented-http-contract.md`, `docs-still-document-retired-plan-autofetch.md`. This sweep must not re-plan them; it extends the list. `standalone-kanban-column-parity-audit.md` separately owns next-column resolution.

## Dependencies

- **`standalone-kanban-move-endpoint-not-wired.md`** — supplies the shape-1 sweep as a CI assertion plus its allowlist. Land first.
- **`read-verbs-return-bare-ack-violating-documented-http-contract.md`** — supplies the shape-3 sweep as a ratchet dimension. Land first.
- The existing register at `.switchboard/audits/standalone-extension-parity.md` — used as the enumerated claim list, with its verdict column ignored.

## Implementation

1. **Shape 1** — run the option-supply parity assertion and read its output. Confirm every exemption in `scripts/standalone-parity-allowlist.json` carries a stated reason, and that the reason is true. An exemption whose reason does not survive reading the code is a finding. Then extend the same question beyond `LocalApiServer` to any other service constructed by both roots.
2. **Shape 2** — sweep for orphan writes: state keys written by one handler and read by another under a different derivation. `visibleAgents` is the known instance; look for the same shape in the other persisted maps.
3. **Shape 3** — run the bare-ack ratchet dimension and read its per-provider counts. `Planning` (152) and `Tickets` (55) on the break ratchet mark the least-migrated providers and therefore the likeliest to carry residual instances.
4. **Shape 4** — cross-check the doc corpus against the tree for retired-but-documented capabilities: for each documented settings family or named control, confirm a live implementation. `planAutoFetch` is the known instance; the first pass on it undercounted its own pages by one and missed a frontmatter line, so grep the corpus rather than reading the pages a claim names.
5. **Shape 5** — re-check the literal-standing-in-for-live-state class against `bootstrap.ts` to confirm the fixed builders have not regressed.
6. **Shape 6** — enumerate the shared key-value state stores, and for each, list every writer and the key *domain* it writes. Flag any store with two writers whose domains differ. Give the machine-global agents file (`startupCommands`, `visibleAgents`, `customAgents`) priority, since it is machine-global while several of its writers are workspace-scoped.
7. **Shape 7** — for each CI gate in `package.json`'s check family (`catalog:check`, `parity:check`, `push-routing:check`, `standalone-parity:check`, `standalone-fork:check`, `kanban-dispatch-callers:check`, `verb-returns:check`, `mirror:check`, `icons:parity`), record in one line what it actually measures and what it is commonly cited as proving. Any gap between those two is a finding.
8. For each finding, record the traced path — caller, callee, and the exact line where control or data stops — and either link an existing plan or write one. Findings without a traced break are not recorded.
9. Where a documented claim is settleable only by looking at rendered output, mark it out of scope for this instrument and list it, so the residue is visible rather than silently dropped.

## Proposed Changes

### Findings list (new, location to be chosen alongside the existing register)
- **Logic:** One entry per traced defect: shape, path, break point, affected hosts, linked plan.
- **Edge Cases:** No reachability-based entries and no gate-is-green entries; shared-code defects labelled as such and not filed as parity gaps; out-of-scope visual claims listed separately rather than omitted.

### Gate-semantics table (new)
- **Logic:** One row per CI check — what it measures, what it does not, what it is cited for.
- **Edge Cases:** This is the artefact that prevents the fourth audit from passing on a green gate the way the third passed on catalog membership.

### Plans for residual findings
- **Logic:** One plan per defect, sized per the repo rule; prefer extending an open plan over opening a sibling.

## Verification Plan

*Per session directive, no compilation or automated-test execution is part of this plan's verification.*

1. Every optional option on the shared services is confirmed supplied by both composition roots, or its omission is documented as deliberate with a reason that survives reading the code.
2. Every finding names a traced path with an explicit break point — caller, callee, line. Zero findings rest on a verb existing, an endpoint being routed, a `{success:true}` response, a landed DB write, or a passing CI check.
3. Each of the seven defect shapes was swept for, and the sweep's result recorded even where it is "none found".
4. Findings are labelled by affected host(s); shared-code defects are not filed as standalone parity gaps.
5. Every finding links an existing plan or a newly written one — zero unattributed.
6. The four already-confirmed defects are linked, not re-planned; residual findings of their shapes were added to those plans rather than opening siblings.
7. The gate-semantics table covers every check in the CI family, and every gap between measured and cited is either a finding or explicitly none.
8. Claims settleable only by visual inspection are listed as out of scope for this instrument, with a count, so the residue is explicit.

## Recommendation

Complexity 5 → **Send to Lead Coder.** The instrument is the point: four real defects came out of a few hours of call-path tracing after three audits of clicking and curling found none of them, and planning those four found each was bigger than first traced — a fourteen-wide omission set, a third reader, a machine-global leak, a fourth doc page, and a CI gate sitting at zero on top of eighteen violations. Run it the same way — trace paths, name breaks, and record nothing that rests on something merely existing or merely passing.
