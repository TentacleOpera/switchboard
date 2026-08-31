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
   Agents frequently attempt to clear terminals by sending `/clear` through `ptySendPrompt`. Because `ptySendPrompt` encapsulates text in bracketed-paste escape sequences (`\x1b[200~ ... \x1b[201~`), terminal CLIs (Devin, Antigravity, Claude Code) receive literal `/clear` text rather than executing the clear command, leading to prompt pollution. The correct mechanism is `POST /terminals/verb/ptyClearTerminal` (or `POST /terminals/clear`), which sends `\x15` (Ctrl+U) and `/clear\r` as direct unbracketed keystrokes.

3. **API Query Filter Misinterpretation (`GET /kanban/plans`):**
   `GET /kanban/plans?planId=<id>` does not perform single-plan filtering on the backend; it returns the entire workspace array. Agents consuming `res.data[0]` mistakenly inspect whichever card happens to be first in the DB (often from a different column), generating false reports.

4. **Ambiguous Fleet Completion Contracts:**
   When an operator requests progress monitoring until completion, agents must know the concrete signals of completion across the runtime (`completedAt` timestamp in the database, `Switchboard-Plan` git commit trailer, and `POST /kanban/queue/next` returning `{ "dispatched": null, "reason": "queue empty" }`).

5. **Remote & Mobile Network Addressing:**
   Operator guidance for reaching the board and terminals over Tailscale (`http://100.x.y.z:7777`) and understanding key-based SSH requirements when password authentication is hardened.

## Proposed Changes

### 1. `.agents/skills/kanban_operations/SKILL.md`
- Add a prominent **Dispatching Cards & Features** section detailing `POST /kanban/dispatch`.
- Detail the exact payload structure:
  ```json
  POST /kanban/dispatch
  {
    "plan": "<planId or featureId>",
    "targetColumn": "LEAD CODED | CODER CODED | CODE REVIEWED",
    "workspaceRoot": "<path>"
  }
  ```
- Clarify the difference between physical board dispatch (`/kanban/dispatch`) and database-only card moves (`move-card.js`).

### 2. `.agents/skills/switchboard-orchestration/SKILL.md`
- Add a **Terminal Reset & Clear Protocol** section explaining why `/clear` must not be sent via `ptySendPrompt`.
- Document the raw clear endpoints (`POST /terminals/verb/ptyClearTerminal` and `POST /terminals/clear`).
- Document the **Fleet Completion Detection Recipe** for monitoring tasks:
  - Database signal: `completed_at` is non-null on the plan record.
  - Queue signal: `POST /kanban/queue/next` returns `{ "dispatched": null, "reason": "queue empty" }`.
  - Git signal: commit on `main` with trailer `Switchboard-Plan: <planId>`.

### 3. `.agents/skills/query-kanban/SKILL.md`
- Document valid query parameters for `GET /kanban/plans`: `column`, `featureId`, `workspaceRoot`.
- Explicitly note that `planId` is not a URL query filter on `GET /kanban/plans`, and provide the recommended client-side resolution (`res.data.find(...)`) or SQLite query pattern.

## Verification Plan

### Automated Tests
- Run test suites for skill pre-conditions:
  ```bash
  npm run test:contract:skill-preconditions
  ```
- Verify markdown formatting and link integrity across all edited skill files.

### Manual Verification
- Verify that subagents and operator agents can resolve the correct dispatch endpoints and clear protocols directly from the skill instructions without improvising.
