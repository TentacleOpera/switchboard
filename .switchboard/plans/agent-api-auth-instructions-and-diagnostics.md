# Generated agent prompts and skill docs tell agents to call the API with no credential — correct the instructions and the 401 diagnostics

## Goal

Make the system's own instructions to agents true under both hosts. Every generated prompt and skill doc that tells an agent to call the local API must name the credential and where to find it, the one doc that names a credential must stop naming a nonexistent one, and a 401 must explain itself to a headless caller.

### Problem Analysis

Switchboard generates prompt text instructing agents to call its own API, and that text omits the credential entirely. There are **39 references to `.switchboard/api-server-port.txt` across 11 source files** in `src/services/` (excluding tests), concentrated in:

- `teamWiring.ts` — 11 sites, including the reviewer/coder report-back instructions (`:63`, `:86`), the queue-seat `queue/next` and `queue/done` recipes (`:162`, `:187`, `:209`), and the per-subtask posting rules (`:343`, `:366`, `:400`).
- `agentPromptBuilder.ts` — 8 sites, including `COMPLETION_STEP_COMPACT` (`:1129`), the completion report every reviewer is handed.
- `TaskViewerProvider.ts` — 7 sites, including the memo-processing prompt's feature-creation branch (`:6944`).
- `KanbanProvider.ts` — 5 sites.
- `LocalApiServer.ts` — 2 sites: the `task/complete` prompt-text builder (`:681`) and a file-system cleanup check (`:857`). The cleanup check (`file === 'api-server-port.txt.tmp'`) is NOT prompt text and must NOT be modified; only `:681` is a target.
- `PlanIngestionEngine.ts` — 2 sites: the queue-card completion POST (`:1661`) and the queue-stall backstop (`:1896`).
- `standingOrders.ts` (`:575`), `agentGroupInstantiation.ts` (`:232`), `linkPresets.ts` (`:107`), `schedulerPresets.ts` (`:18`) — 1 each.

The canonical shape is *"POST `/kanban/queue/done` with `{"from":"<seat>"}` against the port in `.switchboard/api-server-port.txt`"*. Under the extension host that is complete and correct, because `_checkAuth` short-circuits to loopback trust when the expected token is empty (`src/services/LocalApiServer.ts:881-884`). Under `npx switchboard` it is an instruction to do something impossible, and the agent following it fails silently — a completion report never posted, a queue seat never released, a stall backstop that never fires.

One in-tree preset emits the header correctly: the link-relay recipe in `src/webview/terminals.js:11453` sends `Authorization: Bearer $SWITCHBOARD_API_TOKEN` unconditionally, and the plan record at `.switchboard/plans/feature_plan_20260813060000_researcher-relationship-has-no-return-path.md:104` names the split precisely — noting that `reports-to-head` omits the header "and would therefore fail under standalone", explicitly deferred as out of scope at the time. That deferral is what this plan closes.

> **Superseded:** `linkPresets.ts` and the link-relay recipe in `src/webview/terminals.js:11453` send `Authorization: Bearer $SWITCHBOARD_API_TOKEN` unconditionally, and the plan record [...] names the split precisely.
> **Reason:** Verified at HEAD: `linkPresets.ts:104-107` (the `reports-to-head` preset) contains only the bare port-file reference with NO Authorization header anywhere in the file. Only `terminals.js:11453` emits the header. The original plan listed `linkPresets.ts` as an already-correct exception and told the implementer to leave it alone and use it as reference wording — both wrong. `linkPresets.ts` is one of the 39 sites that NEEDS the auth clause.
> **Replaced with:** Only `terminals.js:11453` is the correctly-emitting exception. `linkPresets.ts:107` is a target for the auth clause, not an exception.

Two further problems compound it:

**The one doc that mentions auth names a credential that does not exist.** `.agents/skills/switchboard-orchestration/SKILL.md:44-46` reads: *"If a token is set in VS Code (`Switchboard: Api Token`), pass `Authorization: Bearer <token>`; if none is set, any localhost..."*. There is no `Switchboard: Api Token` setting and no setter UI; the extension's `getAuthToken()` reads a SecretStorage key nothing writes (`src/services/TaskViewerProvider.ts:3722-3724`) and always returns `''`. So the sole auth documentation points at a phantom setting for the host that needs no credential, and never mentions the standalone token that actually exists. Roughly 20 further docs under `.agents/` reference the port file with no auth guidance at all.

**The 401 body is written for a browser.** `_sendUnauthorized` (`src/services/LocalApiServer.ts:922-928`) returns *"Invalid or missing session. Open the board URL from a fresh `npx switchboard` launch to obtain a session cookie."* Delivered to a headless agent, that is unactionable: it has no browser, and the remedy it needs — read the token file, or send the env var — is not mentioned.

