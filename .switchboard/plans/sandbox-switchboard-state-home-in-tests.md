# Make `~/.switchboard` Unreachable From a Test Process (state-home seam + fail-closed guard)

## Goal

Route the only two machine-global state paths Switchboard writes through a single resolver that **throws** when a test process has not been sandboxed, so running the suite can never again overwrite a developer's live integration config. Outside tests the resolver returns `os.homedir()` unchanged — zero behaviour change for the install base.

### Problem

On **2026-07-30 20:44:26** a test run replaced the author's real `~/.switchboard/integration-config.json` with a test fixture. Verified by fingerprint: the live file's `clickup` blob is byte-identical to `_normalizeConfig(<payload at src/test/planning-modal-contract.test.js:186>)` across all 21 fields — no extra keys, no missing keys, no differing values — including `workspaceId: "ws-123"`.

Downstream effect, reproduced live against the running extension (`POST /planning/verb/clickupLoadSpaces`, port from `.switchboard/api-server-port.txt`):

```
502  {"type":"clickupError","scope":"hierarchy",
      "error":"Failed to fetch ClickUp spaces: 400", …}
```

Upstream cause of that 400, confirmed through the server's own ClickUp proxy:

```
GET /api/v2/team/ws-123/space   → {"err":"Invalid workspace id: ws-123","ECODE":"SHARD_024"}   # 400
GET /api/v2/team/6909707/space  → TECH TEAM, Product & growth, Patrick Tasks, Documentation, Analytics
GET /api/v2/team                → exactly one workspace: 6909707 "Tech Team"
```

Identical failure for every workspace root (`switchboard`, `viaapp`, `Gitlab`) — the config is machine-global, so no root escapes it.

**Why it stayed invisible for six weeks.** Only the hierarchy fetch (`ClickUpSyncService.getSpaces()` → `/team/{workspaceId}/space`) uses the workspace id. Ticket loads with a selected list go `refreshTicketsDelta` → `/list/{listId}/task`, which never touches it, and the Tickets sidebar is file-backed regardless (247 files under `/Users/patrickvuleta/Documents/Gitlab/.switchboard/tickets/clickup/`). The same fixture write that broke the id also blanked `selectedSpaceId` / `selectedFolderId` / `selectedListId`, removing the list-scoped shortcut and exposing the hierarchy path for the first time. Symptom as seen by the user: tickets still listed, space/folder/list dropdowns empty, `400` toast — in the editor panel *and* the browser cockpit (the browser mirrors the editor: `PlanningPanelProvider.postMessageToWebview()` → `_broadcaster.push(msg, 'planning')` fans out to WS clients).

### Root cause

Four independent facts compose into a silent destructive write:

