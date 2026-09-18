# Switchboard Operator Skills: Dispatch, Clear Protocol, Query Semantics, and Fleet Monitoring

**Project:** Browser Switchboard
**Complexity:** 4
**Recommended Role:** coder

## Goal
Improve and align the operator-facing agent skills (`.agents/skills/kanban_operations/SKILL.md`, `.agents/skills/query-kanban/SKILL.md`, and `.agents/skills/switchboard-orchestration/SKILL.md`) with the actual operational reality of the Switchboard runtime.

### Context and Core Problem Analysis
During extended multi-turn operator sessions involving autonomous team leads, multi-role coder fleets, and mobile/remote control sessions, several critical operational gaps in the agent skills were identified:

1. **Dispatch Primitive Gap (`POST /kanban/dispatch` vs `move-card.js`):**
   `kanban_operations/SKILL.md` historically emphasized `move-card.js` (or `POST /kanban/move`), which only modifies card placement in the database. In standalone mode, `POST /kanban/move` may be unavailable, whereas the true execution primitive that boots terminals, resolves rosters, binds contexts, and delivers prompt payload is `POST /kanban/dispatch`.

2. **Terminal Clear / Reset Pitfall:**
   Agents frequently attempt to clear terminals by sending `/clear` through `ptySendPrompt`. Because `ptySendPrompt` encapsulates text in bracketed-paste escape sequences (`\x1b[200~ ... \x1b[201~`), terminal CLIs (Devin, Antigravity, Claude Code) receive literal `/clear` text rather than executing the clear command, leading to prompt pollution. The correct mechanism is `POST /terminals/verb/ptyClearTerminal`, which sends `\x15` (Ctrl+U) and `/clear\r` as direct unbracketed keystrokes.

3. **API Query Filter Misinterpretation (`GET /kanban/plans`):**
   `GET /kanban/plans?planId=<id>` does not perform single-plan filtering on the backend; it returns the entire workspace array. Agents consuming `res.data[0]` mistakenly inspect whichever card happens to be first in the DB (often from a different column), generating false reports.

4. **Ambiguous Fleet Completion Contracts:**
   When an operator requests progress monitoring until completion, agents must know the concrete signals of completion across the runtime (`completedAt` timestamp in the database, `Switchboard-Plan` git commit trailer, and `POST /kanban/queue/next` returning `{ "dispatched": null, "reason": "queue empty" }`).

5. **Remote & Mobile Network Addressing:**
   Operator guidance for reaching the board and terminals over Tailscale (`http://100.x.y.z:7777`) and understanding key-based SSH requirements when password authentication is hardened.

## Metadata

**Tags:** docs, refactor
**Complexity:** 4

## User Review Required

This plan modifies three distributed skill markdown files that operator agents and fleet coders rely on at runtime. The corrections below change what agents will be instructed to call (e.g. removing a non-existent endpoint, correcting a payload field). A user should review the corrected payload shapes and the placement of the `GET /kanban/plans` query-param warning (orchestration skill vs. query-kanban skill) before dispatching a coder, since an agent that learns the wrong shape from these docs will fail silently in production.

## Complexity Audit

### Routine
- Adding a new "Dispatching Cards & Features" section to `kanban_operations/SKILL.md` documenting an endpoint that already exists and is already documented in the orchestration skill — this is a cross-reference and copy-adapt task.
- Adding a "Terminal Reset & Clear Protocol" section to `switchboard-orchestration/SKILL.md` — the endpoint `POST /terminals/verb/ptyClearTerminal` is already listed in the skill's verb table (line 216); the new section adds the *why* (bracketed-paste pitfall) and the *when* (at-rest-only).
- Adding a "Fleet Completion Detection Recipe" section consolidating three signals already individually documented or present in the codebase.
- Adding a query-param warning to the orchestration skill's read-endpoint table.

