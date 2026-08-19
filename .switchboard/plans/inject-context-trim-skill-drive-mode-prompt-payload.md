# Inject Context Into Drive-Mode Prompt, Trim Skill File

## Goal

The team lead agent wastes a full turn on discovery work the extension already has at dispatch time. In an observed session, the lead:
1. Read a 631-line skill file (`terminal-coder-dispatch/SKILL.md`)
2. Ran 4 direct `sqlite3` queries against `kanban.db` (schema discovery, table listing, column guessing, plan lookup) — violating the skill's own "never touch the DB directly" rule
3. Grepped the codebase to "verify" work wasn't already done before dispatching — a reflex the skill doesn't ask for and the agent admitted was unjustified
4. Enumerated terminals twice (wrong jq field name on the first try)
5. Checked standing orders (already installed at team creation by `wireSpawnedTeam`)

The plan IDs were already in the dispatch prompt (`PLAN_ID=<id>` lines in `buildPromptDispatchContext`). The team roster was in `terminals.groups` in the DB. The standing orders were installed by `wireSpawnedTeam`. The API port was in `.switchboard/api-server-port.txt`. The agent re-discovered all of it from scratch because the prompt said "Read and follow .agents/skills/terminal-coder-dispatch/SKILL.md" and the skill is a 631-line reference document with no startup sequence.

### Root Cause

Two compounding defects:

1. **The dispatch prompt is a pointer, not a payload.** `DRIVE_FEATURE_PREFIX` is a one-line directive: "Read and follow .agents/skills/terminal-coder-dispatch/SKILL.md." The extension has the team roster, the plan IDs, the feature file path, and the standing order status at dispatch time — it injectates none of them. The agent must discover everything the extension already knows.

2. **The skill file is a reference document, not an operational guide.** 631 lines with no "here's what you do at startup, in order" section. War stories ("Observed failure: …") are interleaved with operational rules, so the agent can't distinguish "what I must do now" from "what went wrong once in August." No explicit prohibition on DB access or pre-dispatch verification — the agent fills the gaps with its own reflexes.

## Metadata

**Complexity:** 6
**Tags:** backend, refactor, ui, reliability
**Project:** Browser Switchboard

## User Review Required

No user decision needed — the design is fully specified from the observed failure session and the codebase. The only open question (role resolution path) is resolved below in Part 4.

## Complexity Audit

### Routine
- Replacing a static string constant with a dynamically built string (Part 1)
- Passing an additional parameter through two call sites (Part 3)
- Moving text blocks within a markdown file (Part 2)
- Adding a §0 Quick Start section and a §0.1 Do NOT section to the skill file (Part 2)

### Complex / Risky
- Resolving per-member roles for the roster block (Part 4) — `getFleetLiveness()` returns `{ friendlyName, lastDataAt, status }` with NO `role` field, so the plan's original approach of getting roles from liveness data is wrong. The correct path requires either an async `ptyListTerminals` call or cross-referencing `terminals.agentGroups` member definitions with the expanded `children` array. See the Superseded callout in Part 4.
- The enriched prompt must stay backward-compatible: non-team dispatches (no lead-headed team in `terminals.groups`) must fall back to the current static prefix.
- The `_buildFeatureDirectivePrefix` method is called at two sites with different surrounding context — the `plans` array must be threaded through both without breaking the non-drive path.

## Edge-Case & Dependency Audit

**Race Conditions:** `getFleetLiveness()` is a synchronous read of a cached snapshot refreshed on every `ptyListTerminals` forward. A terminal that spawned after the last forward will be absent from the snapshot. This is acceptable — the roster is advisory context, not a routing decision, and the agent can still dispatch by name.

**Security:** No new attack surface. The enriched prompt carries terminal names and plan IDs that are already in the dispatch context.

**Side Effects:** The enriched prompt is longer than the one-line prefix. This is intentional — the token cost of the roster + rules (~200 tokens) is far less than the token cost of the agent reading a 631-line skill file and running 4 DB queries.

**Dependencies & Conflicts:** Part 3 (pass plans through) and Part 4 (roster resolver) must land before Part 1 (enriched prefix uses both). Part 2 (skill trim) is independent. The companion plan (`drive-mode-addon-cleanup-auto-arm-watch.md`) depends on this plan's Part 1 — the enriched prompt must NOT include the `watchFeature` arming call because the companion plan moves that to the extension.

## Dependencies

- Companion plan: `drive-mode-addon-cleanup-auto-arm-watch.md` — its Part 2 (auto-arm watch) depends on this plan's Part 1 (enriched prompt no longer tells the agent to arm the watch).

## Adversarial Synthesis

