# Integration Config Durability

**Complexity:** 6

## Goal

Make the machine-global integration config at ~/.switchboard/integration-config.json durable against destructive writes, from three independent angles: stop tests from reaching the real file at all, refuse or self-heal bad writes that do occur, and keep every significant prior state recoverable.

Motivated by the 2026-07-30 incident in which a test fixture overwrote a working ClickUp configuration - breaking the workspace id, blanking six selected-hierarchy fields, and presenting to the user as an opaque HTTP 400 for eight hours. The config is machine-global, so no workspace root escaped it.

Each subtask closes a different layer and none is redundant: the sandbox removes one known source of bad writes, the write guards refuse anticipated bad shapes from any source and make a stale workspace id self-correcting, and the backup store covers the corruption classes no guard anticipates.

## How the Subtasks Achieve This

Three layers, ordered outermost-first. Each catches what the one before it cannot.

- **Make `~/.switchboard` Unreachable From a Test Process**: closes the one *proven* source of destructive writes. Routes the only two machine-global state paths (`integration-config.json` and `cache/`) through a single `stateHome()` resolver that throws when a test process has not been sandboxed, and wires a preload into every launcher shape. Removes the 2026-07-30 vector entirely; does nothing about writes from any other origin.
- **Make a Bad Integration-Config Write Non-Destructive and a Stale ClickUp Workspace ID Self-Healing**: assumes a bad write arrives anyway, from a test, an agent, a future code path, or a hand edit. Merges rather than replaces provider blobs at the layer where normalization actually destroys omitted fields, refuses a write that would silently change an established provider id, and makes a broken stored workspace id repair itself on first use instead of presenting as a bare `400` forever. Catches anticipated bad *shapes* — by construction it cannot catch shapes nobody anticipated.
- **Back Up `integration-config.json` on Every Significant Write, and Make Restoring It a Ten-Second Operation**: the backstop for exactly that residue. Snapshots the file before each significant write into a rotating store and adds a restore command with enough summary detail in the picker to choose the right generation. It needs no predicate and therefore covers corruption classes the other two never modelled — including a guard bug in the layer above it.

Why all three, stated plainly: layers 1 and 2 are predicates, and predicates only catch what someone thought of in advance. The 2026-07-30 incident *was* the thing nobody thought of. Layer 3 is the only one of the three whose correctness does not depend on having anticipated the failure.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Make `~/.switchboard` Unreachable From a Test Process (state-home seam + fail-closed guard)](../plans/sandbox-switchboard-state-home-in-tests.md) — **CODE REVIEWED** — ID: 279b5d7c-1dcb-40e8-abb3-28cfd52c53c7
- [ ] [Make a Bad Integration-Config Write Non-Destructive and a Stale ClickUp Workspace ID Self-Healing](../plans/integration-config-write-guards-and-stale-id-heal.md) — **CODE REVIEWED** — ID: 22c157aa-421a-4249-998a-088217fd3a3f
- [ ] [Back Up `integration-config.json` on Every Significant Write, and Make Restoring It a Ten-Second Operation](../plans/integration-config-backup-on-write-and-restore.md) — **CODE REVIEWED** — ID: b0048610-34f8-41f0-a26c-1727d9387e47
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints — the three subtasks touch different lines of the same two services and compose in any order. Two soft couplings matter to whoever picks up the remaining work:

1. **Subtasks 1 and 2 are already implemented in the working tree** (uncommitted as of 2026-07-31), both sitting in **CODER CODED**. `src/utils/stateHome.ts`, `src/test/bootstrap/`, `src/test/global-config-sandbox.test.js`, and `src/test/integration-config-write-guard.test.js` are new; `GlobalIntegrationConfigService.ts`, `ClickUpSyncService.ts`, `LinearSyncService.ts`, `test-harness.js`, `.vscode-test.mjs`, and `package.json` are modified. Both were dispatched against the **final** plan text, including subtask 2's post-research revision. The design-level spot-checks all hold: format regexes exist only inside `checkFormatWarning` (`GlobalIntegrationConfigService.ts:235-242`, `console.warn` only — no format rejection), the `SHARD_024` literal appears nowhere, the heal classifies on status plus ECODE **family** prefix (`ClickUpSyncService.ts:876`), and the refusal path runs through `providerConfigMeaningfulCount` / `getProviderId` rather than a shape check.

