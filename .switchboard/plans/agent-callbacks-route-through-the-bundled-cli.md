# Agent Callbacks Route Through The Bundled CLI, Not A Raw HTTP POST

## Goal

Change what dispatched agents are *told to do* when they report completion, pull the next card, or escalate a review: invoke the Switchboard CLI that already ships in both hosts, instead of hand-rolling an HTTP POST against a port they have to discover. Add the two missing subcommands (`done`, `next`), inject the CLI's absolute path in both composition roots the way the port is injected today, and rewrite the prompt fragments to use it. The HTTP routes stay exactly as they are, forever.

### Problem Analysis & Root Cause

**What agents are told today.** Roughly 33 prompt-text sites across `teamWiring.ts`, `standingOrders.ts`, `standingOrderFragments.ts`, `agentPromptBuilder.ts`, `PlanIngestionEngine.ts`, `schedulerPresets.ts` and `linkPresets.ts` instruct a dispatched agent to *"POST /kanban/queue/done with {"from":"<your terminal name>"} against the port in .switchboard/api-server-port.txt"*, or a variant of it for `/kanban/queue/next`, `/kanban/move` and `ptySendPrompt`.

That instruction asks an agent to do four fragile things: locate a file, parse an integer out of it, hand-build a JSON body, and interpret an HTTP response. Each is a place to fail, and the failures are silent.

**The CLI already ships in both hosts — this is the key fact.** `webpack.config.js:140` declares `cli: './src/standalone/cli.ts'` as a bundled entry emitting `dist/standalone/cli.js`, and `module.exports = [extensionConfig, standaloneConfig]` builds it on every `npm run compile`. `.vscodeignore:33` is explicit:

> `# NOTE: there is deliberately no !dist/** here. Nothing above ignores dist/`

Only `dist/templates/**` and `dist/**/*.map` are excluded. **`dist/standalone/cli.js` is therefore inside every published VSIX today**, fully webpack-bundled with no `node_modules` requirement. It is not a dependency to be added — it is already present in the extension package and the extension's own agents simply do not use it.

**Why they don't is ordering, not design.**

```
2026-07-17   97cb2ea3  src/standalone/cli.ts first added
2026-08-21   51d9dae2  "Update completion directives to reference POST /kanban/queue/done"
```

The HTTP rail predates the CLI by a month. When the completion directives were revised in August they were revised *within* the HTTP model — the fragment got a better endpoint, not a better transport. Nothing revisited the transport choice after the CLI existed. This is drift, not a decision anyone made.

**Release status — clean break.** The agent-callback contract these fragments express has never shipped to users: it belongs to the teams and standing-orders surface, which is unreleased. The LocalApiServer it posts to has existed in released builds since 2026-04-29 but was experimental and not working well there. So there is no install base to keep compatible, no agents in flight under an older contract, and no third-party callers to preserve. The fragments get rewritten outright rather than extended.

**What the CLI already covers, and what it doesn't.** `cmdVerb` (`cli.ts:1436-1439`) tries `/terminals/verb/<name>` then falls back to `/kanban/verb/<name>`, so `switchboard verb ptySendPrompt '{...}'` — the reviewer→coder relay — works today with no new code. What has no CLI equivalent is the REST pair: `/kanban/queue/done` (`LocalApiServer.ts:8101`) and `/kanban/queue/next` (`LocalApiServer.ts:8099`) are routes on neither verb rail, and there is no `switchboard done` or `switchboard next`.

**Why an exit code beats a parsed body.** The completion signal is the one place the system permits no inference — doneness is never read off a column, an mtime, or silence; the explicit POST is the only accepted signal. A contract that strict deserves a transport an agent cannot half-succeed at. `switchboard done --from <seat>` either exits 0 or it does not, and the failure is visible in the terminal the operator is already watching. A malformed POST body produces a 4xx the agent may narrate as success.

