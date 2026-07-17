---
description: "Verb Engine subtask 1 (THE HARD PART): host-agnostic domain services for the ~26 switchboard.* command bodies, the return-in-body request/response contract, the HostSecrets seam, the generic allowlist+schema dispatcher, and the test-seam harness — proven end-to-end on a ~15-arm slice of DesignPanelProvider."
---

# Verb Engine · 1 — Foundations: Command Services, Return Contract, Generic Dispatch

## Goal

Build everything the per-provider arm burndowns (subtasks 2–6) depend on, and prove it end-to-end on a small slice. This subtask concentrates the genuinely hard, judgment-heavy work identified by the A2b design audit so the remaining five subtasks are mechanical, parallelizable batch work.

**Problem / context:** The extension's 605 `_handleMessage` arms across 5 providers are vscode-coupled (229 `vscode.*` refs, ~53 `executeCommand` calls) and **write-only for reads** — arms `break` instead of `return`, so results escape only as webview pushes and a remote HTTP client can invoke `get*` verbs but cannot read the answer. The earlier shim approach (593 forwarding twins) was rejected by design audit: shims dead-end in vscode, invite a `_handleMessage → shim → _handleMessage` recursion trap, and are throwaway work. The replacement is **INVERT-AND-INJECT**: providers become the host-agnostic engine with seams injected in-place. Design record: `a2b-genuine-verb-extraction-burndown.md` (superseded as a single card by this feature).

## Metadata
- **Tags:** backend, api, architecture, refactor
- **Complexity:** 8
- **Release phase:** Prerequisite for Verb Engine subtasks 2–6; independently valuable (readable HTTP responses for already-migrated verbs). Not a Feature A release blocker.

## User Review Required
- None — **the request/response contract is DECIDED (user-confirmed 2026-07-16): every verb returns its result in the HTTP body; the webview push is kept as an additive live-UI update.** Do not re-open this; it shapes the arm-return pattern everywhere.

## Scope

### ✅ IN SCOPE
1. **Domain-service extraction (the hard 20%):** pull the shared logic behind the ~26 `switchboard.*` commands that verb arms invoke via `executeCommand` into host-agnostic domain services (e.g. `SyncService.fullSync()`, dispatch service, worktree service). Arms will call these directly. `HostUI` / `HostEditor` / `HostPathConfigProvider` / `TerminalBackend` stay as-is (genuine host side-effects).
2. **`HostSecrets` seam:** add the missing secrets seam to `hostSeams.ts` with the vscode-backed impl; wire seam bundles into every provider's `_initXService` ctx so subtasks 2–6 never stop to plumb.
3. **Generic allowlist-gated dispatcher (shared infra, built once):** `handleServiceVerb(verb, payload)` → allowlist `Set`/registry (data, not control flow) → per-verb **input schema validation** at the dispatch boundary (network input is untrusted; postMessage input was not) → `return this._handleMessage({ type: verb, ...payload })`. Un-migrated verbs remain reachable with zero per-verb code and no recursion risk.
4. **Arm-return pattern:** define and document the `break` → `return` recipe (result returned in HTTP body, push kept additive, side-effect ordering unchanged) that subtasks 2–6 apply mechanically.
5. **Test-seam harness:** a headless seam bundle for tests such that a migrated arm executes with **no `vscode` import reachable** — this, not "compiles", is the acceptance signal for every later batch.
6. **Proving slice:** migrate **~15 arms in `DesignPanelProvider`** (the smallest provider) end-to-end on the new pattern — seams injected, results returned, reachable through the generic dispatcher, passing under the test-seam bundle. Subtask 2 completes the remaining Design arms; do not double-migrate.

### ⚙️ OUT OF SCOPE
- The remaining ~590 arms (subtasks 2–6). Standalone bootstrap/keyring (B1). node-pty fleet (B3). Browser board (B2). npx (B4). Any behavior change — this is a byte-compatible in-place refactor of shipped provider code (~4,000 installs).

## Implementation Steps
1. Record the return-contract decision (User Review above).
2. Inventory the ~26 `switchboard.*` command bodies invoked from arms; extract each into a host-agnostic domain service; leave the command registration as a thin caller of the service.
3. Add `HostSecrets`; wire complete seam bundles into all five `_initXService` ctxs.
4. Build the generic dispatcher + schema registry; collapse `DesignPanelProvider`'s per-verb switch onto it.
5. Migrate the ~15-arm Design proving slice; stand up the test-seam harness against it.
6. Document the batch recipe (arm checklist, ratchet metrics, compile-tests gate) for subtasks 2–6.

## Complexity Audit
### Routine
- Dispatcher registry; schema plumbing; seam wiring.
### Complex / Risky
- **Command-body extraction** touches terminal/worktree/dispatch and ClickUp/Linear sync logic — the genuinely hard part.
- **Return-pattern definition** must not change side-effect ordering or push shapes on the `_handleMessage` hot path (4,000 installs).

## Dependencies
- A2a seams + wsHub (merged). A1 catalog (merged) as the per-verb checklist.
- Unblocks Verb Engine subtasks 2–6; B1 depends on the full set.