### Root Cause

The prompt text encodes the *extension* host's contract as if it were the system's contract. It was authored when there was one host and no auth, and the standalone host's arrival added a credential requirement to the wire protocol without anyone re-auditing the ~39 places where that protocol is described in prose to agents. Because the instructions are strings rather than code, no compiler, test or parity check could notice — and because the extension host still works, no one running the extension ever sees a failure.

### Non-goals

- **Publishing or consuming the credential.** Covered by the publication and client plans; this plan changes instructions and diagnostics only.
- **Changing any endpoint, payload or verb.** Text only, plus the two error-string sites.
- **The 401 response *text* and the inline-401 de-duplication.** Already owned by `fix-401-auth-error-text.md`, which counted 34 inline `writeHead(401)` blocks across three different bodies and identified the same phantom `Switchboard: Api Token setting` independently. That plan centralizes them into one helper; this plan must not race it. Step 6 below is reduced to a dependency note accordingly.
- **Rewriting the preset that already sends the header correctly.** Only `terminals.js:11453` (the link-relay recipe) is already right; leave it, and use it as the reference wording. `linkPresets.ts` is NOT an exception — it needs the auth clause.

## Metadata

**Complexity:** 4
**Tags:** docs, backend, auth, api, reliability

## User Review Required

- None. The corrections to the Problem Analysis (file count, linkPresets.ts, line numbers) are factual fixes verified against HEAD; the approach (one canonical constant, interpolated everywhere) is unchanged from the original plan. The implementer may proceed.

## Complexity Audit

### Routine
- Replacing 39 port-file references with an interpolated constant — mechanical find-and-replace once the constant exists.
- Rewriting the orchestration skill's auth section — text edit.
- Correcting two stale comments — text edit.
- Adding the guard test — straightforward assertion-based contract test.

### Complex / Risky
- The auth clause wording must be correct under both hosts with no host detection — a single string that is true in two different security models. Getting the fallback branch wrong means either breaking the extension host (spurious 401s) or leaving standalone broken (silent failures).
- The liveness directive at `agentPromptBuilder.ts:812` tells agents to supersede port-file references with a direct URL — the auth clause must coexist with this directive without conflict (it does: the clause is about the Authorization header, the directive is about the URL).
- `LocalApiServer.ts:857` is a file-system cleanup check (`file === 'api-server-port.txt.tmp'`) that must NOT be swept into the replacement — a blind "replace all 39" would corrupt it.
- Test assertions at `agentPromptBuilder.test.ts:937-954` check for the literal port-file string on the fallback path — must be updated as deliberate contract changes, not worked around.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The constant is static; interpolation happens at prompt build time, not at request time.
- **Security:** The clause must not become a token-pasting instruction. Agents must be told to reference the env var *by name in a shell command*, never to read the token and interpolate it into text. A token pasted into a prompt lands in the recipient's scrollback and conversation history — the exact reasoning recorded at `feature_plan_20260812120000_head-agent-terminal-dispatch-pattern.md:147` and implemented at `src/standalone/ptyFleetService.ts:360-373`. Review the final wording specifically against this failure.
- **Side Effects:** Replacing 39 string references changes the text of every generated prompt. Any test that asserts on the literal old text will break — find and update all such assertions before editing.
- **Dependencies & Conflicts:**
  - `fix-401-auth-error-text.md` owns the 401 bodies; this plan owns the generated prompts and skill docs. See Dependencies section.
  - The token file `.switchboard/api-server-token.txt` does not exist in source yet (only referenced in plan files). The clause's fallback branch keeps the wording correct in the interim.
  - `.agents/` vs `.claude/skills/`: `switchboard-orchestration/SKILL.md` exists ONLY in `.agents/skills/`, not in `.claude/skills/`. Edit the `.agents/` copy.
  - Do not touch `.switchboard/plans/*.md`. Many historical plan files quote the old recipe. They are a record of what was done, not instructions; rewriting them would falsify the archive.

## Dependencies

- **`fix-401-auth-error-text.md`** — coordinate, do not duplicate. It owns the 401 bodies; this plan owns the generated prompts and skill docs. If it lands first, this plan supplies the agent-facing remedy text for its helper; if this one lands first, leave the 401 bodies untouched. Note: that plan cites `LocalApiServer.ts:352-377` and `TaskViewerProvider.ts:1232` for the auth gate and secret read; at HEAD the gate is `:881-912` and the secret read is `:3722-3724` — re-verify its site inventory against HEAD before implementing it, since the file has moved underneath it.
- **`publish-agent-api-token-for-out-of-process-agents.md`** — soft. The instructions name a file that plan creates. The clause's fallback branch keeps it correct beforehand, so this plan may ship first; if it does, verification step 4 is deferred until the token file exists.