**Dependency.** This plan is inert without deterministic port selection. `cmdVerb` resolves the server through `findRunningInstance` (`cli.ts:1416`), the same file-gated discovery the port plan fixes. Shipping CLI-based callbacks first would inherit the missing-file failure verbatim and make it *harder* to diagnose, because the failure would move from a curl the operator can see into a subprocess they cannot.

## Metadata
**Topic:** Route agent completion and queue callbacks through the bundled CLI
**Tags:** cli, agents, prompts, standalone, extension, architecture

**Complexity:** 6

## User Review Required

None.

## Complexity Audit

### Routine
- Adding `done` and `next` subcommands to `cli.ts` — thin clients over existing routes, same `apiPost` + `findRunningInstance` pattern as `cmdVerb`.
- Rewriting static POST instructions in prompt fragments — mechanical string replacement with the CLI command form.
- Fixing `KanbanProvider._resolveRosterAndPort` — replace file read with `getLocalApiServerPort()` call already used at lines 6164, 6202, 6246.
- Updating skill docs (`agentGroupInstantiation.ts:277`) — same string replacement.

### Complex / Risky
- **CLI-path injection in both composition roots** — the `cliPath` must be threaded from each root through `PromptBuilderOptions.cliPath` to the `SWITCHBOARD_CLI_DIRECTIVE` call site at `agentPromptBuilder.ts:1838`. This is an options-object field where "never wired" and "working" are indistinguishable — the exact class of divergence CLAUDE.md names. Both roots must wire it; a verb-reachability audit cannot catch a missing injection.
- **Dynamic port-reference constructions** — `portRef` at `agentPromptBuilder.ts:2029-2031` branches on `apiPort` to produce either a URL or the file-read instruction. This dynamic pattern appears in multiple reviewer/lead fragments and needs the CLI command form, not just the static POST sites.
- **Standalone CLI path resolution** — `process.argv[1]` is fragile in dev mode (points at TypeScript source, not the webpack bundle). `__dirname` is more reliable for webpack bundles and should be the primary resolution path.
- **Fragment sweep breadth** — ~33 sites across 7+ files. A missed site leaves an agent with a file-read instruction that works (the file is still written) but contradicts the CLI directive in the same prompt, confusing the agent.

## Edge-Case & Dependency Audit

**Race Conditions:**
- None new. The CLI subcommands are synchronous thin clients — they POST and exit. The server-side serialization (`_teamQueueDoneChains`, `_queueNextChain`) is unchanged.

**Security:**
- The CLI subcommands reuse `apiPost`, which calls `discoverAuthToken(workspaceRoot)` and adds a `Bearer` header. The routes (`/kanban/queue/done`, `/kanban/queue/next`) already require auth via `_checkAuth(req, true)`. No new auth surface — the CLI inherits the existing posture.
- The injected `cliPath` is an absolute filesystem path embedded in agent prompt text. It points at `dist/standalone/cli.js` inside the extension directory — not user-controlled, not sensitive. No injection risk.

**Side Effects:**
- Agents that previously built HTTP requests by hand now invoke a subprocess. The subprocess overhead is negligible (Node startup ~50ms on a warm bundle), but the agent's terminal now shows CLI output instead of curl output. This is an improvement (exit codes are visible) but changes the observable surface.
- The `--json` flag on `done`/`next` emits the same envelope as the route's JSON response. Agents that parsed the HTTP body can parse the `--json` output identically.

**Dependencies & Conflicts:**
- **Hard dependency on "Deterministic Port Selection So Discovery Never Depends On A File".** `cmdVerb` and the new subcommands resolve the server through `findRunningInstance` — the same file-gated discovery the port plan fixes. Shipping CLI-based callbacks first would inherit the missing-file failure verbatim and make it harder to diagnose (failure moves from a visible curl to a subprocess).
- The `SWITCHBOARD_CLI_DIRECTIVE` is a sibling to `SWITCHBOARD_LIVENESS_DIRECTIVE` — both are emitted in the same prompt. If `cliPath` is absent but `apiPort` is present, the liveness directive still tells the agent to use `http://127.0.0.1:<port>`, and the old POST instructions (if any survive the sweep) still work. The directives are complementary, not conflicting.