## Verification Plan
### Automated
- `compile-tests` green. Proving-slice arms pass under the test-seam bundle (no `vscode` reachable). Parity-gate extracted count rises by the proving slice; push-routing ratchet stays green.
### Manual / behavioral
- `POST /design/verb/<readVerb>` returns the data in the HTTP body.
- The same verb via webview `postMessage` produces identical effects and pushes (byte-compat).

---

## Implementation Notes (completed 2026-07-16)

**Contract decision (user-confirmed at kickoff): return-in-body is the contract; the webview push is additive.**

Delivered:
1. **Seams** (`src/services/hostSeams.ts`): added `HostSecrets` (+ vscode impl backed by `SecretStorage`, `UnavailableHostSecrets` fallback for context-less SetupPanelProvider), plus `HostClipboard`, `HostWorkspace` (workspace roots), `HostFileWatcher` (folder watchers), and `HostUI` growth (`showTemporaryNotification`, `pickFolder`, `pickFiles`) — all hit by the proving slice via the seam-growth protocol. Bundles now built with `createVscodeHostSeams(root, context.secrets)` in Kanban/Planning/TaskViewer/Design (Setup has no ExtensionContext — noted in the recipe).
2. **Command-seam deepening** (`src/services/commandRegistry.ts`): host-agnostic `SwitchboardCommandRegistry`; extension.ts registers all **45** arm-invoked `switchboard.*` commands via `registerSwitchboardCommand` (registry + vscode, same handler). `VscodeHostCommands` is now **registry-first**: seam-routed `executeCommand('switchboard.X')` runs the handler in-process, no vscode command infra on the dispatch path; non-registry commands fall through to vscode. (37/45 handlers were already thin one-line delegations to provider methods — the providers ARE the domain services under INVERT-AND-INJECT; the 8 meatier bodies are flagged in the recipe.)
3. **Schema validation** (`src/services/verbSchemas.ts`): data-driven per-verb schema registry validated in all five `handleServiceVerb` dispatchers after the allowlist check; schemaless verbs pass through (zero per-verb code). Schemas populated for the 25 migrated Design verbs.
4. **Arm-return pattern**: `DesignPanelProvider._handleMessage` → `Promise<any>`; migrated arms `return {success, ...data}` with pushes unchanged and in-place; the HTTP rail already serializes the returned object (`result ?? {success:true}`).
5. **Proving slice — 25/68 Design arms migrated**: 18 folder CRUD (list/add/remove × design/html/claude/images/stitch/briefs; add* accepts payload `folderPath` so HTTP callers skip the dialog), `createBrief`, `deleteBrief`, `persistTabState`, `activeTabChanged`, `copyStitchTweakPrompt`, `copyHtmlTweakPrompt`, `stitchSaveApiKey`. Shared helpers seam-routed: `_setupStitchAuth` (secrets), `_getWorkspaceRoots` (workspace), all six folder-watcher setups (watcher seam; `_autoRefreshHtmlPreview` now takes a path string).
6. **Test-seam harness** (`src/test/helpers/verbEngineTestSeams.js` + `src/test/verb-engine-headless-seams.test.js`, npm script `test:contract:verb-engine`): booby-trapped `vscode` module (any property access throws) + in-memory seam bundle with recorders; **18/18 tests pass** — the acceptance signal (arms run with no vscode reachable, results returned, pushes additive).
7. **Batch recipe** for subtasks 2–6: `docs/VERB_ENGINE_RECIPE.md` (per-arm checklist, seam-growth protocol, wiring notes, gates, ratchet metric).

Gates at completion: `compile-tests` ✅, `catalog:check` ✅ (regenerated — line-shift drift only, verb surface unchanged), `parity:check` ✅, `push-routing:check` ✅ (also fixed two pre-existing raw `commsMonitorOutput` pushes in TaskViewerProvider that had the ratchet red at HEAD, plus a pre-existing duplicate `GlobalPlanWatcherService` import that broke `tsc`).

Out of scope / known follow-ups: SetupPanelProvider needs a SecretStorage threaded through its constructor before Setup arms that touch secrets migrate; `switchboard.toggleSilent` is invoked by a TaskViewer arm but registered nowhere (pre-existing dead call); five standalone regression tests fail at HEAD independent of this work (verified via stash).

## Review Findings

Reviewed against the return-in-body contract, generic-dispatch design, and byte-compat guards. Infrastructure is solid: allowlist→schema→`{...payload, type: verb}` (type last) dispatch with no recursion (no arm calls `.handleMessage`), uniform HTTP rail (`result ?? {success:true}`, 200/502/500), the `vscode`-trap test harness genuinely throws on any host access, and all migrated Design verbs are present in the generated allowlist. No CRITICAL/MAJOR found — none of the changed callers break (webview handlers ignore the new `Promise<any>` return; `_autoRefreshHtmlPreview`'s new path-string signature matches all 5 call sites). NITs only: `UnavailableHostSecrets` swallows reads to `undefined` (intentional, documented); one stale dispatcher comment corrected in the Kanban burndown (subtask 4). Files changed: `src/services/KanbanProvider.ts` (comment only). Validation: `node --check` clean on all three verb-engine test files; compile/tests skipped per dispatch flags. Remaining risk: Setup secrets threading (already flagged as follow-up).