### Complex / Risky
- The `POST /terminals/clear` endpoint referenced in the original plan **does not exist** in `LocalApiServer.ts`. Documenting it would send agents to a 404. The correction (removing it, keeping only `POST /terminals/verb/ptyClearTerminal`) is itself routine, but shipping the un-corrected version would have been a silent production failure.
- The dispatch payload's `plan` field does **not** accept `featureId` — it resolves `plan | planId | sessionId | planFile`. Documenting `featureId` as a valid value would cause dispatches to features to fail with a not-found error. Corrected below.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. These are documentation-only changes to static markdown files. No runtime state is modified.
- **Security:** The Tailscale addressing guidance (item 5) must not encourage exposing the API server beyond the localhost/Tailscale boundary. The skill already states "localhost only (127.0.0.1) — never a public interface"; the Tailscale note must reinforce that Tailscale IS the boundary, not a hole in it.
- **Side Effects:** An agent that reads the corrected docs will change its runtime call patterns (use `ptyClearTerminal` instead of `ptySendPrompt` with `/clear`; use `GET /kanban/plan?planId=` instead of `GET /kanban/plans?planId=`). This is the intended effect, but it means pre-existing agent transcripts and cached prompts may contradict the new docs until the agent re-reads the skill.
- **Dependencies & Conflicts:** The three skill files are independent of each other at the file level. No edit to one conflicts with an edit to another. The `GET /kanban/plans` query-param warning belongs in the orchestration skill (HTTP surface authority) — placing it in the query-kanban skill (SQL authority) would split the HTTP contract across two files and create drift risk.

## Dependencies

None — this plan is self-contained documentation work.

## Adversarial Synthesis

Key risks: (1) the original plan documented a non-existent `POST /terminals/clear` endpoint and a `featureId` value for the dispatch `plan` field — both would cause silent 404/not-found failures in production; (2) the `GET /kanban/plans` query-param warning was proposed for the wrong skill file (query-kanban is SQL-focused, not HTTP-focused), creating drift risk. Mitigations: both errors are corrected with Superseded callouts below; the query-param warning is placed in the orchestration skill, the HTTP surface authority, with a cross-reference from query-kanban.

## Proposed Changes

### 1. `.agents/skills/kanban_operations/SKILL.md`

**Context:** This skill is the manual-fallback card-move authority. It currently documents `move-card.js` and `POST /kanban/move` but does not mention `POST /kanban/dispatch`, the one-call advance-and-dispatch primitive. Operators reading this skill learn the database-only move but not the execution primitive that actually boots terminals and delivers prompts.

**Logic:** Add a prominent **Dispatching Cards & Features** section after the existing "Move a Card" section. Cross-reference the orchestration skill as the HTTP surface authority.

**Implementation:**
- Insert a new `## Dispatching Cards & Features` section.
- Document the endpoint and its payload, corrected against the actual handler (`_handleKanbanDispatch`, LocalApiServer.ts line 1839):

  > **Superseded:** The original plan proposed this payload:
  > ```json
  > POST /kanban/dispatch
  > {
  >   "plan": "<planId or featureId>",
  >   "targetColumn": "LEAD CODED | CODER CODED | CODE REVIEWED",
  >   "workspaceRoot": "<path>"
  > }
  > ```
  > **Reason:** The `plan` field does not accept `featureId` — the handler resolves `body?.plan || body?.planId || body?.sessionId || body?.planFile` (LocalApiServer.ts line 1847), none of which resolve a feature. `targetColumn` is optional (omitted or `"auto"` triggers complexity-based routing through the board's own rule), not required. The `from` field (the caller's own terminal name) is missing and is important for team-routed dispatches.
  > **Replaced with:**
  > ```json
  > POST /kanban/dispatch
  > {
  >   "plan": "<planId | sessionId | plan-file path>",
  >   "targetColumn": "<optional — omitted|\"auto\" routes by complexity>",
  >   "workspaceRoot": "<optional — defaults to primary root>",
  >   "from": "<optional — caller's own terminal name for team routing>"
  > }
  > ```
  > Response: `{ success, planId, sessionId, topic, role, mode, column, moved, dispatched, dispatchedAgent, dispatchedAt, error? }`. `success` means "the card is in the target column AND a dispatch was observed" — never just "the request parsed".

