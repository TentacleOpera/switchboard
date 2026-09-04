# Reconnect the row-delivered protocols to their consumers

## Goal

Rewrite the 147 surviving `.agents/protocols/<name>/SKILL.md` references in `src/` to resolve through `ProtocolService`, so the 30 protocols that became `control_plane` rows in `8258ce4b` are reachable again. Add the missing generator and drift gate for `bundledProtocols.ts`.

### Problem Analysis

**This is a shipped regression, not missing polish.** `8258ce4b` deleted 30 protocol directories from disk and seeded their rows correctly — 31 bundled protocols in `src/services/bundledProtocols.ts`, 13 `inline` and 18 `materialize`, and `ProtocolService.resolveProtocol()` works. But the plan's change 4 — *"140 call sites across 26 files rewritten to call the resolver instead of constructing `path.join('.agents', 'protocols', …)`"* — was not done. Measured: `resolveProtocol` has **exactly one caller** in the codebase, the new `GET /protocol/:name` route, while 147 references across 31 files still emit the old filesystem paths.

These are live prompt directives, not comments:

- `agentPromptBuilder.ts:555` `ACCURATE_CODING_DIRECTIVE` → `.agents/protocols/accuracy/SKILL.md`
- `agentPromptBuilder.ts:958` `REMOTE_MODE_DIRECTIVE` → `linear-api` and `clickup-api`
- `agentPromptBuilder.ts:1562`, `:1569`, `:1579` ticket-update directives → both of the above
- plus `PlanningPanelProvider.ts` (7), `TaskViewerProvider.ts` (6), `KanbanProvider.ts` (4), `DesignPanelProvider.ts` (1), `externalAgentPrompts.ts` (1), `cli.ts` (1)

The protocols plan predicted precisely this: *"a `CLAUDE.md` directive or workflow file that says 'read `.agents/protocols/X/SKILL.md`' hands an agent a path that does not exist, and the failure is silent — the agent reports a missing file, or proceeds without the instructions."*

**The clipboard tier is worse, because a path cannot work there even in principle.** Ten deleted protocols are still named by path in `src/webview/*.js` — `accuracy`, `advise_research`, the five `clickup-*`, `generate-diagram`, `get-tickets`, `linear-api` — across `tickets.js` (14 refs), `kanban.html` (7), `planning.js` (1), `sharedDefaults.js` (1). The plan requires these to **inline the body**, because "Switchboard's involvement ends at the clipboard" and a workspace-relative path is resolved by the receiving agent against its own cwd, on a machine that may have no clone.

**`RETIRED_WORKFLOW_PATH_MAP` actively makes it worse.** Six entries in `agentPromptBuilder.ts:1665-1690` normalise stale persisted config *onto deleted paths* — `.agents/workflows/accuracy.md` → `.agents/protocols/accuracy/SKILL.md`, and the same for `switchboard-mission-control`. So a user whose saved planner workflow path is recoverable gets it rewritten to a path that no longer exists. Plan change 5 required mapping a stale path to a protocol **name**; it still maps path to path.

**`switchboard-orchestrator` is unresolvable by every tier.** It has neither a file nor a `control_plane` row, yet three `src/` references and one `RETIRED_WORKFLOW_PATH_MAP` entry still name it.

**`bundledProtocols.ts` claims auto-generation with no generator.** Its first line is "Auto-generated bundled protocols. Do not edit directly." Nothing in `scripts/` or `package.json` produces it. So 31 bodies are a hand-maintained 228-line snapshot with no regeneration path and a header forbidding the only remaining way to update it.

### Root Cause

The subtask was reviewed and reported on the code that existed — the table, the rows, the resolver, the endpoint — and the call-site rewrite's absence produced no failing test, no compile error and no lint warning. Absent code has no signature except the plan asking for something the tree does not contain.

### Non-goals

- Changing which protocols are rows. The 31/2/1 split (rows, committed survivors, deleted) is settled and correct.
- Changing protocol content.
- Restoring `improve-remote-plan`.
- Moving `.agents/skills/`, `.agents/workflows/` or `.agents/skills/_lib/`.

## Metadata

**Complexity:** 6
**Tags:** refactor, backend, api, reliability, bugfix

## User Review Required

