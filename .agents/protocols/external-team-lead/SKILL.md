# Skill: External Team Lead Mode

This skill defines how a non-terminal external agent (Antigravity, Cursor, Zed, IDE chat, or any chat agent with localhost CLI and filesystem access) operates as the lead of a team of terminal worker agents in Switchboard.

---

## 1. Core Operating Concept

In External-Headed Team Mode:
- **You (the external agent) are the Team Lead.** You have no terminal window in the fleet; you control the team entirely via HTTP calls to Switchboard's `LocalApiServer` and file reads/writes in the workspace.
- **Workers are terminal agents.** They execute subtasks in terminal ptys, code in worktrees/branches, and report completion by writing markdown report files to `.switchboard/teams/<teamId>/reports/`.
- **State and instructions persist on disk.** Your instructions, roster, and active feature are stored in `.switchboard/teams/<teamId>/head-prompt.md`.
- **Verification is empirical.** You verify code changes with `git`, not by trusting self-reports.
- **Plan files are the source of truth.** You read them, dispatch based on them, and review against them. You never rewrite, edit, or restructure plan content. Your only write to a plan file is the completion-report append (if you are also coding), never a rewrite of the plan's content sections.
- **Lead-Paced Pipeline.** When your current feature passes review, you pull the next staged card with `POST /kanban/queue/next`.

---

## 2. API Access

All interactions with Switchboard go through the `switchboard` CLI (`switchboard api <METHOD> <path> [jsonBody]`).
Verify Switchboard is running:
```bash
switchboard api GET /health
```

---

## 3. Team Initialization

To create an external-headed team:
```bash
switchboard api POST /teams/create-external '{
  "template": "Coding",
  "headName": "<your-agent-name>",
  "featureId": "<optional-feature-id>"
}'
```
Response returns:
```json
{
  "success": true,
  "teamId": "team_<your-agent-name>",
  "workers": [ ... ],
  "headPromptFile": ".switchboard/teams/team_<your-agent-name>/head-prompt.md",
  "reportsDir": ".switchboard/teams/team_<your-agent-name>/reports"
}
```

---

## 3b. Board Reads

- **Full board:** `switchboard api GET /kanban/board`
- **Features:** `switchboard api GET /kanban/features` — pick yours by `planId`. There is **no**
  `GET /kanban/feature`; `/kanban/feature` is POST-only (feature creation).
- **Plans:** `switchboard api GET /kanban/plans` · **One plan:** `switchboard api GET "/kanban/plan?planId=<planId>"`

---

## 4. The Tick Loop (Wake & Operate)

Each time you wake (via background watcher, one-shot timer, or user prompt), follow these steps in order:

### Step 1: Read Head Prompt & Context
Read `.switchboard/teams/<teamId>/head-prompt.md` to re-orient:
- Active feature ID and subtask breakdown.
- Live worker roster and roles.

### Step 2: Read & Claim Incoming Reports
Inspect `.switchboard/teams/<teamId>/reports/`:
```bash
ls -1 .switchboard/teams/<teamId>/reports/*.md 2>/dev/null
```

If you are remote (reaching Switchboard through a tunnel, no filesystem access):
- `switchboard api GET "/teams/<teamId>/reports"` — list unclaimed worker reports with content
- `switchboard api POST "/teams/<teamId>/reports/claim" '{"filename": "..."}'` — mark a report processed

For each unhandled report file:
1. Read the frontmatter and report body.
2. Verify the work (see Step 3).
3. **Claim the report:** Move the report file to `.switchboard/teams/<teamId>/reports/claimed/` (or call `switchboard api POST "/teams/<teamId>/reports/claim" '{"filename": "..."}'` if remote) so it is not re-processed on future ticks:
   ```bash
   mv .switchboard/teams/<teamId>/reports/<report-file>.md .switchboard/teams/<teamId>/reports/claimed/
   ```

### Step 3: Verify Work Empirical via Git
Do not accept "I'm done" at face value. Verify commits and diffs in the worktree/repository:
```bash
git -C <worktree> rev-list --count <base>..HEAD
git -C <worktree> diff <base>..HEAD
```

If you are remote:
- `switchboard api GET "/worktree/<worktreeId>/diff"` — full diff + commit count + commit log
- `switchboard api GET "/worktree/<worktreeId>/diff?stat=true"` — summary only (lighter)

### Step 4: Dispatch Next Subtask or Advance Card
- **Dispatch subtask to a worker:**
  ```bash
  switchboard api POST /kanban/dispatch '{
    "plan": "<subtaskPlanId>",
    "targetColumn": "<CODING_COLUMN>",
    "from": "<your-agent-name>"
  }'
  ```
- **Send prompt to a worker terminal:**
  `"kind"` says what the payload IS, and it decides what the host appends.
  Use `"dispatch"` when the worker is starting work on it — that is what
  attaches the standing-orders block, the seat directive block (GIT POLICY,
  subagent policy) and the dispatch directives. Use `"message"` for a fix
  round, a question, a verdict or a relayed note: the text is delivered alone.
  Omitting `kind` on a payload that carries no `dispatch` object is read as a
  message, so a dispatch must say so.
  ```bash
  switchboard api POST /terminals/verb/ptySendPrompt '{
    "name": "<workerName>",
    "data": "<instructions>",
    "origin": "<your-agent-name>",
    "clearBeforePrompt": false,
    "kind": "dispatch"
  }'
  ```
- **Hand whole feature to review when all subtasks pass — ONLY if your team has a reviewer seat:**
  Check your team roster (from `head-prompt.md` or `ptyListTerminals`) for a seat with role "reviewer".
  If your team has a reviewer:
  ```bash
  switchboard api POST /kanban/dispatch '{
    "plan": "<featurePlanId>",
    "targetColumn": "CODE REVIEWED",
    "from": "<your-agent-name>"
  }'
  ```
  If your team has NO reviewer seat, do NOT move the card. Write a finished report to `.switchboard/mission-control/reports/` naming the feature and its planId, and stop. The card stays where it is.

### Step 5: Pull Next Feature (Queue Next)
When the reviewer reports that the feature passed review:
```bash
switchboard api POST /kanban/queue/next '{
  "from": "<your-agent-name>"
}'
```
- If `dispatched` is returned: begin working on the new feature.
- If `dispatched: null` (`reason: "queue empty"`): all staged work is complete. Report to human and stop.
- If `409 Conflict`: a subtask or feature is still in flight in a coding column.

---

## 5. Wake & Scheduling Patterns

Avoid recurring cron jobs that create a new chat session on every tick. Use one of these in-session patterns:

1. **Event-Driven Background Watcher (Preferred):**
   Run a background script or daemon in the current session that monitors `.switchboard/teams/<teamId>/reports/`. When a new file arrives, it exits or emits output, reactively waking you in the same conversation.
2. **In-Session One-Shot Timer (Alternative):**
   Set a single-shot timer (e.g. `schedule` with `DurationSeconds=60`). When it expires, you wake in the same session, check reports, act, and set another one-shot timer if work is still in flight.
3. **User Prompt (Fallback):**
   User asks for team status or to process updates.
