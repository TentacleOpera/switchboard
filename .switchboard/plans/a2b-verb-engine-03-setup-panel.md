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