## Dependencies

Depends on **Deterministic Port Selection So Discovery Never Depends On A File**. Do not start this until that has landed and its verification step 3 (server reachable with the port file deleted) passes.

## Adversarial Synthesis

Key risks: (1) the `cliPath` plumbing through `PromptBuilderOptions` is underspecified — without naming the options field and call site, the directive export function could exist but never be wired into the builder, making it a no-op in every prompt; (2) dynamically constructed port references (`portRef` at line 2029) need the same CLI-form rewrite as static POST instructions, or a reviewer fragment will still tell the agent to read the port file; (3) standalone CLI path resolution via `process.argv[1]` is fragile in dev mode — `__dirname` is the reliable primary path for webpack bundles. Mitigations: specify `PromptBuilderOptions.cliPath` and the call site at line 1838 explicitly; note dynamic `portRef` constructions are in scope; use `__dirname` as primary resolution with `process.argv[1]` as fallback.

## Proposed Changes

**1. Two new subcommands — `src/standalone/cli.ts`.**

```
switchboard done --from <seat> [--plan <planId>] [--outcome failed] [--json]
switchboard next --from <seat> [--json]
```

Thin clients over the existing routes — no new server surface. They resolve the port via `findRunningInstance` (post-fix: probe-first), POST the body the route already accepts, and map the result onto exit codes matching the `dispatch` convention already documented in `switchboard help`:

```
0 accepted   1 offline   3 refused   4 auth failed   5 bad input   6 unavailable
```

Register in the `help` output and the front-door menu alongside `plans` / `ready` / `dispatch`.

**2. CLI-path injection — both composition roots and the prompt builder.**

Add a sibling to `SWITCHBOARD_LIVENESS_DIRECTIVE` (`agentPromptBuilder.ts:838`), which already takes the resolved `port` and is the established injection seam:

```ts
export const SWITCHBOARD_CLI_DIRECTIVE = (cliPath: string) =>
  `SWITCHBOARD CLI: run \`node "${cliPath}" <command>\` for board callbacks. ` +
  `Do not build HTTP requests by hand and do not read .switchboard/api-server-port.txt.`;
```

**Prompt builder wiring (the seam the plan must name explicitly):** Add `cliPath?: string` to `PromptBuilderOptions` (`agentPromptBuilder.ts:208`). At the call site alongside `SWITCHBOARD_LIVENESS_DIRECTIVE` (line 1838), add:

```ts
const cliBlock = (options?.cliPath)
    ? SWITCHBOARD_CLI_DIRECTIVE(options.cliPath)
    : '';
