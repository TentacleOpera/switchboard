# Generated agent prompts and skill docs tell agents to call the API with no credential — correct the instructions and the 401 diagnostics

## Goal

Make the system's own instructions to agents true under both hosts. Every generated prompt and skill doc that tells an agent to call the local API must name the credential and where to find it, the one doc that names a credential must stop naming a nonexistent one, and a 401 must explain itself to a headless caller.

### Problem Analysis

Switchboard generates prompt text instructing agents to call its own API, and that text omits the credential entirely. There are **39 references to `.switchboard/api-server-port.txt` across 10 source files** in `src/services/` (excluding tests), concentrated in:

- `teamWiring.ts` — 11 sites, including the reviewer/coder report-back instructions (`:63`, `:86`), the queue-seat `queue/next` and `queue/done` recipes (`:162`, `:187`, `:209`), and the per-subtask posting rules (`:343`, `:366`, `:400`).
- `agentPromptBuilder.ts` — 8 sites, including `COMPLETION_STEP_COMPACT` (`:1098`), the completion report every reviewer is handed.
- `TaskViewerProvider.ts` — 7 sites, including the memo-processing prompt's feature-creation branch (`:6943`).
- `KanbanProvider.ts` — 5 sites.
- `PlanIngestionEngine.ts` — 2 sites: the queue-card completion POST (`:1661`) and the queue-stall backstop (`:1896`).
- `standingOrders.ts` (`:575`), `agentGroupInstantiation.ts`, `linkPresets.ts`, `schedulerPresets.ts` — 1 each.

The canonical shape is *"POST `/kanban/queue/done` with `{"from":"<seat>"}` against the port in `.switchboard/api-server-port.txt`"*. Under the extension host that is complete and correct, because `_checkAuth` short-circuits to loopback trust when the expected token is empty (`src/services/LocalApiServer.ts:883`). Under `npx switchboard` it is an instruction to do something impossible, and the agent following it fails silently — a completion report never posted, a queue seat never released, a stall backstop that never fires.

A handful of in-tree presets *do* emit the header, so the codebase already disagrees with itself. `linkPresets.ts` and the link-relay recipe in `src/webview/terminals.js:11453` send `Authorization: Bearer $SWITCHBOARD_API_TOKEN` unconditionally, and the plan record at `.switchboard/plans/feature_plan_20260813060000_researcher-relationship-has-no-return-path.md:104` names the split precisely — noting that `reports-to-head` omits the header "and would therefore fail under standalone", explicitly deferred as out of scope at the time. That deferral is what this plan closes.

Two further problems compound it:

**The one doc that mentions auth names a credential that does not exist.** `.agents/skills/switchboard-orchestration/SKILL.md:34-36` reads: *"If a token is set in VS Code (`Switchboard: Api Token`), pass `Authorization: Bearer <token>`; if none is set, any localhost..."*. There is no `Switchboard: Api Token` setting and no setter UI; the extension's `getAuthToken()` reads a SecretStorage key nothing writes (`src/services/TaskViewerProvider.ts:3721-3724`) and always returns `''`. So the sole auth documentation points at a phantom setting for the host that needs no credential, and never mentions the standalone token that actually exists. Roughly 20 further docs under `.agents/` reference the port file with no auth guidance at all.

**The 401 body is written for a browser.** `_sendUnauthorized` (`src/services/LocalApiServer.ts:922-928`) returns *"Invalid or missing session. Open the board URL from a fresh `npx switchboard` launch to obtain a session cookie."* Delivered to a headless agent, that is unactionable: it has no browser, and the remedy it needs — read the token file, or send the env var — is not mentioned.

### Root Cause

The prompt text encodes the *extension* host's contract as if it were the system's contract. It was authored when there was one host and no auth, and the standalone host's arrival added a credential requirement to the wire protocol without anyone re-auditing the ~39 places where that protocol is described in prose to agents. Because the instructions are strings rather than code, no compiler, test or parity check could notice — and because the extension host still works, no one running the extension ever sees a failure.