## Adversarial Synthesis

Key risks: (1) the auth clause wording must be correct under both hosts with no host detection — a single string true in two security models; (2) `LocalApiServer.ts:857` is a cleanup check that a blind "replace all" would corrupt; (3) `linkPresets.ts` was falsely listed as already-correct and must be fixed, not skipped; (4) test assertions on literal port-file strings will break and must be updated deliberately. Mitigations: enumerate prompt-text sites explicitly (not grep-and-replace-all), exclude the cleanup site by name, correct the linkPresets.ts classification, and update test assertions as intentional contract changes.

## Proposed Changes

### 1. Define one canonical auth clause

`agentPromptBuilder.ts` is the natural home, beside `COMPLETION_STEP_COMPACT` (`:1129`). Export a constant — e.g. `API_AUTH_CLAUSE` — that every generated prompt interpolates instead of restating the recipe. This is the load-bearing change: 39 hand-written copies is precisely why the credential is missing from all of them, and 39 hand-edited copies would drift again.

### 2. Word the clause to work under both hosts, with no host detection

Instruct the agent to send `Authorization: Bearer $SWITCHBOARD_API_TOKEN` when that variable is set, otherwise to read `.switchboard/api-server-token.txt` beside the port file, and to send no header if neither exists. Following it verbatim succeeds on both hosts, which is the only way a single string can be correct in both. Use `$SWITCHBOARD_API_TOKEN` by name so the shell expands it and **the token never enters the agent's scrollback or conversation history** — the property `src/standalone/ptyFleetService.ts:360-373` was designed for.

### 3. Replace all prompt-text port-file references with the interpolated constant

Across `teamWiring.ts` (11), `agentPromptBuilder.ts` (8), `TaskViewerProvider.ts` (7), `KanbanProvider.ts` (5), `LocalApiServer.ts` (1 — the `:681` prompt-text builder only), `PlanIngestionEngine.ts` (2), `standingOrders.ts` (1), `agentGroupInstantiation.ts` (1), `linkPresets.ts` (1), and `schedulerPresets.ts` (1).

**Explicit exclusions — do NOT touch:**
- `LocalApiServer.ts:857` — file-system cleanup check (`file === 'api-server-port.txt.tmp'`), not prompt text.
- `terminals.js:11453` — the link-relay recipe already emits `Authorization: Bearer $SWITCHBOARD_API_TOKEN` unconditionally; leave it as the reference wording.
- The `agentPromptBuilder` fallback path guarded by the test at `src/services/__tests__/agentPromptBuilder.test.ts:937-954`, which asserts on the exact port-file string — update that assertion deliberately rather than working around it.

> **Superseded:** Replace all 39 port-file references [...] Two exceptions to leave alone: the sites already emitting the header correctly, and the `agentPromptBuilder` fallback path [...]
> **Reason:** The original instruction "replace all 39" was ambiguous about the `LocalApiServer.ts:857` cleanup check, which is a file-system operation (`file === 'api-server-port.txt.tmp'`), not prompt text — a blind replacement would corrupt it. The original also listed `linkPresets.ts` as an already-correct exception, but `linkPresets.ts:107` has no Authorization header and needs the clause.
> **Replaced with:** Enumerate prompt-text sites explicitly. Exclude `LocalApiServer.ts:857` (cleanup check) and `terminals.js:11453` (already correct). `linkPresets.ts:107` IS a target. Update the test assertion at `agentPromptBuilder.test.ts:937-954` as a deliberate contract change.

### 4. Rewrite `switchboard-orchestration/SKILL.md:44-46`

Delete the `Switchboard: Api Token` claim outright — it is a phantom. State the real model: the extension host is loopback-trusted and needs no credential; the standalone host requires a bearer token, discoverable from `$SWITCHBOARD_API_TOKEN` or the token file. This file is the primary auth reference for external tools, so it carries the full explanation while other docs point at it.

### 5. Add the canonical clause to the docs that describe HTTP calls

`.agents/skills/kanban_operations/SKILL.md`, `.agents/protocols/switchboard-mission-control-http/SKILL.md` (which has the same phantom `Switchboard: Api Token` wording at `:45`), `.agents/workflows/switchboard.md`, and the `create-feature*` skill docs. One clause, cross-referencing the orchestration skill rather than restating it.

