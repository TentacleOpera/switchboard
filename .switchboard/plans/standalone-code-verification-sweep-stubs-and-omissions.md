# Standalone Parity by Code Verification — Sweep for Stubs, Omitted Wiring and Discarded Values

## Metadata

**Complexity:** 5
**Tags:** standalone, parity, verification, audit
**Project:** Browser Switchboard

## Goal

Answer the standalone parity question by reading code rather than clicking UI: for every capability the docs describe, confirm a real implementation exists and is actually reached in the standalone composition root. The deliverable is a defect list, not a register of verdicts.

### Problem analysis and root cause

Three parity efforts have now been declared complete and none answered the question. The first two passed on `{success: true}`. The third (`standalone-vs-extension-doc-parity-audit`) passed on catalog membership — 178 of its 286 `LIVE` rows cite *"verb available"* or *"in catalog"*, which is verb reachability and handler presence, the criterion its own evidence rules banned. Its register now records its own quality gate as FAILED.

The recurring cause is not carelessness. It is that **every instrument used so far measured reachability**, and in this codebase reachability is guaranteed independently of whether a feature works: `bootstrap.ts`'s `kanbanVerb` `default:` arm delegates every unmatched verb to `KanbanProvider.handleServiceVerb`, so every verb answers and every write lands whether or not the capability behind it exists.

The instrument that does work is code reading — and this is demonstrated, not assumed. A short review pass over the failed audit found four real defects by tracing call paths, none of which any of the three audits caught:

1. **An optional callback never passed.** `LocalApiServer` takes `moveCard` as optional (`:47`) and 503s without it (`:1322-1325`); `bootstrap.ts` never passes it. `POST /kanban/move` is dead in standalone.
2. **A write no reader consults.** `handleToggleKanbanColumnVisibility` (`TaskViewerProvider.ts:10604-10611`) stores `visibleAgents[columnId]` for custom columns; `_filterVisibleColumns` (`:3854-3866`) and `_buildSetupKanbanStructure` (`:3868-3900`) both hardcode custom columns visible.
3. **Values computed then discarded.** ~19 read verbs push their value to the webview and `return { success: true }`, inverting the contract documented at `local-api-server.md:171`.
4. **A retired feature still documented.** `planAutoFetch` was deleted in `4d335c3c` and replaced by a Scheduler source; three doc pages still describe it as live.

Each has a distinct signature that is invisible to reachability testing and obvious in the code. That is the case for this plan: not a more thorough audit, but the instrument matched to the defect class.

### The five defect shapes to hunt

The sweep is defined by what it looks for. Each shape is drawn from a confirmed instance above, so none is speculative:

| Shape | Signature in code | Confirmed instance |
|---|---|---|
| **Omitted wiring** | An optional constructor/option callback consumed by a guard that fails closed, never supplied by one composition root | `moveCard` |
| **Orphan write** | State written under a key no reader consults, or read under a different key than it is written | custom column visibility |
| **Discarded value** | A value resolved, side-channelled (push/postMessage), then dropped from the return | ~19 `get*` verbs |
| **Retired-but-documented** | Docs describe a capability whose implementation was deleted or replaced | `planAutoFetch` |
| **Literal standing in for live state** | A hardcoded constant where the extension reads real state | *(previously present in the standalone state builders; fixed — this shape is the reason the class is on the list)* |

The fifth shape is included precisely because it was the dominant defect class three weeks ago and has since been fixed (`bootstrap.ts:394/403/417/427/446` now delegate to `getFullStateMessages`). It stays on the list as a regression class, not an open finding.

## User Review Required

None.

## Complexity Audit

### Routine

- Grepping for each signature.

### Complex / Risky