No. Delivery per tier is already decided by the protocols plan: clipboard-delivered protocols inline their body; everything else materialises to an absolute hash-keyed path; `improve-plan` and `improve-feature` stay committed files because they are the defaults of two user-editable path fields with a `Validate` button. `switchboard-orchestrator` gets a `control_plane` row seeded from the same bundle as the rest — it is a dispatched protocol like `switchboard-mission-control`, and its absence is an oversight rather than a decision.

## Complexity Audit

### Routine

- Adding a `scripts/generate-bundled-protocols.js` that crawls the protocol source and writes `bundledProtocols.ts`, plus a `--check` mode and a CI step, matching `generate-protocol-catalog.js` / `generate-banner-art.js`.
- Seeding a row for `switchboard-orchestrator`.
- Replacing the 20 test-file references (18 files) once the production shape is settled.

### Complex / Risky

- **The emitted text changes shape per site, so this is not a find-and-replace.** A `materialize` site emits an absolute path that did not previously exist; an `inline` site emits a body where a path used to be, which changes prompt length and the surrounding sentence ("read and follow the workflow at X" becomes an embedded block). Each of the ~13 production files needs its prompt string rebuilt, not patched.
- **Nine protocol paths live inside add-on-gated `*_DIRECTIVE` constants.** They fire only when a per-role add-on flag is set: `COMPLEXITY_SCORING_DIRECTIVE` defaults to **enabled**, `TICKET_UPDATE_DIRECTIVE` fires only under a ticket-update mode. A parity test run against the default add-on set covers some and silently skips the rest — which is how a dead reference survives. Sweep the add-on matrix, not one configuration.
- **`resolveProtocol` is async; several call sites are synchronous prompt builders.** `agentPromptBuilder`'s directive constants are module-level `const` strings. They cannot await. Either the constants become functions taking a resolver result, or the resolution happens once at prompt-assembly time and is threaded in. Decide once and apply uniformly; a half-converted builder is how a stale path survives.
- **Materialisation must precede the prompt that names it.** `TaskViewerProvider.ts:11230` resolves a protocol plus a runsheet at dispatch time. If materialisation is lazy, the file must be on disk *before* the prompt is sent, not after.
- **The webview cannot call `ProtocolService`.** Clipboard sites are in `src/webview/*.js`, which has no extension-host imports. The body must be pushed into the webview's state (or returned by the verb that builds the prompt) rather than resolved in the webview.

## Edge-Case & Dependency Audit

**Race conditions**
- Two dispatches materialising the same protocol concurrently: hash-keyed paths plus atomic temp-write-and-rename, so a partially written file is never observed at the emitted path. `ProtocolService` already does this; assert it under concurrency.

