# Improve Remote Plan (Linear)

Improve a Switchboard plan stored as a Linear issue — without touching the git repo
or local filesystem. This is the remote-session counterpart to `/improve-plan`, which
operates on local `.md` files.

## When to Use

- You are in a remote session (Claude Code web, claude.ai) with no local machine running.
- A plan exists as a Linear issue in a Switchboard-mapped project.
- You need to deepen the plan and advance its status so the startup reconciler moves the kanban card.

## When NOT to Use

- You have a local VS Code session with the Switchboard extension active → use `/improve-plan` instead (it edits local files directly).
- The plan is in Notion → Notion read/write is not yet supported via the agent API. Use the local `/improve-plan` workflow instead.

## Prerequisites

- The Switchboard extension must be active (LocalApiServer running) — `sb_api_call.sh` health-checks this automatically.
- Linear integration must be configured in Switchboard (the proxy adds the token host-side).
- **Source the API helper before any `sb_api_call` invocation** — `sb_api_call` is a shell
  function, not a standalone command. Source it once at the start of the session:
  ```bash
  source "$(git rev-parse --show-toplevel)/.agents/skills/_lib/sb_api_call.sh"
  ```

## Pre-flight

1. Confirm the LocalApiServer is reachable: `sb_api_call.sh` will fail with a clear error if not.
2. Identify the target Linear issue:
   - If the user provides an issue ID/URL: use it directly.
   - If no issue specified: query for issues in the "Created"/backlog status in the Switchboard-mapped project:
     ```bash
     sb_api_call POST /api/linear -H "Content-Type: application/json" -d '{
       "query": "query { issues(first: 50, filter: { team: { id: { eq: \"<TEAM_ID>\" } } }) { nodes { id identifier title state { id name } } } }"
     }'
     ```
   - Present the list to the user and let them choose.
3. Identify the target "Improved" status:
   - Query the team's workflow states:
     ```bash
     sb_api_call POST /api/linear -H "Content-Type: application/json" -d '{
       "query": "query { teams(first: 1) { states { id name type } } }"
     }'
     ```
   - Present the state names to the user and ask which one corresponds to the "Improved" column. Do NOT guess — an incorrect status = wrong column advance or silent no-op.

## Read Phase

1. Fetch the full issue:
   ```bash
   sb_api_call POST /api/linear -H "Content-Type: application/json" -d '{
     "query": "query { issue(id: \"<ISSUE_ID>\") { id title description state { id name } } }"
   }'
   ```
2. Parse the `description` field as the plan content.
3. If the description is empty or missing a `## Goal` section, warn the user — the plan may not have been authored yet. Ask whether to proceed with minimal content or abort.

## Improve Phase

Apply the same logic as `/improve-plan`:
- Sharpen and expand the `## Goal` section with problem analysis and root cause if missing.
- Identify and document edge cases not covered by the current tasks.
- Deepen implementation tasks with specific file paths, method names, and constraints where inferable from the description.
- Add or improve `## Edge Cases & Risks` and `## Out of Scope` sections.
- Do NOT change the plan's intent or introduce scope the user hasn't approved.

## Write Phase

Write the improved content AND update the status in a SINGLE `issueUpdate` mutation using GraphQL variables (avoids double-escaping and eliminates the two-call race condition):
```bash
sb_api_call POST /api/linear -H "Content-Type: application/json" -d '{
  "query": "mutation UpdateIssue($id: String!, $desc: String, $stateId: String) { issueUpdate(id: $id, input: { description: $desc, stateId: $stateId }) { success issue { id } } }",
  "variables": { "id": "<ISSUE_ID>", "desc": "<IMPROVED_CONTENT>", "stateId": "<STATE_ID>" }
}'
```
- **Use GraphQL variables** (the `"variables"` key) to pass the description and stateId — NOT string concatenation in the query body. This avoids the JSON-in-GraphQL double-escaping chain entirely; only standard JSON escaping (`\"`, `\n`, `\\`) is needed, which `jq` or any JSON serializer handles automatically.
- The `issueUpdate` mutation accepts both `description` and `stateId` in the same `input` object atomically. A single call updates both in one transaction.
- Check `success === true` in the response before reporting success.
- Do NOT move the issue to a status that triggers local execution (e.g. "Coded") unless the user explicitly instructs it — the purpose of this skill is improvement, not dispatch.
- **Size limit:** The `description` field has a 250,000-character maximum. If the improved plan exceeds this, the mutation will reject with a validation error.

## Confirmation

1. Report back: issue ID/identifier, what was changed (summary), and what status it was set to.
2. Remind the user that the kanban card will advance on next IDE startup via the startup reconciler.
3. If the startup reconciler has NOT been deployed yet, warn the user that the card won't advance automatically — they'll need to manually move it or start pinging.

## Out of Scope

- Creating new plans from scratch (the read phase requires existing plan content).
- Dispatching local execution (that's a separate status transition the user controls).
- Notion support (the agent API surface doesn't expose Notion page read/write — follow-up plan needed).
- Modifying the `/improve-plan` skill (the local session variant stays unchanged).