Key risks: (1) the roster resolver's role-resolution path is non-trivial and the original plan's approach was factually wrong about `getFleetLiveness()` providing roles; (2) the enriched prompt could become stale if the team changes after dispatch but before the agent reads it — acceptable since the agent dispatches by name, not by roster freshness; (3) the skill trim could lose operational context if war stories are moved without back-references. Mitigations: Part 4 uses the correct role-resolution path (ptyListTerminals or agentGroups cross-reference); the roster is advisory; Part 2 requires back-references from the appendix to the original sections.

## Proposed Changes

### `src/services/KanbanProvider.ts` — Part 1: Enrich the drive-mode dispatch prompt

**Context:** `_buildFeatureDirectivePrefix` at line 5231 currently appends the static `DRIVE_FEATURE_PREFIX` string when `drive` is true. The method signature is `(workspaceRoot: string, drivePreResolved?: boolean): Promise<string>`.

**Logic:** Replace the static `DRIVE_FEATURE_PREFIX` append with a call to a new `_buildDrivePrefix` helper that constructs an operational block from injected context. When no team group is found, fall back to the current static prefix.

**Implementation:**
- New helper: `async _buildDrivePrefix(workspaceRoot: string, plans: BatchPromptPlan[]): Promise<string>`
- Reads `terminals.groups` from the DB (same path as `resolveCodingRolesFromGroups` at line 5107 — `TERMINALS_GROUPS_KEY` with bare-key fallback)
- Finds the lead-headed team group (filter for `headRole === 'lead'` with `teamGroup === true`)
- Gets the `members` array from the group (terminal names, head first — set by `wireSpawnedTeam` at teamWiring.ts:1293)
- Resolves per-member roles and liveness via the new `_resolveTeamRosterForPrompt` helper (Part 4)
- Reads the API port from `.switchboard/api-server-port.txt` (best-effort; fall back to "read .switchboard/api-server-port.txt" if unavailable)
- Builds the compact operational block (see template below)

**Operational block template** (replaces `DRIVE_FEATURE_PREFIX`):
```
You are driving this feature through your team seats. Everything you need is below — do not look anything up.

YOUR TEAM:
- Coding-coder-1 (coder) — active
- Coding-coder-2 (coder) — active
- Coding-intern (intern) — active

API: Port is <port> (http://127.0.0.1:<port>). Also in .switchboard/api-server-port.txt.
Your terminal name is in $SWITCHBOARD_TERMINAL.
Standing orders: callback contract is installed on all workers — they report to you on completion. Do not re-register.

DISPATCH (one call per subtask):
curl -s -X POST "$BASE/terminals/verb/ptySendPrompt" -H "Content-Type: application/json" --max-time 30 \
  -d '{"name":"<seat>","data":"Implement the plan at <path>. This subtask only.","clearBeforePrompt":false,"dispatch":{"planId":"<id>","role":"coder"}}'

REVIEW: On callback, review git diff — not the coder's self-report. Resend fixes to the same terminal (context preserved). Escalate after two failures on the same subtask: intern → coder → lead.

FEATURE WATCH: Armed by the system (stopColumns: CODE REVIEWED). You will be nudged if you go idle with un-accepted subtasks. No action needed.

RULES:
- Do NOT query kanban.db directly. The plan IDs are in your prompt; use the API for anything else.
- Do NOT verify work before dispatching. The kanban column is the system's record, not a coder's claim.
- Clear a terminal only when at rest (completion received AND next work goes elsewhere).
- One subtask per terminal at a time. Use a second terminal for concurrency.
- Full protocol (escalation ladder, unattended mode, resting terminals, failure modes): .agents/skills/terminal-coder-dispatch/SKILL.md
```

**Fallback:** If no team group is found (no lead-headed team in `terminals.groups`), fall back to the current `DRIVE_FEATURE_PREFIX` string. This preserves backward compatibility for non-team dispatches.

**Edge cases:**
- No team group in `terminals.groups` → falls back to static `DRIVE_FEATURE_PREFIX` (current behavior)
- Team group exists but has no `members` field (downgraded build or manual edit) → treat as no roster → fall back to static `DRIVE_FEATURE_PREFIX`
- Team group exists but no live members → roster shows all as `exited`, agent should report to user
- Multiple lead-headed teams → pick the first alive one (same as `resolveCodingRolesFromGroups`)
- API port file missing → prompt says "read .switchboard/api-server-port.txt" (current behavior)
- Standalone host (no `_taskViewerProvider`) → liveness check returns empty, roster shows names without active status
- Fleet unavailable (pty host not booted) → roles fall back to empty strings, roster shows names with liveness only

### `.agents/skills/terminal-coder-dispatch/SKILL.md` — Part 2: Trim the skill file

**Context:** The skill file is 631 lines. Three "Observed failure:" blocks (at lines 357, 367, 375) are interleaved with operational rules in §3, making it hard to distinguish "what I must do" from "what went wrong once."