> **Superseded:** `.agents/protocols/external-team-lead/SKILL.md` (whose line 30 has the same phantom-token wording) [...]
> **Reason:** Verified at HEAD: `external-team-lead/SKILL.md:30` says "from environment `SWITCHBOARD_API_TOKEN` or settings" — it correctly names the env var and does NOT reference "Switchboard: Api Token." It is already closer to correct than the orchestration skill. The fix there is minor (drop the vague "or settings" and cross-reference the orchestration skill), not a wholesale rewrite.
> **Replaced with:** `external-team-lead/SKILL.md:30` needs only a minor touch-up: replace "or settings" with a cross-reference to the orchestration skill's auth section. It is NOT in the same category as the orchestration skill's phantom-setting claim.

### 6. Do not touch the 401 body here — supply its agent-facing wording to `fix-401-auth-error-text.md` instead

That plan owns centralizing the 34 inline 401 blocks into one helper, and two plans editing the same bodies would conflict. What this plan contributes is the *content* that helper should carry once the agent token exists: the remedy for a headless caller is to send `Authorization: Bearer` with `$SWITCHBOARD_API_TOKEN` or the value in `.switchboard/api-server-token.txt`, plus a stable `code` field so an agent need not parse prose. Note also that `fix-401-auth-error-text.md` cites `LocalApiServer.ts:352-377` and `TaskViewerProvider.ts:1232`, whereas at HEAD the gate is `:881-912` and the secret read is `:3722-3724` — **re-verify its site inventory against HEAD before implementing it**, since the file has moved underneath it.

### 7. Correct the stale comment at `src/services/LocalApiServer.ts:915-921`

It says the extension "has no API-token setter UI, so `getAuthToken()` is empty there and auth is localhost-trust" — true, but it presents that as incidental when it is the load-bearing reason the two hosts diverge. State it as the contract, and cross-reference the CSRF guard as the compensating control.

### 8. Correct the comment at `src/services/teamWiring.ts:51`

It claims the port file and `SWITCHBOARD_API_TOKEN` mean "the call is available to it". That is true only for a pty-fleet child (which receives the env var via `src/standalone/ptyFleetService.ts:370-373`); make the precondition explicit.

### 9. Add a guard test

`src/test/agent-prompt-auth-clause-contract.test.js`. Assert that every generated prompt string mentioning `api-server-port.txt` also carries the auth clause. This is the gate that did not exist; without it the next prompt author reintroduces the bug. Enumerate the prompt builders explicitly rather than grepping the tree, so a new prompt file must be consciously added.

## Verification Plan

### Automated Tests
1. `npm run compile` — 0 errors.
2. `node --test src/test/agent-prompt-auth-clause-contract.test.js` — new guard green.
3. `grep -rn "api-server-port.txt" --include=*.ts src/services/ | grep -v __tests__` — every remaining hit either interpolates the shared constant, is the `LocalApiServer.ts:857` cleanup check (excluded), or is the `agentPromptBuilder` fallback path (test-updated). Confirm the count of raw hits that are NOT the cleanup check dropped from 38 to 0 uninterpolated prompt-text sites.
4. **End-to-end under standalone, the case that is broken today.** Run `npx switchboard`, dispatch a card to a fleet terminal, and confirm the coding agent's `queue/done` POST — following only the generated prompt text — actually succeeds. Repeat for a reviewer's `COMPLETION_STEP_COMPACT` report.
5. Same dispatch under the extension host: agents must still succeed, sending no header.
6. Trigger a 401 from a terminal and confirm the agent can act on what it gets. If `fix-401-auth-error-text.md` has landed, the body names the env var and the token file and carries a stable `code`; if it has not, confirm only that this plan changed no 401 body.
7. `node --test src/services/__tests__/agentPromptBuilder.test.ts` plus the headless and parity contract suites — green, with any changed assertions reviewed as intentional.
8. Read the rendered `switchboard-orchestration/SKILL.md` auth section end to end and confirm no reference to `Switchboard: Api Token` survives anywhere in the tree: `grep -rn "Switchboard: Api Token" .` returns nothing outside `.switchboard/plans/`.
9. Grep every generated prompt for a literal token value to confirm none interpolates a secret: dispatch under standalone and inspect the delivered prompt text.

### Goal Invariants
- Assert `API_AUTH_CLAUSE` (or equivalent named export) exists in `src/services/agentPromptBuilder.ts` and its value contains the string `SWITCHBOARD_API_TOKEN`.
- Assert `linkPresets.ts:107` (the `reports-to-head` preset template) interpolates or references the shared auth clause constant — not a bare port-file reference.
- Assert `LocalApiServer.ts:857` still contains the literal string `api-server-port.txt.tmp` (cleanup check untouched).
- Assert `src/services/__tests__/agentPromptBuilder.test.ts` no longer asserts the bare port-file string on the fallback path without also asserting the auth clause is present.
- Assert `grep -rn "Switchboard: Api Token" .agents/ .claude/` returns zero matches (phantom setting name purged from all distributed docs).
