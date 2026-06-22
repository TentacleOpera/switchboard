---
name: Kanban Operations (SQL)
description: Move kanban cards and query kanban state via direct database access with atomic transactions.
---

# Kanban Operations (SQL)

Move cards and query kanban state by running the provided scripts. This version uses atomic SQL updates to ensure database consistency.

## Move a Card

\`\`\`bash
node .agents/skills/kanban_operations/move-card.js <session_id> <target_column> [plan_file] [workspace_root]
\`\`\`

**Example:**
\`\`\`bash
node .agents/skills/kanban_operations/move-card.js sess_1777206335666 CODER_CODED
\`\`\`

**Valid columns:** CREATED, BACKLOG, PLAN REVIEWED, CONTEXT GATHERER, INTERN CODED, LEAD CODED, CODER CODED, CODE REVIEWED, ACCEPTANCE TESTED, CODED, COMPLETED, etc.

## Get Kanban State

\`\`\`bash
node .agents/skills/kanban_operations/get-state.js [workspace_root]
\`\`\`

Outputs JSON with columns as keys and arrays of plans as values.