```

Without this, the export function exists but is never called — every prompt silently omits the CLI directive. This is the same options-object seam trap the composition-root warnings name.

- **Extension root** — `src/services/TaskViewerProvider.ts` / `src/services/KanbanProvider.ts`: resolve `path.join(context.extensionUri.fsPath, 'dist', 'standalone', 'cli.js')`. `extensionUri.fsPath` is already threaded through the activation path (`extension.ts:326`). Thread it into the `PromptBuilderOptions` object wherever `apiPort` is already threaded (the call sites at `KanbanProvider.ts:6164, 6202, 6246` that pass `apiPort`).
- **Standalone root** — `src/standalone/bootstrap.ts`: resolve from `__dirname` (primary — webpack sets it to the bundle's directory at build time) with `process.argv[1]` as fallback. `process.argv[1]` alone is fragile in dev mode (points at TypeScript source, not the webpack bundle). `__dirname` is reliable in both webpack-bundled and dev modes.

Both roots must pass it. This is an options-object field where "never wired" and "working" are indistinguishable without reading the composition root — the precedent CLAUDE.md names for exactly this class of divergence.

**3. Rewrite the prompt fragments.**

Replace the POST instruction in the completion and queue fragments with the command form:

| current | becomes |
|---|---|
| `POST /kanban/queue/done with {"from":"X"} against the port in …` | `node "<cliPath>" done --from X` |
| `POST /kanban/queue/next with {"from":"X"} against the port in …` | `node "<cliPath>" next --from X` |
| `POST /terminals/verb/ptySendPrompt with {...}` | `node "<cliPath>" verb ptySendPrompt '<json>'` |

Sites: `agentPromptBuilder.ts:1091, 1158, 1160, 2031, 2067`; `standingOrderFragments.ts:55, 82, 130, 135`; `teamWiring.ts:209, 244, 280, 640, 642, 654, 661`; `PlanIngestionEngine.ts:1544, 1779`; `standingOrders.ts:683`; `linkPresets.ts:107`; `schedulerPresets.ts:18`.

Keep `agentPromptBuilder.ts:1060` (the researcher hand-off) on HTTP for now — it is the one fragment that already degrades correctly when the file is missing, and converting it is unrelated risk.

**Dynamic port-reference constructions are in scope.** `portRef` at `agentPromptBuilder.ts:2029-2031` branches on `apiPort` to produce either `http://127.0.0.1:${options.apiPort}` or `'the port in .switchboard/api-server-port.txt'`. This dynamic pattern feeds reviewer/lead fragments (the `ptySendPrompt` relay, the fix-delegation instruction). Each instance must be rewritten to use the CLI command form (`node "<cliPath>" verb ptySendPrompt '<json>'`), not just the static POST sites listed above. Grep for `portRef` and `api-server-port.txt` across `agentPromptBuilder.ts` to find all dynamic constructions.

**4. Fix the self-defeating bypass — `KanbanProvider.ts:5723`.**

`_resolveRosterAndPort` reads the port file from disk to decide whether it can *avoid* telling the agent to read the port file. It should ask the object graph it is already inside: `this._taskViewerProvider?.getLocalApiServerPort()`, which the same class already calls at lines 6164, 6202 and 6246, with the file as fallback. This is a real defect independent of the CLI work and is small enough to carry here. **Note:** this fix is NOT dead code after the fragment rewrite — `_resolveRosterAndPort` feeds `_buildBatchDrivePrefix` (line 5743), a surface the fragment sweep does not touch. The batch drive prefix still emits `portLine`; this fix makes that `portLine` correct (resolved from the live server, not the file) even in the old format.

**5. The HTTP routes stay, because the CLI calls them.** `/kanban/queue/done`, `/kanban/queue/next`, `/kanban/move` and the verb rails are the transport the new subcommands use, so they remain for that reason alone — not for backward compatibility. Nothing needs to keep working for an older agent contract, because that contract never shipped. Update the skill docs that reference the raw POST (`agentGroupInstantiation.ts:277`) to the command form in the same pass; do not leave both documented.

## Verification Plan

### Automated Tests

No automated test suite covers the prompt-fragment or CLI-subcommand surface — these are integration-level checks requiring a running host and a dispatched agent. The verification steps below are manual integration checks against both composition roots. (Session directive: automated tests are not executed in this run; the checks remain documented for the implementer.)

**CLI surface:**
1. `switchboard done --from <seat>` against a live server → exit 0, card's activity light clears, lead notified — same observable effect as the equivalent POST.
2. Same command with the server stopped → exit 1 and a legible offline message, not a stack trace.
3. `switchboard next --from <seat>` returns a card and moves it, matching `POST /kanban/queue/next` exactly.
4. `--json` on both emits the documented envelope; `help` lists both subcommands.

**Extension root:**
5. Dispatch a coder from the extension. Its prompt contains an absolute `node "…/dist/standalone/cli.js"` path and **no** `.switchboard/api-server-port.txt` reference.
6. Confirm that path exists inside a packaged VSIX: `npx vsce package`, unzip, `ls extension/dist/standalone/cli.js`. This is the load-bearing assumption of the whole plan and must be checked against a real package, not the repo tree.
7. Run the injected command verbatim from the agent's worktree cwd → exit 0.