### Non-goals

- **Publishing or consuming the credential.** Covered by the publication and client plans; this plan changes instructions and diagnostics only.
- **Changing any endpoint, payload or verb.** Text only, plus the two error-string sites.
- **Rewriting the presets that already send the header correctly.** `linkPresets.ts` and the `terminals.js` relay recipe are already right; leave them, and use them as the reference wording.

## Metadata

**Complexity:** 3
**Tags:** docs, backend, auth, api, reliability

## Proposed Changes

1. **Define one canonical auth clause** and put it in a single exported constant — `agentPromptBuilder.ts` is the natural home, beside `COMPLETION_STEP_COMPACT`. Every generated prompt interpolates that constant instead of restating the recipe. This is the load-bearing change: 39 hand-written copies is precisely why the credential is missing from all of them, and 39 hand-edited copies would drift again.

2. **Word the clause to work under both hosts, with no host detection.** Instruct the agent to send `Authorization: Bearer $SWITCHBOARD_API_TOKEN` when that variable is set, otherwise to read `.switchboard/api-server-token.txt` beside the port file, and to send no header if neither exists. Following it verbatim succeeds on both hosts, which is the only way a single string can be correct in both. Use `$SWITCHBOARD_API_TOKEN` by name so the shell expands it and **the token never enters the agent's scrollback or conversation history** — the property `ptyFleetService.ts:363-373` was designed for.

3. **Replace all 39 port-file references** across `teamWiring.ts` (11), `agentPromptBuilder.ts` (8), `TaskViewerProvider.ts` (7), `KanbanProvider.ts` (5), `PlanIngestionEngine.ts` (2), `standingOrders.ts`, `agentGroupInstantiation.ts`, `linkPresets.ts` and `schedulerPresets.ts` (1 each) with the interpolated constant. Two exceptions to leave alone: the sites already emitting the header correctly, and the `agentPromptBuilder` fallback path guarded by the test at `src/services/__tests__/agentPromptBuilder.test.ts:937-954`, which asserts on the exact port-file string — update that assertion deliberately rather than working around it.

4. **Rewrite `switchboard-orchestration/SKILL.md:34-36`.** Delete the `Switchboard: Api Token` claim outright — it is a phantom. State the real model: the extension host is loopback-trusted and needs no credential; the standalone host requires a bearer token, discoverable from `$SWITCHBOARD_API_TOKEN` or the token file. This file is the primary auth reference for external tools, so it carries the full explanation while other docs point at it.

5. **Add the canonical clause to the docs that describe HTTP calls** — `.agents/skills/kanban_operations/SKILL.md`, `.agents/protocols/switchboard-mission-control-http/SKILL.md`, `.agents/protocols/external-team-lead/SKILL.md` (whose line 30 has the same phantom-token wording), `.agents/workflows/switchboard.md`, and the `create-feature*` skill docs. One clause, cross-referencing the orchestration skill rather than restating it.

6. **Rewrite `_sendUnauthorized`** (`src/services/LocalApiServer.ts:922-928`) to serve both audiences. Keep the browser remedy, add the agent one: send `Authorization: Bearer` with the value of `$SWITCHBOARD_API_TOKEN` or `.switchboard/api-server-token.txt`. Machine-readable enough for an agent to act on without prose parsing — a stable `code` field alongside the human `detail`.

7. **Correct the stale comment at `src/services/LocalApiServer.ts:915-921`.** It says the extension "has no API-token setter UI, so `getAuthToken()` is empty there and auth is localhost-trust" — true, but it presents that as incidental when it is the load-bearing reason the two hosts diverge. State it as the contract, and cross-reference the CSRF guard as the compensating control.

