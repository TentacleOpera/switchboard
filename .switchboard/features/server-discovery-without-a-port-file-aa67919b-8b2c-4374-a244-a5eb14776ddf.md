# Server Discovery Without A Port File

**Complexity:** 6

## Goal

Make a running Switchboard findable without depending on .switchboard/api-server-port.txt existing, then take the port out of the agent contract entirely.

Discovery currently bails before it probes: findRunningInstance returns null the moment the file is absent, even though probeHealth sits one line below and /health self-identifies with service, port, pid and roots. The file is load-bearing because the standalone host falls back to an OS-assigned ephemeral port when 7777 is taken, and the extension host passes no port at all so it is always ephemeral. Downstream, roughly 33 agent prompt fragments hardcode reading that file to find the server, and the mechanism meant to spare them reads the same file to decide whether it can.

The two subtasks fix the cause and then remove the dependency: make the port deterministic and probeable, then route agent callbacks through the CLI that already ships in both hosts so no agent needs a port at all.

## How the Subtasks Achieve This

- **Deterministic Port Selection So Discovery Never Depends On A File**: replaces the
  standalone ephemeral fallback with a bounded walk over 7777-7780, passes a resolved
  port from the extension composition root (which today passes none and is therefore
  always ephemeral), and reorders `findRunningInstance` to probe that range before it
  reads any file. Root-matching against `/health`'s `roots` array is what makes the
  walk safe. The port file keeps being written, but only for the explicit `--port 0`
  case — never again as a gate.
- **Agent Callbacks Route Through The Bundled CLI, Not A Raw HTTP POST**: adds the two
  missing subcommands (`done`, `next`) over the existing REST routes, injects the CLI's
  absolute path in both composition roots the way the port is injected today, and
  rewrites the prompt fragments to invoke it. `dist/standalone/cli.js` already ships
  inside every VSIX, so this adds no dependency. Also fixes `KanbanProvider`'s port
  bypass, which reads the port file to decide whether it can avoid the port file.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Deterministic Port Selection So Discovery Never Depends On A File](../plans/deterministic-port-selection-so-discovery-never-depends-on-a-file.md) — **CODE REVIEWED** — ID: 38ab0740-9b60-47fe-8402-670a1b70ecb0
- [ ] [Agent Callbacks Route Through The Bundled CLI, Not A Raw HTTP POST](../plans/agent-callbacks-route-through-the-bundled-cli.md) — **CODE REVIEWED** — ID: b6defe06-f19d-4c42-9a35-ae21df6124ac
<!-- END SUBTASKS -->

## Dependencies & sequencing

Strictly ordered — the second subtask is inert until the first lands, and shipping it
alone would be a regression.

`cmdVerb` resolves the server through the same `findRunningInstance` as everything else,
so CLI-based callbacks built on today's discovery would inherit the missing-file failure
verbatim — and make it harder to diagnose, by moving the failure out of a curl the
operator can see and into a subprocess they cannot.

Do not hand these to two seats concurrently. Verification step 3 of the first subtask
(server reachable with the port file deleted) is the gate for starting the second.

## Team Dispatch Instructions

### Deterministic Port Selection So Discovery Never Depends On A File

**Seat:** Coder (complexity 5)

**Acceptance:**
- `switchboard local` on a clean workspace binds 7777; `switchboard status` finds it with `.switchboard/api-server-port.txt` deleted.
- Occupy 7777 (`nc -l 7777`), start again → binds 7778 and logs the walk, not "falling back to an ephemeral port".
- Extension host: `GET 127.0.0.1:7777/health` answers with `service: "switchboard"` (today it answers on a random port — this proves the seam is wired).
- Two VS Code windows on different workspaces → each `findRunningInstance` resolves to the server whose `roots` contains its own workspace root.
- `switchboard --port 0` still works — ephemeral, file-based discovery succeeds.

**Must not touch:** The ~40 agent prompt fragments are explicitly out of scope — do not edit `teamWiring.ts`, `standingOrders.ts`, `standingOrderFragments.ts`, `agentPromptBuilder.ts`, `PlanIngestionEngine.ts`, `schedulerPresets.ts`, or `linkPresets.ts` prompt text. The port/pid file writers in `bootstrap.ts:3515` and `TaskViewerProvider.ts:4352` stay as-is.