**Logic:** Add a Quick Start section at the top, move war stories to an appendix, add explicit prohibitions.

**Implementation:**
1. **Add §0: Quick Start** at the very top (after the title and the existing intro block). A 10-line numbered startup sequence:
   ```
   ## 0. Quick Start

   1. Read your dispatch prompt — it contains your team roster, plan IDs, and the feature file path.
   2. Read the feature file for subtask sequencing.
   3. Dispatch the first subtask: POST /terminals/verb/ptySendPrompt with dispatch field.
   4. On callback: review git diff, not the coder's self-report.
   5. Resend fixes to the same terminal, or escalate after two failures.
   6. Clear a terminal only when at rest (completion + next work elsewhere).
   7. A feature watch is armed automatically by the system for drive-mode dispatches — no action needed.

   Everything else in this skill is reference for edge cases. Consult §1–§10 when you hit them.
   ```

2. **Move all "Observed failure:" blocks** to a new `## Appendix: War Stories` section at the end of the file. These are illustrative anecdotes, not operational rules. They currently interrupt the operational flow of §3 (lines 357-377). Each moved block gets a back-reference from its original location (`See Appendix: <short description>`).

3. **Add explicit prohibitions** in a new `## 0.1. Do NOT` subsection right after Quick Start:
   ```
   ## 0.1. Do NOT

   - Do NOT query kanban.db directly with sqlite3. Use the API endpoints (GET /kanban/plans, GET /kanban/plan). The plan IDs are in your dispatch prompt.
   - Do NOT grep the codebase to verify work before dispatching. The kanban column is the system's record — a different evidentiary class than a coder's self-report. Verification happens on callback (§5), not before dispatch.
   - Do NOT re-register standing orders. They were installed at team creation. Check with GET /terminals/standing-orders only if you suspect a problem.
   - Do NOT enumerate terminals more than once per startup. The roster is in your dispatch prompt.
   ```

4. **Keep §1–§10 as operational reference** but remove the war-story interruptions. Each section stays focused on its rule. The war stories move to the appendix with back-references (`See Appendix: 2026-08-16 silent coder`).

5. **Update §3.5** (line 276-301): Note that the feature watch is armed automatically by the system for drive-mode dispatches. The manual arming path remains for non-drive or external-headed teams only. This change is coordinated with the companion plan's Part 2.

### `src/services/KanbanProvider.ts` — Part 3: Pass plan data through to the prefix builder

**Context:** `_buildFeatureDirectivePrefix` is called at two sites (lines 5426 and 5682). Both have access to the `plans` array in their enclosing scope. The method currently takes `(workspaceRoot, drivePreResolved?)`.

**Logic:** Add a `plans?: BatchPromptPlan[]` parameter. When `drive` is true and `plans` is provided, build the enriched operational block via `_buildDrivePrefix`. When `plans` is absent (backward compat), fall back to the static `DRIVE_FEATURE_PREFIX`.

**Implementation:**
```typescript
// Current (line 5426):
const prefix = await this._buildFeatureDirectivePrefix(workspaceRoot, await resolveDrive());

// New:
const prefix = await this._buildFeatureDirectivePrefix(workspaceRoot, await resolveDrive(), plans);
```

Same change at line 5682. The method signature changes from:
```typescript
private async _buildFeatureDirectivePrefix(workspaceRoot: string, drivePreResolved?: boolean): Promise<string>
```
to:
```typescript
private async _buildFeatureDirectivePrefix(workspaceRoot: string, drivePreResolved?: boolean, plans?: BatchPromptPlan[]): Promise<string>
```

### `src/services/KanbanProvider.ts` — Part 4: Resolve team roster with roles for prompt injection

**Context:** The plan needs to resolve the team roster with per-member roles and liveness for prompt injection. The original plan proposed using `getFleetLiveness()` for both liveness and roles.

> **Superseded:** Gets liveness + role data from `_taskViewerProvider.getFleetLiveness()` (matching by `friendlyName` to get the role and active status for each member).
> **Reason:** `getFleetLiveness()` returns `Array<{ friendlyName: string; lastDataAt: number; status: string }>` — it has NO `role` field. This was verified at `TaskViewerProvider.ts:1150` and `:1159`. The original plan's approach would produce a roster with no role labels, defeating the purpose.
> **Replaced with:** A two-source approach: (1) `getFleetLiveness()` for liveness status only (active/exited), and (2) `ptyListTerminals` via `_taskViewerProvider._ptyHostVerb('ptyListTerminals', {})` for per-terminal role. The `ptyListTerminals` response carries `{ friendlyName, role, status, ... }` per terminal (confirmed at `TaskViewerProvider.ts:10013`). This is an async call, so the helper must be async. On standalone, `_liveTerminalsProvider` (registered at `bootstrap.ts:2254`) returns the same shape synchronously — prefer it when available. When neither source provides roles (fleet unavailable), fall back to reading the agent group definition from `terminals.agentGroups` and expanding member definitions by count to match the `children` order — but this is fragile and should be a last resort. The simplest correct path: try `_liveTerminalsProvider` first (standalone), then `ptyListTerminals` (extension host), then no-role fallback (names only with liveness).