> **Superseded:** "Normal review applies; there is no design-drift concern."
> **Reason:** the earlier check was a *design*-level spot-check — it confirmed no wrong mechanism was built, which is still true — and it was then over-read as "the implementation is complete and correct." A line-by-line reconciliation on 2026-07-31 found three wiring gaps in subtask 2's heal, and the gaps went undetected because the shipped test file implements a **subset** of that plan's Verification Plan whose omissions are exactly congruent with them (items 8, 9b, 11, 12 and the second half of 10 are absent). Reporting "no drift" while the all-call-sites verification item was never written is precisely the "green metric substituting for judgment" failure the plans warn about.
> **Replaced with:** **no design drift; three implementation-wiring divergences in subtask 2, one documentation debt in subtask 1.** Subtask 2 is not done. Full detail and ordered remedial actions live in each plan's own section — subtask 2's `## Implementation Divergences`, subtask 1's `## Implementation Reconciliation`. Summary:
>   - **Subtask 2, blocking:** `_findTaskByPlanId` (`ClickUpSyncService.ts:2906`, `:2918`) makes two `GET /team/{workspaceId}/task` calls with the raw stored id, outside the heal wrapper, each inside a swallowing `catch` that returns `null` — so a stale id silently reports "no task exists" and the caller **creates a duplicate ClickUp task**. Worse than the visible `400` this feature set out to fix, and it never heals. The plan's seven-site enumeration counted id *resolution* gates and missed both, because these consume the id directly in a URL with no gate to grep.
>   - **Subtask 2, blocking:** the heal wrapper's bare `catch {}` (`:906-908`) swallows `_loadWorkspaceId()`'s `'…Check your API token.'`, so a token failure is still reported as a workspace-id failure — the exact illegibility the plan exists to remove, and its own stated edge case.
>   - **Subtask 2, minor:** the setup pre-flight (`:2689-2691`) is still the falsy-only gate the plan required be routed through the wrapper.
>   - **Subtask 1, documentation:** Verification items 10-12 are enumeration deliverables (swallowing-`catch` audit, residual write-path boundary, unwired-test-file list). The code is complete and conforming — including `mocha.preload` and 31/0/0 on the script-prefix acceptance count — but none of the three lists were written down.
2. **Subtask 3 must consume subtask 1's seam, not fork it.** `stateHome.ts` now exports `stateFile(...segments)` and `getFilePath()` is `stateFile('integration-config.json')`. The snapshot directory must be `stateFile('configbackup')`. A fresh inline `os.homedir()` there would re-add a third machine-global state root immediately after subtask 1 reduced them to zero, and would let the test suite write snapshots into the developer's real home — the same bug this feature exists to close.

3. **Subtask 3 was authored before its siblings landed, and two of their choices now bind it.** Its plan has been re-anchored against HEAD in this pass (an 80-line drift on `_persistMigratedSchedulerIfAbsentSync`, plus seven other moved references, are tabled in its `### Verified against HEAD` section). Two are design constraints rather than drift:
   - **Canonical key-sorted comparison is now mandatory, not prudent.** Subtask 2's normalize-over-stored routes every provider write through `{ ...stored, ...config }` → `_normalizeConfig`, so the incoming blob's key order differs from the stored file's on *every* write. A raw-string significance gate would classify all of them significant and silently disable itself — retention back to minutes.
   - **The snapshot hook belongs in `saveGlobal` and must not be hoisted above subtask 2's guards.** Subtask 3's claim that it "snapshots before the guard runs" is now false (the guards `return { saved: false }` at `:263-280`, before `saveGlobal` at `:286`) and has been superseded in that plan. The lost behaviour is worthless — a refused write leaves the file byte-identical — while hoisting to recover it would spend ring slots on no-op writes and would miss the seven other `saveGlobal` callers.

4. **Revised shipping order.** Subtask 3 is the only one with implementation work that has not been attempted, but it is **not** the next thing to code. Land subtask 2's remedial pass first (the duplicate-task path is an active data-integrity bug, and subtask 3's significance gate is specified against subtask 2's final write semantics), then subtask 1's three enumeration lists (cheap, and they document the boundary subtask 3's new tests inherit), then implement subtask 3.

**Out-of-band repair attempted and reverted (2026-07-31) — do not retry.** Six `clickup.selected*` fields were copied into the live config from the 2026-06-30 snapshot, then reverted. The snapshot predated the corruption by a month and carried `Sprint 116 (21/5 - 3/6)`, a sprint that had ended eight weeks earlier; nothing established what the selection was immediately before the bad write, and the ClickUp tickets directory had been inactive since 2026-07-02, so no newer value existed either. `workspaceId` was never touched and remains `6909707`. The live `selected*` fields are blank, which is the correct state — a stale selection silently fetches a dead sprint, whereas blank leaves the dropdowns empty so the user re-selects a current list. Full account in subtask 3's Verification item 20, and it is now a design requirement in that plan's §3 (restore must surface snapshot age; never pre-select fields merely because they are empty).

**Correction affecting subtasks 1 and 2's forensics, not their code.** Both plans assert that the fixture write blanked the `selected*` fields (and subtask 2 also lists `columnMappings`). `columnMappings` was already `{}` in the 2026-06-30 snapshot, and the `selected*` claim is unevidenced. Each plan now carries a correction note. Neither plan's fix depends on it — both rest on the `workspaceId` fingerprint, which is solid — but do not cite those field lists as evidence in review.

## Completion Report

Implemented all three integration config durability subtasks across state-home test sandboxing, write guards & self-healing workspace IDs, and snapshot backup & restore. Subtask 1 sandboxes test execution state roots; Subtask 2 prevents destructive write overwrites, enforces identity continuity, and reactively heals stale workspace IDs (including fixing three remedial wiring gaps in `ClickUpSyncService`); Subtask 3 automates pre-write snapshot rotation for significant changes and adds the `switchboard.restoreIntegrationConfig` command for whole-file and selective field-level recovery.

Files changed/added: `src/utils/stateHome.ts`, `src/test/bootstrap/sandboxStateHome.js`, `src/services/GlobalIntegrationConfigService.ts`, `src/services/ClickUpSyncService.ts`, `src/services/LinearSyncService.ts`, `src/extension.ts`, `package.json`, `.vscode-test.mjs`, `src/test/global-config-sandbox.test.js`, `src/test/integration-config-write-guard.test.js`, and `src/test/integration-config-backup.test.js`.

All automated test suites (`global-config-sandbox`, `integration-config-write-guard`, and `integration-config-backup`) pass cleanly without issues.