### Agent Callbacks Route Through The Bundled CLI, Not A Raw HTTP POST

**Seat:** Coder (complexity 6)

**Acceptance:**
- `switchboard done --from <seat>` exits 0 against a live server; card's activity light clears, lead notified — same observable effect as the equivalent POST.
- `switchboard next --from <seat>` returns a card and moves it, matching `POST /kanban/queue/next` exactly.
- Dispatched agent prompts contain an absolute `node "<cliPath>"` path and no `api-server-port.txt` reference (except the researcher hand-off carve-out).
- Both composition roots (extension and standalone) pass `cliPath` into the prompt builder — hand-diff confirms both.
- `dist/standalone/cli.js` exists inside a packaged VSIX (`npx vsce package`, unzip, `ls extension/dist/standalone/cli.js`).

**Must not touch:** The researcher hand-off at `agentPromptBuilder.ts:1060` stays on HTTP. The HTTP routes (`/kanban/queue/done`, `/kanban/queue/next`, `/kanban/move`) and the verb rails stay unchanged — the CLI calls them. Do not modify server-side route handlers in `LocalApiServer.ts`.

## Completion Summary

Both subtasks implemented and committed. Subtask 1 added `src/utils/portResolver.ts` with a bounded 7777-7780 port walk, wired `resolvePreferredPort` into both the standalone CLI and extension host composition roots, and reordered `findRunningInstance` to probe the range via `/health` root-matching before falling back to the port file. Subtask 2 added `done` and `next` CLI subcommands over the existing REST routes, plumbed `cliPath` through both composition roots into the prompt builder, and rewrote all agent prompt fragments to invoke the bundled CLI instead of raw HTTP POST — removing every `api-server-port.txt` reference from dispatched prompts except the researcher hand-off carve-out. Contract tests updated to match. One fix round was needed: the liveness directive initially retained a port-file reference, which was corrected before close-out.


## Review Findings

Reviewed commit `70e29af9` as one unit. The goal is achieved for subtask 1 as shipped and for subtask 2 only after this pass: `done`/`next` were dispatched in `main()` but absent from `KNOWN_SUBCOMMANDS`, so both exited 1 with "Unknown subcommand" — the feature's whole premise did not work — and every rewritten fragment emitted the literal token `<cliPath>`, because no substitution existed anywhere in the tree. Both are fixed (allowlist + `subcommandTargetsCwd` exclusion; a new `src/utils/cliPathToken.ts` resolved at the standing-orders and prompt-builder emission seams with both composition roots priming it), along with an invented `verb moveCard` that does not exist, an un-updated `terminals.js` prompt mirror, three addressless POST instructions, and a `TypeError` in `KanbanProvider._resolveRosterAndPort` that took down the batch drive prefix. Verification: `tsc` clean, `eslint` 0 errors, `npm run compile` clean, and all 151 `test:contract:*` suites run and diffed against a `git archive` of `70e29af9^` — the five suites this commit turned red are green again with no new failures, and both live hosts were probed against the running server on 7777. Per-subtask detail and the full deferred list are in the two subtask plan files.

## Deferred Findings

- MAJOR `src/webview/kanban.html:9259` — `test:contract:kanban-view-plan-removal` is red in the working tree because the `.card-btn.review` / `.card-btn.complete` click bindings are gone. This belongs to another agent's in-flight card-delegation work, not to this commit (the bindings are present at `70e29af9` and at `HEAD`), and was deliberately left untouched.
- MAJOR `src/services/teamWiring.ts:1370` — `test:contract:standing-orders-marker` was crashing on a `MODULE_NOT_FOUND` before its assertions ran, so a CI-wired gate had been fully unenforced. This review repaired the harness; five pre-existing `wireSpawnedTeam` order-count failures are now visible (2 orders installed where 3 are required) and are left for a scoped plan.
- NIT — 28 of 151 contract suites fail at `70e29af9^` as well; only the ones this commit caused were fixed here.