**Implementation:**
```typescript
async _resolveTeamRosterForPrompt(workspaceRoot: string): Promise<Array<{ name: string; role: string; active: boolean }> | null>
```

This function:
1. Reads `terminals.groups` from the DB (same path as `resolveCodingRolesFromGroups` — `TERMINALS_GROUPS_KEY` with bare-key fallback at line 5115)
2. Finds the group with `headRole === 'lead'` and `teamGroup === true` and a live head (same liveness check as `resolveCodingRolesFromGroups`)
3. Gets the `members` array (terminal names, head first — set by `wireSpawnedTeam` at teamWiring.ts:1293)
4. Gets liveness from `getFleetLiveness()` — `{ friendlyName, status }` only, used to set `active: boolean`
5. Gets roles from one of:
   a. `_liveTerminalsProvider()` if registered (standalone) — returns `{ role, friendlyName, ... }`
   b. `_taskViewerProvider._ptyHostVerb('ptyListTerminals', {})` (extension host) — response `terminals` array carries `{ friendlyName, role, status }`
   c. Fallback: no role — set `role: ''` (the roster still shows names and liveness, just without role labels)
6. Returns an array of `{ name, role, active }` for each member EXCEPT the head (the head is the agent receiving this prompt — it doesn't need to be told its own name in the roster)
7. Returns `null` if no team group is found (triggers the fallback prefix)

**Liveness data shape:** `getFleetLiveness()` returns `Array<{ friendlyName: string; lastDataAt: number; status: string }>`. Match by `friendlyName` to get the active status for each member. `status !== 'exited'` means active.

**Role data shape:** `ptyListTerminals` response `terminals` array entries carry `{ friendlyName, role, status, ... }`. Match by `friendlyName` to get the role for each member.

## Verification Plan

### Automated Tests
- Run existing tests: `npm test -- --grep "agentPromptBuilder"` to verify prompt builder tests pass
- Run existing tests: `npm test -- --grep "KanbanProvider"` to verify kanban provider tests pass
- Add a test for the new `_buildDrivePrefix` / enriched prefix: verify it includes team roster, plan IDs, and operational rules when a team group exists, and falls back to the static prefix when no team group is found
- Add a test for `_resolveTeamRosterForPrompt`: verify it returns `null` when no team group exists, returns members with roles when `ptyListTerminals` provides roles, and returns members with empty roles when the fleet is unavailable

### Manual
1. Create a Coding team (Agents tab → Agent Groups → Coding)
2. Stage a feature with 2+ subtasks in PLAN REVIEWED
3. Enable the Drive toggle on the board
4. Dispatch the feature to the lead
5. Verify the lead's prompt contains:
   - Team roster with seat names and roles
   - Plan IDs from the dispatch prompt
   - API port
   - Compact operational rules
   - Reference link to the full skill
6. Verify the lead does NOT:
   - Run `sqlite3` against `kanban.db`
   - Grep the codebase before dispatching
   - Enumerate terminals (roster is in the prompt)
   - Check standing orders (status is in the prompt)
7. Verify the lead dispatches the first subtask within its first or second action

### Edge cases
- No team group in `terminals.groups` → falls back to static `DRIVE_FEATURE_PREFIX` (current behavior)
- Team group exists but has no `members` field → treat as no roster → fall back to static `DRIVE_FEATURE_PREFIX`
- Team group exists but no live members → roster shows all as `exited`, agent should report to user
- Multiple lead-headed teams → pick the first alive one (same as `resolveCodingRolesFromGroups`)
- API port file missing → prompt says "read .switchboard/api-server-port.txt" (current behavior)
- Standalone host (no `_taskViewerProvider`) → liveness check returns empty, roster shows names without active status
- Fleet unavailable (pty host not booted) → roles fall back to empty strings, roster shows names with liveness only

## Dependencies & Sequencing

- Part 3 (pass plans through) must land before Part 1 (enriched prefix uses plans)
- Part 4 (roster resolver) must land before Part 1 (enriched prefix uses roster)
- Part 2 (skill trim) is independent — can land in parallel

Recommended order: Part 3 → Part 4 → Part 1 → Part 2

## Uncertain Assumptions

None remaining. The role-resolution path was the sole uncertainty and is now resolved by verifying the actual `getFleetLiveness()` return shape against the source code (`TaskViewerProvider.ts:1150,1159`) and identifying the correct role source (`ptyListTerminals` / `_liveTerminalsProvider`).