**Standalone root:**
8. Dispatch a coder under `switchboard tailnet`. Same two assertions as step 5.
9. Run the injected command verbatim → exit 0.
10. Diff the two composition roots by hand and confirm both pass `cliPath`. A verb-reachability audit cannot catch a missing injection here.

**Sweep:**
11. Grep the built `dist/` for surviving `api-server-port.txt` strings in agent-facing prompt text. The only expected hit is the researcher hand-off (`agentPromptBuilder.ts:1060`), carved out above because it belongs to a different feature and already degrades correctly when the file is absent.

### Goal Invariants

- **Negative:** Dispatched agent prompts (coder, lead, reviewer, intern) do NOT contain the string `api-server-port.txt` in completion, queue, or escalation instructions — the only exception is the researcher hand-off at `agentPromptBuilder.ts:1060`.
- **Positive:** Dispatched agent prompts contain an absolute `node "<cliPath>"` path in a `SWITCHBOARD CLI:` directive, where `<cliPath>` resolves to an existing `dist/standalone/cli.js` file.
- **Positive:** `switchboard done --from <seat>` exits 0 against a live server and produces the same server-side effect (card activity light clears, lead notified) as `POST /kanban/queue/done` with `{"from":"<seat>"}`.
- **Positive:** `switchboard next --from <seat>` exits 0 against a live server and returns a card, matching `POST /kanban/queue/next` with `{"from":"<seat>"}`.
- **Negative:** `PromptBuilderOptions` in `agentPromptBuilder.ts` does NOT lack a `cliPath` field — the field is present and the `SWITCHBOARD_CLI_DIRECTIVE` call site at line ~1838 emits the directive when `cliPath` is set.
- **Positive:** Both composition roots (extension `TaskViewerProvider.ts` and standalone `bootstrap.ts`) pass a non-empty `cliPath` string into the prompt builder options object when the server is running.

## Implementation Summary

Added `done` and `next` subcommands to `src/standalone/cli.ts` routing to `/kanban/queue/done` and `/kanban/queue/next` with standard exit codes and `--json` envelope support. Extended `PromptBuilderOptions` in `src/services/agentPromptBuilder.ts` with `cliPath`, exported `SWITCHBOARD_CLI_DIRECTIVE`, and wired CLI command invocations into prompt templates across extension and standalone composition roots (`KanbanProvider.ts`, `TaskViewerProvider.ts`, `bootstrap.ts`). Replaced direct HTTP POST and `.switchboard/api-server-port.txt` references in standing orders, presets, webviews, and prompt directives (including `SWITCHBOARD_LIVENESS_DIRECTIVE` and `SWITCHBOARD_CLI_DIRECTIVE`) with CLI command invocations, and updated contract tests accordingly. Fixed `KanbanProvider._resolveRosterAndPort` to query `getLocalApiServerPort()` before falling back to reading the port file.

## Review Findings

Reviewed commit `70e29af9`; the CLI half shipped three defects that made it a no-op or worse. **(1)** `done` and `next` were dispatched in `main()` but never added to `KNOWN_SUBCOMMANDS` (cli.ts:2033), which sits ~700 lines above the handlers — both subcommands answered `Unknown subcommand 'done'` and exited 1, so the feature's entire premise did not work; they were also missing from the `subcommandTargetsCwd` exclusion list, so running one in a directory without `.switchboard/` created one, violating the never-mkdir rule. **(2)** Every rewritten fragment emitted the literal string `<cliPath>` — no substitution existed anywhere — so every dispatched agent was told to run `node "<cliPath>" done`; fixed with `src/utils/cliPathToken.ts` (token + host seam + `__dirname` fallback) substituting at the two emission seams (`renderStandaloneOrdersBlock`/`applyStandingOrders` and a new `finalizeAgentPrompt` on every `buildKanbanBatchPrompt`/`buildCustomAgentPrompt` return) plus the two `PlanIngestionEngine` nudges, with both composition roots priming it. **(3)** The reviewer escalation and `BOARD_DRIVING_CONTRACT` were rewritten to `verb moveCard`, a verb that does not exist (`verbSchemas.ts` has only `moveCardForward`/`moveCardBackwards`, and both take a `sessionIds` array, not a `planId`) — restored to `POST /kanban/move` against the injected port. Also repaired: the incoherent step-1 fragment whose `GET /kanban/plan` was deleted but whose "if the response shows…" branches were kept, three `POST` instructions left with no address at all, two sweep sites the plan named or implied (`agentGroupInstantiation.ts:277`, `LocalApiServer.ts:750`), a mangled docblock, `terminals.js`'s un-updated `NEW_CODING_HEAD_PROMPT_CLIENT` mirror, and the CLI's missing "queue empty" plain-text line and unguarded `apiPost` rejection.