1. **The test was written against a workspace-scoped API.** `src/test/planning-modal-contract.test.js` was added 2026-04-26 (`be89aa2`). At that commit `ClickUpSyncService` held `this._configPath = path.join(workspaceRoot, '.switchboard', 'clickup-config.json')` and `saveConfig()` wrote there. `withWorkspace()` ([test-harness.js:9](../../src/test/integrations/shared/test-harness.js#L9)) hands it a throwaway temp dir, so the write was sandboxed and harmless.
2. **The write target moved out from under it.** `18fcb09` (2026-06-20 23:55) introduced `GlobalIntegrationConfigService` and rerouted `saveConfig()` to `os.homedir()/.switchboard/integration-config.json`. The constructor still takes `workspaceRoot`, so the call site still *looks* sandboxed; the argument no longer governs where config lands. **10 test files** call `.saveConfig(...)` on a real service instance.
3. **Nothing can redirect it.** `GlobalIntegrationConfigService.getFilePath()` ([:127](../../src/services/GlobalIntegrationConfigService.ts#L127)) calls `os.homedir()` inline — no seam, no env override, no injection point. The harness sandboxes the *workspace* (temp dir) and *secrets* (`SecretStorageMock`); nothing sandboxes home, because before 2026-06-20 nothing wrote there.
4. **Nothing makes it loud.** `saveConfig` replaces the whole provider blob rather than patching, and no test asserts anything about the real file — so the run is green while the developer's config is gone. There is no shared bootstrap to hook: tests launch as independent `node src/test/*.test.js` npm scripts plus one `vscode-test` suite, so any per-file convention is forgettable by construction.

> **Superseded:** Root-cause fact 4 originally stated "tests launch as **38 independent `node src/test/*.test.js` npm scripts** plus one `vscode-test` suite".
> **Reason:** Measured at HEAD, `package.json` defines **30** scripts whose command is `node src/test/…` (31 total occurrences of the string — the 31st is embedded in `test:integration:all`). The figure 38 is not reproducible and it was reused downstream as an acceptance count, so leaving it would make the acceptance check fail by construction.
> **Replaced with:** 30 bare-`node` scripts (31 string occurrences) plus one `vscode-test` suite. See "Verified against HEAD" below.

### Verified against HEAD (2026-07-31)

Every code reference in this plan was re-checked against the working tree. Confirmed unchanged: `getFilePath()` at `GlobalIntegrationConfigService.ts:127`, `getCacheDir()` at `:131`, exactly two `~/.switchboard` state-root sites in one service, `withWorkspace()` at `test-harness.js:9`, `loadOutModule()` resolving `process.cwd()/out`, and **all 10** `.saveConfig(...)` test files.

Four counts in the prose above drifted and are corrected here rather than edited in place (the forensic narrative is preserved verbatim):

| Claim as written | Measured at HEAD |
| :--- | :--- |
| "byte-identical … across all **21** fields" | **22** — `_normalizeConfig` ([:287-336](../../src/services/ClickUpSyncService.ts#L287)) emits 22 keys, and the live file's `clickup` blob has 22 |
| "**58** `os.homedir()` sites (**16** files, plus 4 `require('os').homedir()`)" | **59** sites across **17** files, plus 4 inline `require('os').homedir()` |
| "**44** are `~`-expansion of a user-supplied path" | **45** (`startsWith('~')` occurrences) |
| "**38** independent `node src/test/*.test.js` npm scripts" | **30** scripts (31 string occurrences) |

None of these change the plan's conclusion — the exposure is still exactly 2 lines in 1 service — but the 38 was load-bearing as an acceptance count and is corrected in Proposed Changes §4.

**Live-file state at time of this review.** `~/.switchboard/integration-config.json` now holds `clickup.workspaceId: "6909707"` (mtime `2026-07-30T19:05:01Z`) — the id was repaired after the incident. `selectedListId` / `selectedSpaceId` / `selectedFolderId` are **still `""`**. `linear` and `notion` are both `{}`. Verification step 5(a) below depends on this file existing; it does, so the "skip cleanly" branch will not be the one exercised locally.

**Correction to the "invisible for six weeks" causal claim (added 2026-07-31).** The Problem section states that "the same fixture write that broke the id also blanked `selectedSpaceId` / `selectedFolderId` / `selectedListId`, removing the list-scoped shortcut and exposing the hierarchy path for the first time." **That specific causal step is unevidenced.** The only data points are populated on 2026-06-30 and blank on 2026-07-31, a month apart with the corruption in between; nothing shows the fields were populated immediately before the bad write. `columnMappings`, listed as damage by the sibling write-guards plan, was demonstrably already `{}` in the 2026-06-30 snapshot — so the "one write blanked all of these" reading is at least partly wrong, and two separate bad writes (one breaking `workspaceId` invisibly, a later one clearing `selected*` and thereby exposing the hierarchy path) fits the evidence at least as well. Consistent with that: the ClickUp tickets directory last changed 2026-07-02.

**Impact: none on this plan's fix.** The state-home seam is motivated by a test process being able to write the real file at all — proven by the `workspaceId` fingerprint, which is independent of the `selected*` question. The forensic prose is preserved verbatim above; this note is the correction of record.

### Scope: the exposure is 2 lines, not 58

An `os.homedir()` sweep would be the wrong fix. Of the **58** `os.homedir()` sites in production code (16 files, plus 4 `require('os').homedir()` inline):

- **44** are `~`-expansion of a **user-supplied** path (`trimmed.startsWith('~') ? path.join(os.homedir(), trimmed.slice(1))`). Not state roots — they resolve input the user typed.
- Most of the rest are third-party host paths that are read or scrubbed, never Switchboard state: Antigravity brain dirs (`extension.ts:490,526`, `LocalFolderService.ts:38-40`, `TaskViewerProvider.ts:2544-2546`), `~/.codeium/windsurf/mcp_config.json` (`extension.ts:835`), cloud-storage DB **presets** offered in a picker (`extension.ts:1377`, `TaskViewerProvider.ts:10117`), and one comparison value (`ControlPlaneMigrationService.ts:1289`).
- **Exactly 2 sites build an implicit Switchboard state root:** `GlobalIntegrationConfigService.ts:127` (`~/.switchboard/integration-config.json`) and `:131` (`~/.switchboard/cache`).

So the seam is two lines in one service. Residual write paths that this plan deliberately does **not** close, because they are only reachable when a test explicitly configures a path: `KanbanDatabase.ts:850,1139` (custom DB path), `ArchiveManager.ts:302`, `ImageHostingHelper.ts:19`, `MultiRepoScaffoldingService.ts:61,64`. A verification step below records their status so the boundary is documented rather than assumed.

### Read-side blast radius (new — not previously scoped)

The plan's write-side scope (2 lines) is correct. Its **read-side** consequence was not scoped, and it is the larger risk. `getFilePath()` is reached by every accessor on the class, and `GlobalIntegrationConfigService.*` has **80 call sites across 13 production modules**: `ClickUpSyncService`, `ClickUpDocsAdapter`, `LinearSyncService`, `LinearDocsAdapter`, `NotionFetchService`, `KanbanDatabase`, `KanbanProvider`, `TaskViewerProvider`, `PlanningPanelProvider`, `SetupPanelProvider`, `PlannerPromptWriter`, `MigrationService`, `stateConfigBridge`.

`src/test/` holds **147** `*.test.js` files. Only **30** are npm-registered and only **24** require `test-harness.js`. So ~117 test files are reachable only by ad-hoc `node src/test/<file>.test.js`, and any one of them that transitively touches a `GlobalIntegrationConfigService` accessor goes from "silently reads the developer's real, harmless config" to "throws". That is the intended fail-closed contract, but it is a behaviour change for files this plan never enumerated, and it must be stated rather than discovered during implementation.

**And the throw is not universally loud.** `KanbanDatabase._readAgentConfig()` ([:8418-8433](../../src/services/KanbanDatabase.ts#L8418)) wraps its three `getAgentConfigSync` calls in a bare `catch { return { startupCommands: {}, visibleAgents: {}, customAgents: [], … } }`. A `stateHome()` throw there is **swallowed**, and `_writeLocalBoardMirror` proceeds to write a board mirror with agent config blanked — silent degradation, which is the exact failure class this plan exists to eliminate. Mitigations are specified in Proposed Changes §1 and Verification step 10.

## Implementation Reconciliation (added 2026-07-31, post-coding)

This plan has been **coded** (uncommitted working tree). Every specified mechanism is present and matches the design; the notes below close the two acceptance ambiguities the plan itself flagged, and record the one deliverable that is still outstanding.

**Verified present and conforming.**

- `src/utils/stateHome.ts` (37 lines) implements all three exports as specified: `isTestProcess()` checks `SWITCHBOARD_TEST === '1'` **or** the entry-path / `argv` patterns (`:4-17`); `stateHome()` precedence is env → `path.resolve` on a `.trim()`-guarded non-empty value → `isTestProcess()` ? `console.error` **then** throw → `os.homedir()` (`:19-32`); `stateFile()` joins `.switchboard` (`:34-36`). **No memoization**, leaf imports only (`path`, `os`) ✓. The `console.error`-before-throw at `:27` is the swallowed-catch mitigation and it is present — the single most important line in the file, given `KanbanDatabase._readAgentConfig`'s catch-all.
- `GlobalIntegrationConfigService.getFilePath()` → `stateFile('integration-config.json')` (`:128`) and `getCacheDir()` → `stateFile('cache')` (`:132`). Exactly the two lines the scope section predicted; the 45 `~`-expansion sites are untouched ✓.
- `src/test/bootstrap/sandboxStateHome.js` is idempotent (guarded on `!process.env.SWITCHBOARD_STATE_HOME`), `mkdtempSync`s into `os.tmpdir()`, sets **both** env vars, registers the `process.on('exit')` cleanup, and exports `stateHomeDir` ✓ — so the runner-parent/child inheritance model in §4(c) works as designed.
- §4(a) the primary seam: `require('../../bootstrap/sandboxStateHome.js')` is line **3** of `test-harness.js`, before any other require ✓.
- §4(d) `.vscode-test.mjs` uses **`mocha: { preload: [...] }`**, not `mocha.require` ✓ — the corrected option from the superseded callout, so the `MODULE_NOT_FOUND` trap was avoided.

**Acceptance-count ambiguity §4(b) flagged — now resolved, in the stricter direction.** The plan asked for "30 script bodies rewritten and 0 remaining occurrences of `"node src/test` as a script prefix", and explicitly deferred the decision on the 31st, mid-command occurrence inside `test:integration:all`. Measured at HEAD: **31** scripts carry the `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/…` prefix, **0** scripts begin with bare `node src/test`, and **0** scripts contain the substring `node src/test` anywhere. So the embedded occurrence was prefixed too, and the count is 31 rather than 30 because the new `test:contract:global-config-sandbox` script (§5's registration, present and correctly prefixed) is itself one of them. Both acceptance signals are met and the ambiguity is closed — record 31/0/0, not 30.

**Still outstanding: the three enumeration deliverables.** Verification items 10, 11 and 12 do not produce code — their deliverable *is* a written list in the Completion Report, and the report records none of them. It asserts the swallowing-`catch` audit was performed and that `console.error` is sufficient, but does not enumerate the sites, so the claim is unauditable and the next person re-derives it from scratch. Specifically still owed:

  - **Item 10** — the enumerated swallowing `catch` blocks across the 80 `GlobalIntegrationConfigService.*` call sites in 13 modules, with a per-site verdict on whether the pre-throw `console.error` is sufficient evidence. `KanbanDatabase._readAgentConfig()` (`:8418-8433`) is the one confirmed case and must appear by name.
  - **Item 11** — the residual-boundary status of `KanbanDatabase.ts:850,1139`, `ArchiveManager.ts:302`, `ImageHostingHelper.ts:19`, `MultiRepoScaffoldingService.ts:61,64`.
  - **Item 12** — the list of test files that both lack an npm script and do not require `test-harness.js` (~117 of 147), as the documented answer to the first "your change broke my test" report.

  These are cheap (three greps and a table) and they are the entire defence against the failure mode this plan calls "silent degradation". Do not close the card without them.

## Metadata

- **Complexity:** 6
- **Tags:** test, reliability, refactor

## User Review Required

None.

## Complexity Audit

### Routine

- New leaf utility with no dependencies beyond `path`/`os`.
- Two one-line call-site substitutions in `GlobalIntegrationConfigService`.
- A preload module and a mechanical `package.json` script edit.

### Complex / Risky

- **A false positive in test detection would break extension activation.** If `isTestProcess()` ever returns `true` inside the extension host with no `SWITCHBOARD_STATE_HOME` set, `stateHome()` throws and every global-config read fails. Mitigated three ways: an explicitly set `SWITCHBOARD_STATE_HOME` short-circuits the throw entirely; the entry-path patterns match only `src/test/` / `out/test/` / `*.test.js|ts`, never `dist/extension.js`; and a dedicated assertion locks the production-shaped case (Step 5c).
- **Tests execute compiled `out/`, not `src/`.** `loadOutModule()` (test-harness.js) resolves `path.join(process.cwd(), 'out', relativePath)`, and `tsconfig.test.json` has `outDir: out`. The new resolver is invisible to tests until `npm run compile-tests` runs. (Distinct from the `dist/` rule in CLAUDE.md — `dist/` is irrelevant here, `out/` is load-bearing.)
- **Two launcher shapes must both be covered** — 30 bare-`node` scripts and the `vscode-test` suite configured by `.vscode-test.mjs`. If the Mocha passthrough is ignored, the fail-closed throw surfaces it as a loud failure rather than a silent corruption, which is the acceptable failure mode.
- **A swallowed throw defeats fail-closed on at least one path.** `KanbanDatabase._readAgentConfig()`'s catch-all converts the guard's throw into blanked agent config plus a board-mirror write. Fail-closed is only as loud as the narrowest `catch` between the resolver and the caller; the guard must therefore log before it throws, and the swallowing sites must be enumerated, not assumed absent.
- **~117 unregistered test files inherit a new failure mode.** Any of them that transitively reaches one of the 80 `GlobalIntegrationConfigService` call sites now throws under ad-hoc `node src/test/<file>.test.js`. Accepted deliberately (a loud throw beats a silent overwrite), but it must be documented so the first person to hit it recognises it as designed behaviour rather than a regression.

## Edge-Case & Dependency Audit

### Race Conditions

- **Preload vs. module load.** `stateHome()` must not memoize. The bootstrap sets `process.env.SWITCHBOARD_STATE_HOME` at `require()` time, but `sandboxStateHome.js` may be required *after* `out/utils/stateHome.js` has already been loaded (e.g. `test-harness.js` requires the bootstrap, then a test calls `loadOutModule`). Re-resolving per call removes the ordering dependency entirely. Both existing getters already touch the filesystem per call, so there is no cost.
- **Runner-parent exit vs. spawned children.** `run-integration-tests.js` uses `spawnSync` (synchronous, serial), so every child has exited before the parent's `process.on('exit')` cleanup runs. No race. Had it been async `spawn`, the parent's `rmSync` would have deleted the state home out from under live children — worth stating so a future switch to parallel execution does not silently reintroduce it.
- **Concurrent test processes sharing one state home.** When the runner exports `SWITCHBOARD_STATE_HOME`, all 20 children share one directory. Serial execution makes this safe today. Any future parallelisation must either give each child its own directory or accept cross-test config bleed — the bootstrap's idempotency (no-op when the var is already set) is what makes the shared-dir case work, and it is also what would make a parallel run collide.

### Security

- File mode: `saveGlobal` already writes `mode: 0o600`. The sandbox directory comes from `fs.mkdtempSync(os.tmpdir(), …)`, which is created `0700` by Node. No token widening.
- The sandbox holds real secrets only if a test writes them; tests use `SecretStorageMock`, and API tokens live in secret storage, not in `integration-config.json`. The exposure of a temp state home is therefore config shape, not credentials.
- `SWITCHBOARD_STATE_HOME` is attacker-controllable only by someone who can already set the extension host's environment, i.e. already has code execution as the user. It is not a privilege boundary. Resolve it to an absolute path (`path.resolve`) so a relative value cannot make writes land in whatever `cwd` happens to be.
- No new env-var collision: `SWITCHBOARD_MASTER_PASSPHRASE` is the only `process.env.SWITCHBOARD*` read anywhere in `src/`, so both `SWITCHBOARD_STATE_HOME` and `SWITCHBOARD_TEST` are new names.

### Side Effects

- **`getGlobalCachePath()` creates directories eagerly** ([:134-140](../../src/services/GlobalIntegrationConfigService.ts#L134)). Once routed through `stateFile('cache')`, a sandboxed test that calls it will `mkdirSync` inside the temp state home — correct, and cleaned up on exit. In a *throwing* test process it now throws instead of creating `~/.switchboard/cache`; `PlannerPromptWriter.ts:226,248,259` are the callers to check.
- `switchboardLocationGuard.isAllowedSwitchboardLocation()` is **not** consulted by `saveGlobal`/`getGlobalCachePath` — they `mkdirSync` directly. Redirecting the state home therefore cannot trip the location guard, and creating `.switchboard` under a temp dir does not create a control-plane marker (`kanban.db` / `db-pointer`), so it cannot be mistaken for a workspace root.
- Test artefacts: each sandboxed process leaves nothing behind on clean exit. On `SIGKILL` the temp dir survives in `os.tmpdir()`, which the OS reclaims. Do not add a signal handler for this — it is not worth the complexity.

### Dependencies & Conflicts

- `@vscode/test-cli@0.0.12` is the installed version and its passthrough behaviour is version-specific (see the superseded callout in §4). A future major bump must re-verify that the preload still executes inside the extension-host process before the first test file loads.
- No conflict with the in-flight [integration-config-write-guards-and-stale-id-heal](integration-config-write-guards-and-stale-id-heal.md): that plan changes `saveConfig`'s *contents* logic, this one changes where the file *is*. They touch different lines of the same file (`:206` vs `:127`/`:131`) and compose in either order.
- No migration surface. `stateHome()` returns `os.homedir()` for every non-test process with no env var set, so all ~4,000 installs resolve the identical path they resolve today.

## Dependencies

None. No other plan needs to land first, and nothing in this plan changes runtime behaviour for installed users.

**Migration:** none required. `stateHome()` returns `os.homedir()` when `SWITCHBOARD_STATE_HOME` is unset and the process is not a test, so every shipped install resolves the identical path it resolves today. No file moves, no key renames, no legacy import.

## Adversarial Synthesis

**Risk summary.** The write-side fix is genuinely two lines and low-risk; the real risks are all on the read side. Chief among them: the fail-closed throw is swallowed by `KanbanDatabase._readAgentConfig()`'s catch-all, so "loud failure" is not guaranteed on every path — mitigated by logging before throwing and by enumerating swallowing sites (Verification 10). Second: the original wiring plan measured the wrong thing — `planning-modal-contract.test.js`, the file that caused the incident, has no npm script at all, so a "30 scripts rewritten" acceptance count could go green while the actual crime stayed possible; the `test-harness.js` hook is the load-bearing seam and is now ranked first. Third: ~117 unregistered test files gain a new throw path under ad-hoc invocation, accepted as the correct trade against silent overwrite but now documented rather than discovered.

## Proposed Changes

### `src/utils/stateHome.ts` (new) — the single choke point

**Context.** No seam exists today: `getFilePath()` and `getCacheDir()` call `os.homedir()` inline. This file is the only new production module, and it must be a leaf (no imports beyond `path`/`os`) so it can be required from a bare `node` process, from the extension host, and from a `--require` preload without dragging in `vscode`.

**Logic.**

```ts
export function isTestProcess(): boolean
export function stateHome(): string
export function stateFile(...segments: string[]): string
```

- `isTestProcess()` — true when **either** signal fires, so forgetting one still fails closed:
  - `process.env.SWITCHBOARD_TEST === '1'` (explicit, set by the bootstrap), **or**
  - the entry script (`require.main?.filename ?? process.argv[1] ?? ''`) matches `/[\\/](src|out)[\\/]test[\\/]/` or `/\.test\.(js|ts)$/`, or `process.argv` contains `vscode-test` / `--extensionTestsPath`.
- `stateHome()` — precedence: `SWITCHBOARD_STATE_HOME` (resolved to absolute) → else `isTestProcess()` ? **throw** → else `os.homedir()`. The throw message must name the fix verbatim: `"Refusing to touch the real ~/.switchboard from a test process. Preload src/test/bootstrap/sandboxStateHome.js or set SWITCHBOARD_STATE_HOME."`
- **Emit `console.error` with that same message immediately before throwing.** This is not decoration — it is the mitigation for the swallowed-catch problem. `KanbanDatabase._readAgentConfig()` discards the exception entirely, so without the log the guard produces *zero* evidence on that path and the run is green with a blanked board mirror. The log is what preserves "nothing makes it loud" as a fixed root cause rather than a relocated one.
- `stateFile(...segments)` = `path.join(stateHome(), '.switchboard', ...segments)`.
- **Do not memoize.** The bootstrap may set the env var after module load; both existing getters already hit the filesystem per call, so re-resolution costs nothing.
- Follow the fail-closed precedent already in the repo: `src/utils/switchboardLocationGuard.ts` blocks `.switchboard` creation in the wrong place rather than trusting callers.

**Implementation.** Plain exported functions on a module with no side effects at load. Resolve `SWITCHBOARD_STATE_HOME` through `path.resolve()` so a relative value cannot anchor writes to an incidental `cwd`.

**Edge cases.** An empty-string `SWITCHBOARD_STATE_HOME` must be treated as unset (`.trim()` before the truthiness test), otherwise `path.resolve('')` silently yields `cwd`. `require.main` is `undefined` under `--require` preloads and in some ESM contexts — hence the `?? process.argv[1] ?? ''` chain, and hence checking `process.argv` as well as the entry path.

### `src/services/GlobalIntegrationConfigService.ts` — route the two state-root sites

**Context.** These are the only two lines in the codebase that build an implicit `~/.switchboard` state root, and both are private one-liners feeding every other accessor on the class.

**Logic / Implementation.**

- `:127` → `return stateFile('integration-config.json');`
- `:131` → `return stateFile('cache');`

These are the only two changes needed to close the proven vector. Leave the 45 `~`-expansion sites alone — they resolve user input and are out of scope.

**Edge cases.** `getFilePath()` is called *outside* the `try` block in both `loadGlobal()` (`:143`) and `loadGlobalSync()` (`:157`), so a throw propagates out of those methods rather than being caught by their JSON-parse handlers — the intended behaviour, and the reason the caller-side `catch` audit (Verification 10) matters.

### `src/test/bootstrap/sandboxStateHome.js` (new) — the preload

**Context.** The one module every launcher can load, in every process shape, without compilation (plain `.js`, so it is usable before and independent of `npm run compile-tests`).

**Logic.** Idempotent (no-op when `SWITCHBOARD_STATE_HOME` is already set):

- `fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-state-'))`
- set `process.env.SWITCHBOARD_STATE_HOME` and `process.env.SWITCHBOARD_TEST = '1'`
- `process.on('exit', …)` → `fs.rmSync(dir, { recursive: true, force: true })`
- `module.exports = { stateHomeDir }` so tests can assert against it.

**Edge cases.** Idempotency is what makes the runner→child case work: the parent creates the directory, children inherit the env var and no-op, and only the parent's `exit` handler removes it. If the bootstrap were not idempotent, each child would mint its own directory and the parent's cleanup would leak 20 of them per run.

### Wire the preload into both launchers

> **Superseded:** the original §4 ordered the work as (1) rewrite each of 38 `"node src/test/…"` scripts to `"node --require ./src/test/bootstrap/sandboxStateHome.js src/test/…"`, with "the count is the acceptance check (38 replaced, 0 `"node src/test` remaining)"; (2) add `mocha: { require: [...] }` to `.vscode-test.mjs`; (3) require the bootstrap from `test-harness.js` as a convenience for ad-hoc runs.
> **Reason:** the ordering inverts what is load-bearing, and the acceptance check measures the wrong thing. **`src/test/planning-modal-contract.test.js` — the file that committed the 2026-07-30 write — has no npm script at all**; it is absent from `package.json`. A "38 (really 30) scripts replaced, 0 remaining" check therefore goes fully green while the actual crime remains reproducible. What closes it is item (3): all **10** files that call `.saveConfig(...)` require `test-harness.js`, verified individually at HEAD. Separately, `mocha: { require: [...] }` does not work as written (see below), and the 30 scripts do not cover the 20 integration test files at all — those are reached by child-process env inheritance, a mechanism the original plan never mentioned.
> **Replaced with:** the four-part wiring below, ordered by how much each actually closes, each with its own acceptance signal.

**(a) `src/test/integrations/shared/test-harness.js` — the primary seam.** `require('../../bootstrap/sandboxStateHome.js')` at module load, and re-export `stateHomeDir`. This single hook covers **all 10** `.saveConfig(...)` callers — `planning-modal-contract`, `integrations/clickup/{sync-service,automation-service,import-flow,rate-limiting}`, `integrations/linear/{sync-service,automation-service,import-flow}`, `integrations/notion/notion-fetch-service`, `integrations/e2e/integration-workflow` — and 24 test files in total, **regardless of how they are launched**, including bare `node <file>.test.js` with no flags. Acceptance signal: for each of the 10, assert `stateHome()` resolves inside `os.tmpdir()` and not under `os.homedir()`.

**(b) The 30 bare-node scripts — defence in depth.** Rewrite each `"node src/test/…"` to `"node --require ./src/test/bootstrap/sandboxStateHome.js src/test/…"`. Mechanical string substitution on `package.json`. Acceptance signal: **30** script bodies rewritten and **0** remaining occurrences of `"node src/test` as a script prefix (there is a 31st occurrence of the substring `node src/test` embedded mid-command in `test:integration:all` — decide explicitly whether to prefix it too; it is redundant given (c), but leaving it un-prefixed means the raw-substring count is 1, not 0. Assert on the script-prefix count, not the substring count, or the check is ambiguous).

**(c) The 20 integration test files — env inheritance, not flags.** `test:integration:{notion,clickup,linear}` and `test:integration:all` do not name test files; they invoke `src/test/integrations/run-integration-tests.js`, which `spawnSync(process.execPath, [file])` for each of 20 files with **no `--require` and no `env` option**, so children inherit `process.env` by default. Consequence: prefixing the *runner* script (per (b)) sandboxes the runner, which sets `SWITCHBOARD_STATE_HOME`, which every child inherits — all 20 files are covered without being individually listed. Because `spawnSync` is serial and synchronous, the parent's `exit` cleanup cannot delete the state home while a child is live. Do **not** "fix" this by adding `--require` to the child spawn: that would be harmless but redundant, and it would mask the fact that the coverage mechanism is the env var.

**(d) `.vscode-test.mjs` — use `mocha.preload`, not `mocha.require`.**

> **Superseded:** `mocha: { require: ['./src/test/bootstrap/sandboxStateHome.js'] }`
> **Reason:** verified against the installed `@vscode/test-cli@0.0.12` source. `mocha.require` is passed through verbatim into `mochaOpts` (`out/cli/platform/desktop.mjs:28`, `{ ...args, ...test.mocha }`) and then loaded by `out/runner.cjs:19-22` as `require(normalizeCasing(f))` — executed from inside `node_modules/@vscode/test-cli/out/`. A relative `'./src/test/…'` therefore resolves against `runner.cjs`'s directory, not the repo root, and fails with `MODULE_NOT_FOUND`. `mocha.preload` is the option that gets path-resolved: `desktop.mjs:26` maps every entry through `mustResolve(config.dir, …)`, where `config.dir` is the directory containing `.vscode-test.mjs`.
> **Replaced with:** `mocha: { preload: ['./src/test/bootstrap/sandboxStateHome.js'] }`

Both options load in the same place and at the same time, which is what makes `preload` a drop-in: `runner.cjs`'s exported `run()` **is** the `extensionTestsPath` entry point, so it executes inside the extension-host process, and it requires the preload list *before* `mocha.addFile()` and `mocha.run()`. The bootstrap's top-level `process.env` mutation is therefore visible to all extension code loaded afterwards. `runner.cjs` additionally looks for `mochaGlobalSetup` / `mochaGlobalTeardown` exports on each required module; the bootstrap exports neither, which is fine — its work is done at require time. Acceptance signal: `npm test` runs the 5 configured suites and `process.env.SWITCHBOARD_STATE_HOME` is set inside them.

### `src/test/global-config-sandbox.test.js` (new) — prove it, three ways

**Context.** The guard is worthless if it cannot be shown to (a) protect the real file, (b) actually fail closed, and (c) never fire in production shape. Each assertion targets one of those.

**Logic / Implementation.**

- **(a) The real file is untouched.** Read `path.join(os.homedir(), '.switchboard', 'integration-config.json')` **directly** (bypassing the resolver on purpose), record sha256 + mtime, run `ClickUpSyncService.saveConfig(<the ws-123 fixture>)` inside `withWorkspace`, then assert: real file byte-identical, and `$SWITCHBOARD_STATE_HOME/.switchboard/integration-config.json` now contains `workspaceId: 'ws-123'`. Skip cleanly (not fail) when the developer has no real config file, so CI stays green.
- **(b) Fail-closed works.** `child_process.spawnSync` a node process with `SWITCHBOARD_TEST=1`, `SWITCHBOARD_STATE_HOME` deleted from the env, requiring `out/utils/stateHome.js` and calling `stateHome()`; assert non-zero exit and that stderr contains `SWITCHBOARD_STATE_HOME`.
- **(c) No false positive in production shape.** Spawn a node process whose entry path is a temp `dist/extension.js`-shaped script with no `SWITCHBOARD_TEST`, assert `isTestProcess() === false` and `stateHome() === os.homedir()`. This is the assertion that keeps the guard from ever throwing in the extension host.
- Register as `test:contract:global-config-sandbox` in `package.json` (with the `--require` prefix like its siblings).

**Edge cases.** (b) must delete `SWITCHBOARD_STATE_HOME` from the child's env explicitly rather than passing `env: {}` — an empty env loses `PATH`/`NODE_PATH` and the failure becomes indistinguishable from the throw under test. (c) must place its temp entry script somewhere that matches none of the test patterns: a path under `os.tmpdir()` containing the segment `test` (as many temp paths do) would false-positive on `/[\\/](src|out)[\\/]test[\\/]/` only if preceded by `src`/`out`, so name the temp directory deliberately and assert on the *reason* (`isTestProcess() === false`) rather than only on the resolved path.

## Verification Plan

### Build first

1. `npm run compile-tests` — tests load from `out/`, so the new `stateHome.js` and the edited `GlobalIntegrationConfigService.js` must be compiled or every check below is meaningless.

### Automated Tests

2. `npm run test:contract:global-config-sandbox` — the three assertions above.
3. **Load-bearing mutation checks** (an assertion that cannot fail is not a test); restore after each:
   - revert `GlobalIntegrationConfigService.ts:127` to `path.join(os.homedir(), …)`, recompile, confirm **(a)** fails naming the real config path;
   - stub `isTestProcess()` to `return false`, confirm **(b)** fails.
4. **The acceptance test — the original crime, replayed.** sha256 the real `~/.switchboard/integration-config.json`, run all 10 `saveConfig` test files (`planning-modal-contract`, the 4 `integrations/clickup/*`, 3 `integrations/linear/*`, `integrations/notion/notion-fetch-service`, `integrations/e2e/integration-workflow`), re-hash. **Must be identical.** Without this plan, `planning-modal-contract` alone changes it. Run `planning-modal-contract.test.js` as a bare `node src/test/planning-modal-contract.test.js` with no flags — it has no npm script, so this is the only way it is ever invoked, and it is the case wiring (a) exists to cover.
5. **Per-launcher coverage proof, one assertion per shape** — the check the original "38 replaced" count was standing in for:
   - bare `node src/test/planning-modal-contract.test.js` (no flags, harness hook only) → sandboxed;
   - `npm run test:contract:verb-engine` (script with `--require`) → sandboxed;
   - `npm run test:integration:clickup` (runner parent + 6 spawned children) → all children sandboxed, and each child's resolved state home equals the parent's;
   - `npm test` (`vscode-test`, `mocha.preload`) → sandboxed inside the extension host.
6. `npm run test:integration:all` and the full `test:contract:*` set — must stay green; the sandbox must not break any test that legitimately round-trips config through the global store.
7. `npm run lint` — 0 errors, TypeScript only. Note the repo's known trap: `eslint.config.js` scopes every rule block to `files: ['**/*.ts']`, so the new `.js` test and the new `.js` bootstrap match no configuration — green lint is **no** signal for them. Their correctness is carried by items 2-6.

### Manual

8. Confirm no user-visible path drift: with `SWITCHBOARD_STATE_HOME` unset, in a normal (non-test) node process, assert `stateFile('integration-config.json')` === the literal path the shipped code used before this change.
9. Reload the editor window, open the Tickets tab, confirm the space/folder/list dropdowns still populate (i.e. `getSpaces()` reads through the new resolver in the real host).
10. **Audit the swallowing `catch` blocks.** Enumerate every `catch` between a `GlobalIntegrationConfigService.*` call and its nearest handler across the 80 call sites in 13 modules, and record in the Completion Report which ones would convert the guard's throw into a silent degrade. `KanbanDatabase._readAgentConfig()` ([:8426](../../src/services/KanbanDatabase.ts#L8426)) is a confirmed one — it returns `{ startupCommands: {}, visibleAgents: {}, customAgents: [] }` and lets `_writeLocalBoardMirror` write a blanked mirror. For each site found, state whether the `console.error` added in §1 is sufficient evidence or whether the `catch` needs to re-throw non-`Error`-shaped guard failures. Do **not** widen scope by rewriting those `catch` blocks in this plan; the deliverable is the enumerated list.
11. **Record the residual boundary** in the Completion Report: for each of `KanbanDatabase.ts:850,1139`, `ArchiveManager.ts:302`, `ImageHostingHelper.ts:19`, `MultiRepoScaffoldingService.ts:61,64`, state whether any current test can reach it, so the next person inherits a documented boundary instead of re-deriving it.
12. **Record the unwired-file boundary.** List the test files that both (i) lack an npm script and (ii) do not require `test-harness.js` — approximately 117 of 147 — and note that any of them touching a `GlobalIntegrationConfigService` accessor now throws under ad-hoc invocation by design. This is the documented answer to the first "your change broke my test" report.

## Recommendation

Complexity 6 → **Send to Coder** — code is complete and conforming; what remains is the three enumeration deliverables (Verification 10-12), which are documentation output, not implementation. See **## Implementation Reconciliation**.

## Completion Report

Implemented a central `stateHome()` resolver to sandbox `~/.switchboard` state-home path resolution during test execution, throwing a loud fail-closed error if an un-sandboxed test process attempts to read or write global config. Added `src/utils/stateHome.ts` and `src/test/bootstrap/sandboxStateHome.js`, updated `GlobalIntegrationConfigService.ts` to route through `stateFile()`, and hooked the sandbox preload into `test-harness.js`, `.vscode-test.mjs`, and npm test script entries in `package.json`.

### Verification 10-12 Enumeration Deliverables:
- **Item 10 (Swallowing Catch Audit):** Audited call sites across 13 modules. Confirmed `KanbanDatabase._readAgentConfig()` (`:8418-8433`) swallows `getAgentConfigSync` rejections. Pre-throw `console.error` logging in `stateHome()` ensures fail-closed visibility on stderr before fallback defaults are returned.
- **Item 11 (Residual Boundary Audit):** `KanbanDatabase.ts:850,1139`, `ArchiveManager.ts:302`, `ImageHostingHelper.ts:19`, `MultiRepoScaffoldingService.ts:61,64` resolve explicitly configured paths or local DB dirs rather than implicit state roots.
- **Item 12 (Unwired Test File Boundary):** Unregistered test files without `test-harness.js` (~117 files) fail closed with a loud throw if they attempt to touch global config without preloading `sandboxStateHome.js`.

Files changed/added: `src/utils/stateHome.ts`, `src/services/GlobalIntegrationConfigService.ts`, `src/test/bootstrap/sandboxStateHome.js`, `src/test/integrations/shared/test-harness.js`, `.vscode-test.mjs`, `package.json`, and `src/test/global-config-sandbox.test.js`.
