---
description: "Verb Engine subtask 2: complete DesignPanelProvider — migrate its remaining ~47 arms in place onto seams with returned results, finish collapsing its dispatch, delete its shims. First full provider on the pattern proven in subtask 1."
---

# Verb Engine · 2 — DesignPanelProvider Burndown (62 arms)

## Goal

Make every `DesignPanelProvider` verb host-agnostic: all ~62 arms run on injected seams, return their results in the HTTP body (push kept additive), and dispatch through the generic allowlist+schema registry. Subtask 1 already migrated a ~15-arm proving slice and collapsed the switch — this subtask finishes the provider and deletes its shim methods.

**Problem / context:** Design is the smallest provider (62 arms) and the designated proving panel, so it goes first — any friction in the batch recipe (seam gaps, return-pattern surprises, ratchet false-positives) surfaces here at the lowest cost before the three big providers. See `a2b-verb-engine-01-foundations.md` for the pattern and `a2b-genuine-verb-extraction-burndown.md` for the design record.

## Metadata
- **Tags:** backend, refactor, api
- **Complexity:** 5
- **Release phase:** After Verb Engine 1. May run in parallel with other provider subtasks (strictly one agent stream per provider file — same-file edit collisions are the known hazard).

## User Review Required
- None — contract and pattern fixed in subtask 1.

## Scope

### ✅ IN SCOPE
- Migrate the remaining ~47 arms in place: `vscode.*` / `executeCommand` / raw `postMessage` → seam / domain-service / broadcaster calls; add `return` of each arm's result without reordering side effects.
- Verify the provider's dispatch is fully on the generic registry; add any missing per-verb input schemas.
- **Delete** `designService`'s string-keyed shim methods (unreleased dev work — clean break); keep only genuinely shared domain logic.
- Add a seam only if an arm hits an uncovered host surface (stop, add to `hostSeams.ts`, wire into every `_initXService` ctx, resume).

### ⚙️ OUT OF SCOPE
- Other providers. New verbs or behavior changes (byte-compatible refactor of shipped code).

## Implementation Steps
1. Batch the remaining arms ~20–30 at a time; migrate in place per the subtask-1 recipe.
2. `compile-tests` gate between batches; merge incrementally.
3. Delete the shim methods once all arms are migrated; confirm the parity gate reports Design at 62/62 genuinely extracted, 0 shims.

## Complexity Audit
### Routine
- Mechanical seam swaps for arms with no coupling beyond the 5 seams.
### Complex / Risky
- Arms invoking extracted command services — verify equivalence against the pre-extraction behavior.
- Reply timing / push shapes must not drift (provider tests must pass unchanged).

## Dependencies
- Verb Engine 1 (seams, dispatcher, return contract, test harness).

## Verification Plan
### Automated
- Provider tests pass unchanged. All 62 arms pass under the test-seam bundle (no `vscode` reachable). Ratchet: 62/62, 0 shims.
### Manual / behavioral
- Sample `POST /design/verb/<name>` calls return results in-body and match the webview path's effects.