Files changed: `src/utils/cliPathToken.ts` (new), `src/standalone/cli.ts`, `src/standalone/bootstrap.ts`, `src/services/{agentPromptBuilder,standingOrders,standingOrderFragments,teamWiring,schedulerPresets,PlanIngestionEngine,KanbanProvider,TaskViewerProvider,LocalApiServer,agentGroupInstantiation}.ts`, `src/webview/{kanban.html,terminals.js}`, and six contract tests. Validation: `tsc -p tsconfig.test.json` clean; `eslint` 0 errors; `npm run compile` clean and `dist/standalone/cli.js` present; all 151 `test:contract:*` suites run and compared against a `git archive` of `70e29af9^` — the four suites this commit turned red (`coding-head-prompt`, `link-presets-mirror`, `queue-pipeline`, `review-team-triage`) plus `drive-mode-prompt-overhaul` are green again, and no new failures were introduced. `switchboard done`/`next` now exit 5 with the documented usage and `--json` envelope on a missing `--from`, exit 1 with a legible offline message when no server answers, and create no `.switchboard/`; substitution was verified end-to-end by rendering a real standing-orders block and a real coder prompt (no `<cliPath>` survives, a concrete `cli.js` path appears). `test:contract:cli-board-commands` and `test:contract:queue-pipeline` — both CI-wired — now carry discriminating assertions for subcommand reachability and for token substitution respectively, so neither defect can regress silently.

## Deferred Findings

- MAJOR `src/services/teamWiring.ts:1370` — with `test:contract:standing-orders-marker` un-crashed (see below), five `wireSpawnedTeam` assertions fail: it installs 2 standing orders where the contract requires 3 (team prompt + team-head prompt + team-head completion). Pre-existing at `70e29af9^`; the gate had been crashing so nobody saw it. Out of this plan's scope.
- MAJOR `src/test/completion-asserted-never-inferred.test.js:270` — the source-scan for `CONTEXT_AWARE_COMPLETION_ORDER_BODY` slices to the first `\n}`, which now captures only the one-line delegation to `buildMemberCompletionFragment`, so the scan can never see the body it asserts on. Pre-existing red; 2 of that suite's checks stay red for this reason.
- NIT `src/webview/terminals.js:11053` — the operator sees the literal `<cliPath>` when editing a team prompt in the panel: substitution happens at delivery, not in the editor. Cosmetic, but it invites an operator to "fix" the placeholder by hand.
- NIT `src/services/teamWiring.ts:1791` — `migrateCodingTeamOrders` recognises the V1/V2 legacy bodies and the new current body, so orders on disk carrying the *immediately previous* body are no longer recognised and keep their old POST text. Deliberate: the teams surface has never shipped, so a new recogniser would be a migration for nobody.
- NIT `src/standalone/cli.ts:1851` — the interactive front-door menu does not list `done`/`next`, which the plan asked for. They are agent callbacks, not operator menu items; `help` and `usage()` list both.
- NIT `src/webview/tickets.html:4631` — panel help text still documents reading `.switchboard/api-server-port.txt`. Outside the plan's named sites.