- **Reachability must not be counted, at all.** The prior audit's failure is repeatable by anyone who records "verb exists" as evidence. A finding here is a **traced path with a named break** — which caller, which callee, where the value or control flow stops. Anything less is not a finding.
- **Both composition roots must be compared, not just standalone read.** Every one of the four confirmed defects was found by asking "what does the extension do here that standalone does not, or vice versa?" A sweep that only reads `bootstrap.ts` finds omitted wiring but misses shapes 2, 3 and 4, which are in **shared** code and affect both hosts. Two of the four confirmed defects are not standalone-specific at all — do not assume the defect class is browser-only, and do not file a shared defect as a parity gap.
- **The optional-option surface is the highest-yield place to start.** `LocalApiServer`'s options object is where shape 1 lives by construction: an omitted option is a valid object, so nothing fails at boot or compile. Enumerate every optional option and check both roots supply it.
- **Scope discipline.** This sweep produces defects, not verdicts, and not a register. The previous attempt's 387-row register is a genuine asset — the doc claims are enumerated and the corpus arithmetic is confirmed correct (61 files / 3,555 lines). Reuse it as the **claim list** to sweep against; do not re-derive it and do not re-verdict it row by row, which is what made the last pass unaffordable and unfinished.
- **Do not add browser automation.** Explicitly out of scope. Where a claim genuinely cannot be settled by reading code — a rendering or layout claim — record it as out of scope for this instrument and move on, rather than expanding the plan.

## Edge-Case & Dependency Audit

**Race Conditions** — none introduced; the sweep is read-only.

**Security** — the sweep reads configuration and secret-handling paths. Record the shape of a defect, never a credential value.

**Side Effects** — none. No host is driven, no workspace mutated.

**Dependencies & Conflicts** — the four confirmed defects already have plans: `standalone-kanban-move-endpoint-not-wired.md`, `custom-column-visibility-toggle-writes-state-no-reader-consults.md`, `read-verbs-return-bare-ack-violating-documented-http-contract.md`, `docs-still-document-retired-plan-autofetch.md`. This sweep must not re-plan them; it extends the list. `standalone-kanban-column-parity-audit.md` separately owns next-column resolution.

## Dependencies

- The existing register at `.switchboard/audits/standalone-extension-parity.md` — used as the enumerated claim list, with its verdict column ignored.

## Implementation

1. Enumerate every optional option on `LocalApiServer` and any other service constructed by both roots; confirm each is supplied in both, or that its absence is deliberate and stated. `moveCard` is the known instance; find the rest.
2. Sweep for orphan writes: state keys written by one handler and read by another under a different derivation. Start with `visibleAgents` and any other `Record<string, boolean>` state map keyed differently by writer and reader.
3. Sweep every `get*` verb arm across all panel providers for the push-then-bare-ack shape.
4. Cross-check the doc corpus against the tree for retired-but-documented capabilities: for each documented settings family or named control, confirm a live implementation. `planAutoFetch` is the known instance.
5. Re-check the literal-standing-in-for-live-state class against `bootstrap.ts` to confirm the fixed builders have not regressed.
6. For each finding, record the traced path — caller, callee, and the exact line where control or data stops — and either link an existing plan or write one. Findings without a traced break are not recorded.
7. Where a documented claim is settleable only by looking at rendered output, mark it out of scope for this instrument and list it, so the residue is visible rather than silently dropped.

## Proposed Changes

### Findings list (new, location to be chosen alongside the existing register)
- **Logic:** One entry per traced defect: shape, path, break point, affected hosts, linked plan.
- **Edge Cases:** No reachability-based entries; shared-code defects labelled as such and not filed as parity gaps; out-of-scope visual claims listed separately rather than omitted.

### Plans for residual findings
- **Logic:** One plan per defect, sized per the repo rule; link rather than duplicate where a plan exists.

## Verification Plan

1. Every optional option on the shared services is confirmed supplied by both composition roots, or its omission is documented as deliberate.
2. Every finding names a traced path with an explicit break point — caller, callee, line. Zero findings rest on a verb existing, an endpoint being routed, a `{success:true}` response, or a landed DB write.
3. Each of the five defect shapes was swept for, and the sweep's result recorded even where it is "none found".
4. Findings are labelled by affected host(s); shared-code defects are not filed as standalone parity gaps.
5. Every finding links an existing plan or a newly written one — zero unattributed.
6. The four already-confirmed defects are linked, not re-planned.
7. Claims settleable only by visual inspection are listed as out of scope for this instrument, with a count, so the residue is explicit.
8. `npx tsc --noEmit` and `npm run icons:parity` are run and their results recorded against the pre-existing baseline (5 `TS2835` errors at HEAD; icons parity passing).

## Recommendation

Complexity 5 → **Send to Lead Coder.** The instrument is the point: four real defects came out of a few hours of call-path tracing after three audits of clicking and curling found none of them. Run it the same way — trace paths, name breaks, and record nothing that rests on something merely existing.