8. **Correct the comment at `src/services/teamWiring.ts:51`**, which claims the port file and `SWITCHBOARD_API_TOKEN` mean "the call is available to it". That is true only for a pty-fleet child; make the precondition explicit.

9. **Add a guard test** — `src/test/agent-prompt-auth-clause-contract.test.js`. Assert that every generated prompt string mentioning `api-server-port.txt` also carries the auth clause. This is the gate that did not exist; without it the next prompt author reintroduces the bug. Enumerate the prompt builders explicitly rather than grepping the tree, so a new prompt file must be consciously added.

## Edge-Case & Dependency Audit

- **The clause must not become a token-pasting instruction.** Agents must be told to reference the env var *by name in a shell command*, never to read the token and interpolate it into text. A token pasted into a prompt lands in the recipient's scrollback and conversation history — the exact reasoning recorded at `feature_plan_20260812120000_head-agent-terminal-dispatch-pattern.md:147`. Review the final wording specifically against this failure.
- **Prompt length.** These strings are injected into agent prompts that are already long; `COMPLETION_STEP_COMPACT` is named "compact" for a reason. Keep the clause to one sentence, and prefer a single reference to the orchestration skill over an inline recipe wherever the agent can be assumed to have skill access.
- **The token file does not exist yet** until the publication plan lands. The clause's third branch ("send no header if neither exists") means the wording is correct in the interim: on the extension host it is accurate today, and on standalone it is no worse than the current silence. So this plan can ship before the others.
- **Tests assert on the current strings.** `src/services/__tests__/agentPromptBuilder.test.ts:937-954` checks for the literal port-file text on the fallback path, and the headless/parity contract tests may grep prompt text. Find every such assertion before editing, and update them as deliberate contract changes.
- **Do not touch `.switchboard/plans/*.md`.** Many historical plan files quote the old recipe. They are a record of what was done, not instructions; rewriting them would falsify the archive.
- **`.agents/` vs `.claude/skills/`.** Both trees carry skill docs. Determine which is distributed and which is a mirror before editing, or the fix lands in the copy nobody reads.

## Dependencies

- **`publish-agent-api-token-for-out-of-process-agents.md`** — soft. The instructions name a file that plan creates. The clause's fallback branch keeps it correct beforehand, so this plan may ship first; if it does, verification step 4 is deferred until the token file exists.

## Verification Plan

1. `npm run compile` — 0 errors.
2. `node --test src/test/agent-prompt-auth-clause-contract.test.js` — new guard green.
3. `grep -rn "api-server-port.txt" --include=*.ts src/services/ | grep -v __tests__` — every remaining hit either interpolates the shared constant or is one of the two documented exceptions. Confirm the count dropped from 39 accordingly.
4. **End-to-end under standalone, the case that is broken today.** Run `npx switchboard`, dispatch a card to a fleet terminal, and confirm the coding agent's `queue/done` POST — following only the generated prompt text — actually succeeds. Repeat for a reviewer's `COMPLETION_STEP_COMPACT` report.
5. Same dispatch under the extension host: agents must still succeed, sending no header.
6. Trigger a 401 from a terminal and confirm the body names the env var and the token file, carries a stable `code`, and reads sensibly to both a human and an agent.
7. `node --test src/services/__tests__/agentPromptBuilder.test.ts` plus the headless and parity contract suites — green, with any changed assertions reviewed as intentional.
8. Read the rendered `switchboard-orchestration/SKILL.md` auth section end to end and confirm no reference to `Switchboard: Api Token` survives anywhere in the tree: `grep -rn "Switchboard: Api Token" .` returns nothing outside `.switchboard/plans/`.
9. Grep every generated prompt for a literal token value to confirm none interpolates a secret: dispatch under standalone and inspect the delivered prompt text.

## Outstanding Questions

- Should the queue-seat prompts in `teamWiring.ts` carry the full clause or a pointer to the orchestration skill? Depends on whether queue-seat agents are reliably given skill access; check how those personas are launched before choosing.