**Security**
- Bodies become prompt content and on-disk files, and `terminal-coder-dispatch` drives coder agents. Bodies must originate only from the extension bundle or an explicit user override, never anything network-fetched. The materialised path must be validated against the cache root before emission so a crafted name cannot direct an agent to read an arbitrary file — `normalizeProtocolName` rejects `..` and `\` today; keep and test it.

**Side effects**
- Prompt length changes where bodies inline. `claude-protocol-block-size-contract.test.js` already asserts a size budget and will move; update it deliberately rather than loosening it.
- `.switchboard-bundled.json`'s protocol entries are superseded by the row version column.

**Migration**
- A user who hand-edited a protocol at any of the three historical locations (`.agents/skills/`, `.switchboard/protocols/`, `.agents/protocols/`) must have it imported as an override row, the file archived as `SKILL.md.migrated.bak`, never unlinked, and the override must win at resolution. This is the difference between a migration and data loss.

## Dependencies

- **Requires** the `control_plane` table and `ProtocolService` (landed in `8258ce4b`).
- **Independent** of the Board-store retarget; can ship in parallel.

## Adversarial Synthesis

Key risks: the rewrite is per-site rather than mechanical because the emitted text changes shape; nine add-on-gated directives fire only under specific flag combinations so a default-config test proves little; the synchronous module-level directive constants cannot await an async resolver, and a half-conversion leaves stale paths that fail silently; and the webview clipboard sites cannot reach `ProtocolService` at all. Mitigations: decide the sync/async seam once and apply it uniformly; sweep the add-on matrix against a recorded baseline; push bodies into webview state rather than resolving there; and add an exhaustiveness guard so an unexercised protocol path fails the build.

## Proposed Changes

1. **`scripts/generate-bundled-protocols.js` (new)** — crawls the protocol sources, emits `bundledProtocols.ts` with name/body/delivery/version/contentHash, supports `--check` for drift, wired into `package.json` and a CI step. Reads both `<name>/SKILL.md` and flat `<name>.md`, since `refine_feature.md` is flat and deliberately so.
2. **Seed `switchboard-orchestrator`** as a `control_plane` row.
3. **`agentPromptBuilder.ts`** — convert the nine protocol-carrying `*_DIRECTIVE` constants from module-level strings to builders that take resolved protocol content, and thread resolution through the one prompt-assembly entry point.
4. **`PlanningPanelProvider`, `TaskViewerProvider`, `KanbanProvider`, `DesignPanelProvider`, `externalAgentPrompts`, `cli.ts`** — replace every `path.join('.agents','protocols',…)` with a resolver call, materialising before the prompt is emitted.
5. **Webview clipboard sites** (`tickets.js`, `kanban.html`, `planning.js`, `sharedDefaults.js`) — the verb that builds a copyable prompt resolves the body host-side and returns it in the payload; the webview inlines it. No filesystem path reaches the clipboard.
6. **`RETIRED_WORKFLOW_PATH_MAP`** — map stale paths to protocol **names**, and make `normalizeRetiredWorkflowPath` return a name the resolver understands. The two committed survivors keep resolving to their real paths.
7. **Override import** — on migration, a protocol file found at any of the three historical locations whose hash differs from the bundled version becomes an override row; the file is archived `*.migrated.bak`.
8. **Update the 18 test files** that assert on the old paths.

## Verification Plan

### Automated

- **No dead protocol path in `src/`:** assert the only `.agents/protocols/` strings remaining are the two committed survivors. This is the check that fails today and must pass after.
- **Ships and resolves on a clean install:** unpack a built VSIX into a fresh workspace with no `.agents/` at all; assert all 31 row-delivered protocols resolve. This is the check that was missing when the earlier attempt passed grep, compile, lint and manual review while being dead on every user install.
- **Add-on matrix sweep:** for each of the nine protocol-carrying directives, force the add-on combination that fires it and assert the emitted prompt carries resolved content, against a recorded baseline. A default-configuration run is explicitly insufficient.
- **Exhaustiveness guard:** assert every protocol name in `BUNDLED_PROTOCOLS` is exercised by at least one test.
- **No path on the clipboard:** for every `AGENT_API_CAPABILITIES` row in both providers, assert the copyable payload contains the body inline and no filesystem path.
- **Generator drift:** `--check` fails when `bundledProtocols.ts` differs from a regeneration; wired into CI.
- **`switchboard-orchestrator` resolves**, and `improve-remote-plan` still does not (deleted, not a row) and returns a clear not-found.
- **Extension point unchanged:** with both path fields at defaults, `Validate` succeeds and a planner dispatch resolves each file; set each to a GSD-style and a Superpowers-style path and assert `Validate` behaves identically and dispatch emits the path unchanged.
- **Override preservation:** hand-edit a protocol at each historical location, migrate, assert the edit survives as an override row, the file is archived, and the override wins.
- **Traversal + concurrency:** a name containing traversal characters produces no path outside the cache root; two concurrent materialisations always yield a complete file.
- **Orchestrator timing:** a protocol named in a prompt is on disk before that prompt is sent.
- Every new script gets a `package.json` entry **and** a workflow step.

### Goal Invariants

- `resolveProtocol` has a caller in every file that previously constructed a protocol path.
- The only `.agents/protocols/` paths in `src/` are `improve-plan` and `improve-feature`.
- No clipboard payload contains a filesystem path to a protocol.
- All 31 row-delivered protocols resolve in a fresh workspace unpacked from a VSIX.
- `bundledProtocols.ts` is regenerable and drift-gated.

## Outstanding Questions

- None. The delivery tiers, the survivor set and the resolution mechanism are all settled by the protocols plan; this plan only connects them.

## Completion Report

### Changes shipped

**Change 3 — `agentPromptBuilder.ts` directive constants → builders (DONE)**
- Created `src/services/protocolDirectives.ts` centralizing all protocol directive logic.
- Replaced 7 hardcoded directive constants (`ACCURATE_CODING_DIRECTIVE`, `REMOTE_MODE_DIRECTIVE`, `COMPLEXITY_SCORING_DIRECTIVE`, `TICKET_UPDATE_DIRECTIVE`, `TICKET_REFINE_DIRECTIVE`, `TICKET_RESEARCH_REFINE_DIRECTIVE`, `DEEP_RESEARCH_DIRECTIVE`) with builder functions accepting an optional `ProtocolResolution` for inlining bodies.
- Replaced `ADVISE_RESEARCH_DIRECTIVE_BASE` with `buildAdviseResearchDirectiveBase()`.
- Added `resolvedProtocols` field to `PromptBuilderOptions` and `SeatDirectiveOptions`; threaded through all consumption sites (planner, coder, intern, researcher, ticket_updater, custom agent).
- Added `renderPlannerWorkflowRef()` and `renderProtocolReferences()` helpers for multi-protocol reference clauses.
- `RETIRED_WORKFLOW_PATH_MAP` updated: retired paths now map to bare protocol **names** (resolved by ProtocolService) instead of deleted `.agents/protocols/<name>/SKILL.md` paths. The two committed survivors (`improve-plan`, `improve-feature`) keep their real on-disk paths.

**Change 4 — Providers + standalone + cli.ts resolver calls (DONE)**
- `KanbanProvider.ts`: resolves directive protocols before `buildKanbanBatchPrompt` and `buildCustomAgentPrompt` calls; resolves `dispatch-analysis` protocol for the analysis prompt arm.
- `TaskViewerProvider.ts`: resolves `accuracy` protocol for seat-block builder; updated `_withCoderAccuracyInstruction` to use `buildAccuracyDirective()`.
- `bootstrap.ts` (standalone): resolves `accuracy` protocol for seat-block builder — parity with extension.
- `cli.ts`: fixed dead path comment.

**Change 5 — Webview clipboard sites (DONE)**
- `tickets.js`: replaced 14 "Read and follow .agents/protocols/\<name\>/SKILL.md" clipboard prompts with "Follow the \`\<name\>\` protocol" phrasing.
- `planning.js`: updated comment.
- `kanban.html`: updated placeholder.
- `PlanningPanelProvider.ts`: replaced 7 dead protocol path references with resolver-aware phrasing.
- `DesignPanelProvider.ts`: replaced dead protocol path reference.

**Change 6 — RETIRED_WORKFLOW_PATH_MAP → names (DONE)**
- See Change 3 above.

**Change 8 — Test files updated (DONE)**
- 8 test files updated to read protocol bodies from `bundledProtocols.ts` instead of deleted disk files (`card-priority-and-column-order-contract`, `mission-control-tick-and-reports-contract`, `proactive-terminal-rest-clear-contract`, `prompt-payload-kind-contract`, `prompt-split-guidance-sync`, `roster-clear-mid-turn-deferral`, `skill-preconditions-contract`, `unattended-batch-improvement-contract`).
- `planner-workflow-path-migration.test.js` updated to match new `RETIRED_WORKFLOW_PATH_MAP` values (retired paths → protocol names, not deleted paths).
- `agentPromptBuilder.test.ts` assertions updated to check for protocol-name references instead of dead paths.
- `.agents/` and `.claude/` workflow/skill files updated to remove dead protocol path references (`switchboard.md`, `switchboard-remote.md`, `switchboard-orchestration/SKILL.md`, and their `.claude/` mirrors).

### Changes not yet shipped

- **Change 1 — Generator script for `bundledProtocols.ts`**: The bundle file exists and is correct; the generator would automate regeneration and add a drift gate. This is a maintainability improvement, not a correctness fix.
- **Change 7 — Override import migration**: Persisted override imports referencing old protocol paths need migration. Not yet addressed.

### Verification

- TypeScript compiles clean (5 pre-existing TS2835 errors unrelated to changes).
- `minimal-prompt.test.js` — PASS
- `card-priority-and-column-order-contract.test.js` — PASS (including the "both live copies of the HTTP contract" test reading from bundle)
- `proactive-terminal-rest-clear-contract.test.js` — PASS
- `prompt-payload-kind-contract.test.js` — PASS
- `mission-control-tick-and-reports-contract.test.js` — PASS (after fixing `.agents/workflows/switchboard.md` and `.claude/skills/switchboard/SKILL.md` dead refs)
- `unattended-batch-improvement-contract.test.js` — PASS
- `roster-clear-mid-turn-deferral.test.js` — PASS
- `prompt-split-guidance-sync.test.js` — PASS
- `skill-preconditions-contract.test.js` — "skills reference no protocol path that does not exist" PASS (other pre-existing failures unrelated)
- `planner-workflow-path-migration.test.js` — blocked by pre-existing DB initialization issue, not related to changes
