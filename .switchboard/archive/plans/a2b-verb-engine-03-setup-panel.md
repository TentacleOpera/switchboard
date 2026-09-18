---
description: "Verb Engine subtask 3: SetupPanelProvider burndown — migrate its 117 arms in place onto seams with returned results, collapse its dispatch onto the generic registry, delete its shims. Config/token/integration surface; heavy HostSecrets and config-seam use."
---

# Verb Engine · 3 — SetupPanelProvider Burndown (117 arms)

## Goal

Make every `SetupPanelProvider` verb host-agnostic: all 117 arms run on injected seams, return their results in the HTTP body (push kept additive), and dispatch through the generic allowlist+schema registry; the provider's shim methods are deleted.

**Problem / context:** Setup is the configuration surface — API tokens (ClickUp/Linear/Notion/Stitch), git-ignore strategy, protocol targets, Remote Control config, database/multi-repo management. Its arms lean on `SecretStorage` and `workspace.getConfiguration` more than any other provider, making it the natural second provider: it exercises `HostSecrets` and `HostPathConfigProvider` hard while still being mid-sized. See `a2b-verb-engine-01-foundations.md` for the pattern and `a2b-genuine-verb-extraction-burndown.md` for the design record.

## Metadata
- **Tags:** backend, refactor, api, security
- **Complexity:** 6
- **Release phase:** After Verb Engine 1. Parallelizable with other provider subtasks (one agent stream per provider file).

## User Review Required
- None — contract and pattern fixed in subtask 1.

## Scope

### ✅ IN SCOPE
- Migrate all 117 arms in place: `vscode.*` / `executeCommand` / raw `postMessage` → seam / domain-service / broadcaster calls; add `return` of each arm's result without reordering side effects.
- Token read/write arms route through `HostSecrets` exclusively — no direct `SecretStorage` access left in any arm.
- Collapse the provider's per-verb switch onto the generic registry; add per-verb input schemas (config writes and token writes are the highest-risk untrusted inputs on this provider — schema-validate strictly).
- Delete `setupService`'s string-keyed shims; keep genuinely shared domain logic only.
- Add seams on first uncovered host surface (stop, add, wire everywhere, resume).

### ⚙️ OUT OF SCOPE
- Other providers. Standalone secret backends (keyring/encrypted-file — that's B1). New verbs or behavior changes.

## Implementation Steps
1. Batch ~20–30 arms; migrate in place per the subtask-1 recipe; `compile-tests` gate between batches.
2. Sweep the provider for residual direct `SecretStorage` / `getConfiguration` calls inside arms; route through seams.
3. Delete shims; confirm parity gate reports Setup at 117/117, 0 shims.

## Complexity Audit
### Routine
- Mechanical seam swaps; schema additions for simple toggles.
### Complex / Risky
- **Secret-handling arms** — a regression here leaks or bricks tokens; provider tests plus a manual token round-trip are mandatory.
- Remote Control config arms interact with `RemoteControlService` state in the kanban DB — verify start/stop and config persistence are unchanged.

## Dependencies
- Verb Engine 1 (seams incl. `HostSecrets`, dispatcher, return contract, test harness).

## Verification Plan
### Automated
- Provider tests pass unchanged. All 117 arms pass under the test-seam bundle. Ratchet: 117/117, 0 shims.
### Manual / behavioral
- Token save → validate → use round-trip for one provider (e.g. Linear) behaves identically via webview and via `POST /setup/verb/<name>`.
- Remote Control start/stop from the Setup tab unchanged.

## Review Findings

Reviewer pass 2026-07-17. Files changed by review: `SetupPanelProvider.ts` (comment now documents the gap honestly; the implementation's `config.get`→`pathConfig.getConfigString` and the `showQuickPick` cast were verified correct — no regression). **Verdict: SUBSTANTIALLY INCOMPLETE.** The return-in-body contract is NOT applied (`analyze`: return=2, break=123 across 113 arms) — read verbs push over the WS hub and `break`, so HTTP callers receive `{success:true}` with no data, the exact "write-only reads" anti-pattern A2b was created to eliminate. Per-verb schemas are absent (`verbSchemas.ts` has `setup: {}`), so `validateVerbPayload('setup', …)` is a no-op — this violates ·3's explicit `security` requirement to strictly schema-validate the highest-risk token/config writes. No headless arm test exists for Setup, leaving "all 117 arms under the test-seam bundle" unproven (also: the real catalog count is **113**, not 117). Done correctly and green: vscode=0 inside the switch, generic dispatcher, `parity`/`push-routing`. These gaps are the unfinished bulk of the subtask, not review-scale fixes — mass-converting 123 arms and authoring token-write schemas blind (compile/tests skipped, byte-compat on ~4,000 installs) would be reckless, so they are flagged rather than force-fixed.
