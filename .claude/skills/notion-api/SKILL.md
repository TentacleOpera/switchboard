---
name: notion-api
description: Post replies back to a Notion-driven Remote Control card via the LocalApiServer bridge
allowed-tools: Bash
disable-model-invocation: true
---

# Notion Reply Bridge

## When to Use
- A plan is driven by **Notion Remote Control** (it has a `**Notion Page ID:**` line in its
  metadata) and you need to reply to the remote Claude session — a result, a question, or a
  status update.
- Inbound comments from the remote agent are pushed to you by the host poll; you only need
  this skill for the **reply** (outbound) direction.

## Usage
```bash
CUR="$PWD"
while [ "$CUR" != "/" ] && [ ! -d "$CUR/.agents/skills" ]; do CUR=$(dirname "$CUR"); done
source "$CUR/.agents/skills/_lib/sb_api_call.sh"

sb_api_call POST /comment \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "notion",
    "id": "<Notion Page ID from the plan metadata>",
    "body": "Your reply text here."
  }'
```

## Parameters
- `provider`: `"notion"`
- `id`: the **Notion Page ID** (the `**Notion Page ID:**` line in the plan file) — the
  card's page in the Notion plans database, NOT a comment id.
- `body`: the reply markdown. Do NOT add any marker — the host inserts a "Switchboard Comments"
  database row with `From = Switchboard` and `created_by = bot`, which is how the poll skips
  your own reply (no feedback loop). The token stays host-side; never call the Notion API directly.

## Response
JSON `{ "success": true }` on success. A **503** with `notConfigured: true` means Notion remote
setup hasn't been run — surface to the user that they must click **"Run Notion setup sync"** in
the Remote tab. Any other non-200 is a transient failure; report it and stop (do not retry blindly).

## Notes
- If the plan has **no** `Notion Page ID` metadata, do NOT post — notify the user instead (the
  card isn't under Notion Remote Control).
- Replies appear to the remote Claude session on its next turn when it queries the Comments DB
  (`From = Switchboard`). Read-back latency is bounded by the poll interval.