- Clarify the difference between physical board dispatch (`POST /kanban/dispatch` — persists the move, fires the column's role prompt, verifies against DB) and database-only card moves (`move-card.js` / `POST /kanban/move` — modifies placement only, no terminal boot, no prompt delivery).
- Note that `POST /kanban/move` is unavailable (503) on the standalone host, while `POST /kanban/dispatch` is the canonical primitive in both hosted and standalone modes.

**Edge Cases:**
- A dispatch to a column with no configured role returns a 4xx error (not a silent no-op). Document this so agents do not retry blindly.
- Dispatching a subtask that is already in-flight (a seat holds it with no `completed_at`) returns 409. The agent must post `POST /kanban/task/complete` for the held planId first.

### 2. `.agents/skills/switchboard-orchestration/SKILL.md`

**Context:** This skill is the HTTP surface authority. It already lists `ptyClearTerminal` in the verb table (section 4b, line 216) and documents `completedAt` in plan records (line 84), but it does not explain *why* sending `/clear` via `ptySendPrompt` fails (bracketed-paste framing), nor does it consolidate the three completion signals into a single recipe.

**Logic:** Add two new sections: a **Terminal Reset & Clear Protocol** subsection under section 4b, and a **Fleet Completion Detection Recipe** as a new top-level section after section 9 (The truth rule).

**Implementation:**

*Terminal Reset & Clear Protocol:*
- Explain the bracketed-paste pitfall: `ptySendPrompt` wraps `data` in `\x1b[200~ ... \x1b[201~` markers. A CLI receiving bracketed-paste `/clear` treats it as literal text input, not a slash command. The result is prompt pollution (the literal string `/clear` appears in the conversation) and no context reset.
- Document the correct endpoint: `POST /terminals/verb/ptyClearTerminal` with body `{ name }`. This verb calls `clearPty(handle)`, which writes `\x15` (Ctrl+U — resets the input line), then `/clear`, then `\r` (submit) as three separate unbracketed writes. The CLI receives and executes the clear command.

  > **Superseded:** The original plan listed `POST /terminals/verb/ptyClearTerminal` **and** `POST /terminals/clear` as the two raw clear endpoints.
  > **Reason:** `POST /terminals/clear` does not exist in `LocalApiServer.ts`. The route table (lines 8127–8148) has no `/terminals/clear` entry — the only terminal clear path is the verb rail `POST /terminals/verb/ptyClearTerminal`. Documenting a non-existent endpoint sends agents to a 404.
  > **Replaced with:** The sole clear endpoint is `POST /terminals/verb/ptyClearTerminal` (body `{ name }`). There is no `/terminals/clear` shortcut.

- Reinforce the existing at-rest rule from section 4b: clear a coder the moment you stand it down, not on the way back in. Never clear your own terminal. Never use `ptyClearAllTerminals` (it clears every active terminal, you included).

*Fleet Completion Detection Recipe:*
- Consolidate the three concrete completion signals:
  1. **Database signal:** `completed_at` is non-null on the plan record (written by `POST /kanban/task/complete` via `setCompletedAt`). Read it via `GET /kanban/plan?planId=<id>` → `.data.completedAt`. NULL means the team is still working.
  2. **Queue signal:** `POST /kanban/queue/next` returns `200 { success: true, dispatched: null, reason: "queue empty" }` — the session is ending normally; report and stop. (A `409 { success: false, error, inFlight: {...} }` means a seat still holds a card — post `POST /kanban/task/complete` for the `inFlight` planId first.)

     > **Superseded:** The original plan stated the queue signal is `{ "dispatched": null, "reason": "queue empty" }`.
     > **Reason:** The response is wrapped in the standard success envelope. An agent parsing for a bare `{ dispatched, reason }` object will not find it under `res.data` and may misread the response.
     > **Replaced with:** `200 { success: true, dispatched: null, reason: "queue empty" }`.

  3. **Git signal:** a commit on the integration branch (`main` or the feature's shared worktree branch) carrying the git trailer `Switchboard-Plan: <planId>` (one line per planId in a batch dispatch), preceded by `Switchboard-Stage: <stage>`. The trailer block requires a blank line before it (git only parses trailers in the message's final paragraph). Verify with `git log --format='%(trailers:key=Switchboard-Plan,valueonly)'`.

*Remote & Mobile Network Addressing (item 5):*
- Add a brief note under the existing Bootstrap section (section 1) or Notes section (section 11): when the operator machine is reachable over Tailscale, the board and terminals are addressable at `http://100.x.y.z:7777` (the Tailscale IP, port from the live server). SSH access to the host requires key-based authentication when password auth is hardened — the operator must have a registered SSH key, not a password. Reinforce: Tailscale IS the network boundary; the API server must never be exposed on a public interface.

**Edge Cases:**
- `ptyClearTerminal` on a terminal that is not live returns `{ success: false, error: "No such terminal: <name>" }`. An agent should verify the terminal name via `POST /terminals/verb/ptyListTerminals` first if unsure.
- The `completed_at` write is idempotent — a repeat `POST /kanban/task/complete` for the same planId returns the existing timestamp without re-writing. Agents polling for completion should not treat a stable timestamp as a new event.

### 3. `.agents/skills/query-kanban/SKILL.md`

**Context:** This skill is the SQL-query authority for the kanban database. It documents direct `sqlite3` queries and the column-label translation table. It does not document the HTTP `GET /kanban/plans` endpoint's query-parameter semantics — and it should not, because that is the orchestration skill's domain (HTTP surface authority). However, agents using this skill for plan lookups may also reach for the HTTP endpoint, so a cross-reference is warranted.

**Logic:** Add a short cross-reference note pointing to the orchestration skill for HTTP query semantics, and document the SQL equivalent of single-plan lookup (which the skill already has via `Get Plan by Session ID`, but not by `planId`).

**Implementation:**
- Add a `### Get Plan by planId` SQL query template (the skill has `Get Plan by Session ID` but not by `planId`):
  ```sql
  SELECT * FROM plans WHERE plan_id = '<planId>' LIMIT 1;
  ```
- Add a one-line cross-reference note: "For HTTP plan lookups, use `GET /kanban/plan?planId=<id>` (returns one plan plus its file content). Do NOT use `GET /kanban/plans?planId=<id>` — the `planId` query param is not a server-side filter on that endpoint; it returns the full workspace array. See `.agents/skills/switchboard-orchestration/SKILL.md` section 2 for the full HTTP read-endpoint contract."

  > **Superseded:** The original plan proposed documenting the `GET /kanban/plans` query-param warning directly inside `query-kanban/SKILL.md`, including valid query parameters (`column`, `featureId`, `workspaceRoot`).
  > **Reason:** `query-kanban/SKILL.md` is the SQL-query authority, not the HTTP-surface authority. The HTTP endpoint behavior (`GET /kanban/plans` accepts only `column` and `featureId` as filters; `workspaceRoot` is a general query param on all DB-backed endpoints) belongs in the orchestration skill, which already documents `GET /kanban/plans?column=<col>` and `GET /kanban/plans?featureId=<id>` in its read-endpoint table (section 2). Placing HTTP semantics in the SQL skill splits the HTTP contract across two files and creates drift risk — the two files can disagree and an agent cannot tell which is authoritative.
  > **Replaced with:** A cross-reference note in `query-kanban/SKILL.md` pointing to the orchestration skill for HTTP query semantics, plus the missing `Get Plan by planId` SQL template. The full `GET /kanban/plans` query-param warning (including the explicit "planId is not a filter" note) is added to the orchestration skill's read-endpoint table in section 2.

- In the orchestration skill's section 2 read-endpoint table, add an explicit warning row/note after the `GET /kanban/plans` entries: "`planId` is NOT a valid query filter on `GET /kanban/plans` — it is silently ignored and the full workspace array is returned. For a single plan, use `GET /kanban/plan?planId=<id>` (includes `.data.content`). Client-side filtering (`res.data.find(p => p.planId === id)`) works but fetches the whole board; prefer the dedicated endpoint."

**Edge Cases:**
- The `GET /kanban/plans?column=<col>` filter requires the storage column id (e.g. `PLAN%20REVIEWED` URL-encoded), not the board label. An agent passing `Planned` gets an empty array. This is already implied by the orchestration skill's example but should be stated explicitly in the new warning note.

## Verification Plan

### Automated Tests
- Run test suites for skill pre-conditions:
  ```bash
  npm run test:contract:skill-preconditions
  ```
- Verify markdown formatting and link integrity across all edited skill files.

### Goal Invariants
- Assert `POST /terminals/clear` is absent from the route table in `src/services/LocalApiServer.ts` (grep for `'/terminals/clear'` returns zero matches) — the corrected docs must not reference it.
- Assert `POST /terminals/verb/ptyClearTerminal` is present in the route table in `src/services/LocalApiServer.ts` (grep for `ptyClearTerminal` in the verb-rail routing returns ≥1 match).
- Assert the `GET /kanban/plans` handler in `src/services/LocalApiServer.ts` (`_handleGetPlans`) reads only `column` and `featureId` from query params — grep for `searchParams.get` in that function returns exactly those two keys.
- Assert the dispatch handler (`_handleKanbanDispatch`) resolves `body?.plan || body?.planId || body?.sessionId || body?.planFile` and does NOT resolve `body?.featureId` — grep for `featureId` in that function returns zero matches.
- Assert `completed_at` column exists in the `plans` table schema in `src/services/KanbanDatabase.ts` (grep for `completed_at` in `SCHEMA_TABLES_SQL` or `PLAN_COLUMNS` returns ≥1 match).
- Assert `Switchboard-Plan` trailer instruction exists in `src/services/agentPromptBuilder.ts` (grep returns ≥1 match in the commit-clause builder).

### Manual Verification
- Verify that subagents and operator agents can resolve the correct dispatch endpoints and clear protocols directly from the skill instructions without improvising.
- Confirm that an agent reading the corrected `kanban_operations/SKILL.md` dispatch section constructs a payload with `plan` (not `featureId`), omits `targetColumn` when auto-routing is desired, and includes `from` when dispatching to its own team.
- Confirm that an agent reading the corrected orchestration skill clear protocol uses `POST /terminals/verb/ptyClearTerminal` and never sends `/clear` via `ptySendPrompt`.

---

## Implementation Summary

All three skill files updated. `kanban_operations/SKILL.md` gained a "Dispatching Cards & Features" section documenting `POST /kanban/dispatch` (corrected payload: `plan` accepts `planId|sessionId|plan-file`, NOT `featureId`; `targetColumn` optional; `from` for team routing), with the dispatch-vs-move distinction and edge cases. `switchboard-orchestration/SKILL.md` gained four additions: a `GET /kanban/plans` query-param warning (planId is not a filter; column requires storage id), a "Terminal Reset & Clear Protocol" subsection explaining the bracketed-paste pitfall and the sole `ptyClearTerminal` endpoint (no `/terminals/clear`), a "Fleet Completion Detection Recipe" (section 9a) consolidating the three completion signals (`completedAt`, queue-empty response, `Switchboard-Plan` git trailer), and a Tailscale remote-addressing note reinforcing Tailscale as the network boundary. `query-kanban/SKILL.md` gained a "Get Plan by planId" SQL template and an HTTP cross-reference note pointing to the orchestration skill. One additional correction beyond the plan's own superseded callouts: the plan's edge case claiming `POST /kanban/dispatch` returns 409 for in-flight subtasks was verified false (the 409 in-flight refusal is `POST /kanban/queue/next` only; `performKanbanDispatch` has no in-flight gate) and was corrected to document the actual unconditional-dispatch behavior with a pre-check mitigation. All source claims verified against LocalApiServer.ts, KanbanDatabase.ts, ptyPromptDelivery.ts, and agentPromptBuilder.ts.

## Review Findings

Reviewed and corrected `.agents/skills/kanban_operations/SKILL.md` and `.agents/skills/query-kanban/SKILL.md`, and regenerated their `.claude/skills/` mirrors (`kanban-operations`, `query-kanban`), which the implementation left stale and which broke the CI-wired `mirror:check` gate. Four content defects were fixed in the new dispatch section: the `plan` field's value list wrongly promised `sessionId` resolution (`performKanbanDispatch` resolves only `getPlanByPlanId` then plan-file path — 269 of 2989 local plans have `session_id != plan_id`), the `LocalApiServer.ts:1847` citation was off by 23 lines (actual 1870), and both the `from` team-routing contract and the 400 "no configured role" pre-flight are extension-host only because `resolveKanbanDispatch` is unwired in `src/standalone/bootstrap.ts` — all now qualified, plus the missing `409 no live terminal agent` refusal. Everything else verified true against `LocalApiServer.ts`, `KanbanDatabase.ts` and `KanbanProvider.ts`: complexity bands, the response field list, the 502 semantics, the absence of an in-flight gate, `/kanban/move` 503 on standalone, `completed_at`/`dispatched_at` in `PLAN_COLUMNS`, and `_handleGetPlans` reading only `column` and `featureId`. The plan's Goal Invariant asserting `POST /terminals/clear` is absent is now **stale** — commit `99d1337f` added that route and made it the canonical agent-facing clear, and the orchestration skill (already at HEAD, delivered by that commit) correctly documents it; no change was made there. Gates: `mirror:check` now clean for both files this plan owns (two pre-existing drifts remain from other plans), `test:contract:terminal-rest-clear` and `test:contract:prompt-payload-kind` pass, and `test:contract:skill-preconditions` — the plan's own named gate — is red with 5 failures that are all pre-existing at HEAD and untouched by this change.

## Deferred Findings

- MAJOR — `test:contract:skill-preconditions` is red at HEAD with 5 failures, all belonging to the reverted `skills-declare-preconditions-and-degrade` delivery, not this plan: `kanban_operations` has no `## Preconditions`/`## Prerequisites` heading; `query-kanban` is SQL-primary rather than endpoints-primary, lacks the "not reachable from this session" degrade clause, and names neither the `/health` probe nor `manage-features`. Restoring that rewrite is that plan's scope. `.agents/skills/query-kanban/SKILL.md:1`, `.agents/skills/kanban_operations/SKILL.md:1`
- MAJOR — `mirror:check` still fails on two pre-existing drifts from other plans' unmirrored work: `.agents/workflows/switchboard.md` gained "Messaging Seats" and "Clearing Terminals" sections (commit `99d1337f`) that were never mirrored, and `.claude/skills/switchboard-remote/SKILL.md` carries a "8b. Linear Steps" section its `.agents` source no longer has (reverse drift). `.claude/skills/switchboard/SKILL.md:114`, `.claude/skills/switchboard-remote/SKILL.md:212`
- MAJOR — the plan's Goal Invariant "`POST /terminals/clear` is absent from the route table" is false as of commit `99d1337f`; the endpoint exists at `src/services/LocalApiServer.ts:8340` and is now the canonical agent-facing clear. The plan's Superseded callout arguing it be removed from the docs is obsolete and must not be applied by a future pass. `src/services/LocalApiServer.ts:8340`
- MAJOR — `test:contract:claude-protocol-block` is red with 2 failures (packaged `AGENTS.md` drifted from `RESIDENT_PROTOCOL_BODY`; the "Plan Authoring" action-local section is back in the resident block). Unrelated to skills and untouched by this change. `AGENTS.md:1`
- NIT — the plan's Goal Invariant expecting `ptyClearTerminal` in `src/services/LocalApiServer.ts` cannot hold by construction: the verb rail routes `POST /terminals/verb/<name>` generically, so no per-verb literal appears in that file. The verb is real and lives in `src/standalone/bootstrap.ts:1994` and `TaskViewerProvider.ts:530`. `src/services/LocalApiServer.ts:1`
- NIT — the new dispatch section documents neither the `KanbanDispatchError` 400 from `resolveAutoDispatchColumn` (no eligible coding agent live/visible) nor the `dynamic complexity routing off` → `LEAD CODED` short-circuit; both are reachable on the `"auto"` path. `.agents/skills/kanban_operations/SKILL.md:98`
