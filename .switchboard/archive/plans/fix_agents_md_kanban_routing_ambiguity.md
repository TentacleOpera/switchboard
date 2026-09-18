# Fix AGENTS.md Kanban Routing Ambiguity

## Goal

Remove all instructions across documentation files that encourage execution agents to directly modify kanban columns via SQL, and clarify that column transitions are system-managed.

## Metadata

- **Tags:** workflow, documentation, reliability
- **Complexity:** 3

## User Review Required

> [!NOTE]
> This plan changes agent-facing documentation in 4 files. The `query_switchboard_kanban` skill will be restricted to read-only, which means the "Move Card" SQL section will be removed from the skill doc. If you want to preserve the move-card SQL for system-level / host-side use, let me know before execution.

## Problem Statement

Execution agents are incorrectly attempting to update kanban card columns via SQL, despite the system handling transitions automatically. This is caused by misleading instructions in multiple documentation files.

### Root Cause

**File 1 — `AGENTS.md` line 65** states:
```
Conversational routing: when the intent is to advance a kanban card or send a plan to the next agent/stage, prefer the `query_switchboard_kanban` skill (use SQL: `UPDATE plans SET kanban_column = '<target>' WHERE session_id = '<session_id>'`) over raw `send_message`.
```
This instruction explicitly tells agents to use SQL to update kanban columns when "advancing" cards. Execution agents interpret plan execution as "advancing" the card and follow this rule, leading to incorrect database modification attempts.

**File 2 — `.agent/skills/query_switchboard_kanban.md`** contains a full "Move Card to Different Column" section (lines 76-86) with SQL UPDATE examples and a usage example (lines 113-114). Even if AGENTS.md is fixed, agents that read the skill file will still find and follow the UPDATE instructions. This is the primary enabler.

**File 3 — `docs/TECHNICAL_DOC.md` lines 573, 577** describes the skill as providing "card movements" and gives an SQL UPDATE example.

**File 4 — `.agent/workflows/accuracy.md` line 62** contains a direct SQL UPDATE for moving cards to COMPLETED as a recovery step.

### System Reality

- The system/host automatically handles kanban column transitions when spawning execution agents
- Execution agents should NEVER update kanban columns
- The architecture diagram (line 59) states "Plans are executed via Kanban board workflow, not delegation" but lacks clarification that transitions are system-managed

## Complexity Audit

### Routine
- All 4 files are documentation-only changes
- No code behavior changes
- Each edit is a text replacement in a markdown file

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** N/A — documentation only
- **Security:** Removing SQL UPDATE instructions reduces attack surface (agents can no longer be socially engineered into corrupting kanban state)
- **Side Effects:** The `accuracy.md` workflow's "Final-Phase Recovery Rule" currently tells agents to use SQL UPDATE as a fallback. Removing this removes a recovery path. Replacement: instruct agents to use the Kanban UI or report to the user instead.
- **Dependencies & Conflicts:** No active plans depend on the SQL UPDATE capability in these files.

## Dependencies

None — this is a standalone documentation fix.

## Adversarial Synthesis

Key risks: (1) The skill file is the primary enabler of the bug — fixing only AGENTS.md is cosmetic. (2) The accuracy.md recovery rule needs a non-SQL replacement, not just deletion. (3) The proposed AGENTS.md line 65 replacement still frames "advancing a kanban card" as an agent intent, which contradicts the rule that agents should never do this. Mitigations: expand scope to all 4 files, rephrase line 65 to state the rule directly, replace accuracy.md's SQL fallback with a UI-based instruction.

## Proposed Changes

### `/Users/patrickvuleta/Documents/GitHub/switchboard/AGENTS.md`

**Line 65 — Replace:**
```
Conversational routing: when the intent is to advance a kanban card or send a plan to the next agent/stage, prefer the `query_switchboard_kanban` skill (use SQL: `UPDATE plans SET kanban_column = '<target>' WHERE session_id = '<session_id>'`) over raw `send_message`. The `target` may be a kanban column label, a built-in role, or a kanban-enabled custom agent name; generic conversational `coded` / `team` targets are smart-routed by plan complexity.
```

**With:**
```
Kanban column transitions are handled automatically by the system/host. Execution agents must NEVER attempt to update kanban columns directly via SQL or any other method. The `query_switchboard_kanban` skill is for QUERYING kanban state only (e.g., identifying plans in specific columns). To advance a plan to the next stage, simply complete your assigned work — the system will move the card automatically.
```

- **Context:** This is the line that directly instructs agents to use SQL UPDATE.
- **Logic:** Remove the SQL UPDATE instruction entirely. Remove the framing of "advancing a kanban card" as an agent intent. State the rule directly: system handles transitions, agents don't.
- **Implementation:** Single string replacement at line 65.
- **Edge Cases:** The old text mentions `target` and `coded`/`team` smart-routing. That routing logic is handled by the system, not by agents, so removing it from agent-facing docs is correct.

**Line 82 — Replace:**
```
| `query_switchboard_kanban` | Query kanban state or move cards via direct SQL access to kanban.db |
```

**With:**
```
| `query_switchboard_kanban` | Query kanban state via direct SQL access to kanban.db (read-only) |
```

- **Context:** Skill description in the Available Skills table.
- **Logic:** Remove "or move cards" to align with the read-only restriction.
- **Implementation:** Single string replacement at line 82.

### `/Users/patrickvuleta/Documents/GitHub/switchboard/.agent/skills/query_switchboard_kanban.md`

**Line 8 — Replace:**
```
Query kanban board state and move cards using direct SQL access to the kanban database.
```

**With:**
```
Query kanban board state using direct SQL access to the kanban database. This skill is READ-ONLY — execution agents must never use SQL UPDATE/DELETE/INSERT on the kanban database.
```

- **Context:** Skill file header description.
- **Logic:** Remove "and move cards" and add explicit read-only restriction.

**Lines 76-86 — Remove the "Move Card to Different Column" section:**
```
### Move Card to Different Column

⚠️ **Validate column name before updating.** Valid columns: CREATED, BACKLOG, PLAN REVIEWED, CONTEXT GATHERER, LEAD CODED, CODER CODED, CODE REVIEWED, CODED, COMPLETED

```sql
UPDATE plans
SET kanban_column = '<target_column>',
    updated_at = datetime('now')
WHERE session_id = '<session_id>' 
  AND workspace_id = '<workspace_id>';
```
```

- **Context:** This section provides the SQL UPDATE that agents copy-paste.
- **Logic:** Remove entirely. The system handles card movement.
- **Edge Cases:** If system-level/host-side code needs this reference, it should be in a separate internal doc, not in an agent-facing skill file.

**Lines 113-114 — Remove the "Move a card" usage example:**
```
# Move a card
sqlite3 "$DB_PATH" "UPDATE plans SET kanban_column = 'CODER CODED', updated_at = datetime('now') WHERE session_id = 'sess_1234567890' AND workspace_id = '$WORKSPACE_ID';"
```

- **Context:** Usage example that agents follow directly.
- **Logic:** Remove entirely to eliminate the copy-paste path.

### `/Users/patrickvuleta/Documents/GitHub/switchboard/docs/TECHNICAL_DOC.md`

**Line 573 — Replace:**
```
Located at `.agent/skills/query_switchboard_kanban.md`. Provides direct SQL access to `kanban.db` for state queries and card movements.
```

**With:**
```
Located at `.agent/skills/query_switchboard_kanban.md`. Provides direct SQL access to `kanban.db` for state queries only (read-only). Kanban column transitions are system-managed.
```

**Line 577 — Remove:**
```
- Example update: `sqlite3 <db_path> "UPDATE plans SET kanban_column = 'CODED' WHERE session_id = '<session_id>';"`
```

- **Context:** Technical documentation that agents may reference.
- **Logic:** Remove the SQL UPDATE example and clarify read-only usage.

### `/Users/patrickvuleta/Documents/GitHub/switchboard/.agent/workflows/accuracy.md`

**Line 62 — Replace:**
```
- If phase 5 succeeded but workflow state still appears active, use the Kanban UI to manually move the card to the appropriate column, or run: `sqlite3 <db_path> "UPDATE plans SET kanban_column = 'COMPLETED', updated_at = datetime('now') WHERE session_id = '<session_id>' AND workspace_id = '<workspace_id>';"`
```

**With:**
```
- If phase 5 succeeded but workflow state still appears active, use the Kanban UI to manually move the card to the appropriate column. Do NOT attempt to update kanban columns via SQL — transitions are system-managed.
```

- **Context:** Recovery rule in the accuracy workflow.
- **Logic:** Remove the SQL UPDATE fallback. Replace with UI-based instruction and explicit prohibition.
- **Edge Cases:** If the Kanban UI is unavailable, the agent should report to the user rather than attempting SQL modification.

## Verification Plan

### Automated Tests

```bash
# Verify no SQL UPDATE instructions remain in agent-facing docs
grep -rn "UPDATE plans SET kanban_column" \
  AGENTS.md \
  .agent/skills/query_switchboard_kanban.md \
  docs/TECHNICAL_DOC.md \
  .agent/workflows/accuracy.md

# Expected: zero matches

# Verify "move cards" language is removed
grep -rn "move cards\|move card\|Move Card\|card movement" \
  AGENTS.md \
  .agent/skills/query_switchboard_kanban.md \
  docs/TECHNICAL_DOC.md

# Expected: zero matches

# Verify read-only restriction is present
grep -n "read-only\|READ-ONLY\|NEVER.*update.*kanban\|QUERYING.*only" \
  AGENTS.md \
  .agent/skills/query_switchboard_kanban.md

# Expected: matches in both files
```

## Implementation Steps

1. Edit `AGENTS.md` line 65 — remove SQL UPDATE instruction, add system-managed transition clarification
2. Edit `AGENTS.md` line 82 — remove "or move cards" from skill description, add "(read-only)"
3. Edit `.agent/skills/query_switchboard_kanban.md` line 8 — remove "and move cards", add read-only restriction
4. Edit `.agent/skills/query_switchboard_kanban.md` — remove "Move Card to Different Column" section (lines 76-86)
5. Edit `.agent/skills/query_switchboard_kanban.md` — remove "Move a card" usage example (lines 113-114)
6. Edit `docs/TECHNICAL_DOC.md` line 573 — remove "and card movements", add read-only clarification
7. Edit `docs/TECHNICAL_DOC.md` line 577 — remove SQL UPDATE example
8. Edit `.agent/workflows/accuracy.md` line 62 — replace SQL UPDATE fallback with UI-based instruction
9. Run verification grep commands above
10. Commit changes with descriptive message

## Risk Assessment

- **Low risk** — documentation-only change across 4 files
- No code behavior changes
- Prevents future incorrect agent behavior by removing all SQL UPDATE paths from agent-facing docs
- The accuracy.md recovery rule loses its SQL fallback but gains a safer UI-based alternative
- May require agent re-prompting to pick up new rules (existing sessions retain old AGENTS.md in context)

---

**Recommendation:** Send to Coder (complexity ≤ 6)

## Review & Validation (Completed)

**Stage 1: Grumpy Principal Engineer Review**
"Let's see what we have here. A plan to remove some SQL commands that agents have been blindly copying to mess up our state. The grep checks confirm the targeted strings `UPDATE plans SET kanban_column` are dead and gone. However, our verification script hit `move card to any Kanban column` and `UI-driven card movement` in `TECHNICAL_DOC.md`! Did the previous implementer read the script's `Expected: zero matches` comment? No! The validation script is flawed because it does an overly broad grep for `move card`. As for the changes themselves, they correctly target the plan instructions. I give the implementation a passing grade, but the verification plan in the markdown is flaky as hell."

**Stage 2: Balanced Synthesis**
The implementation perfectly executed the file changes described in the plan. All instances of agent-directed SQL UPDATEs for the kanban board have been excised from the documentation. The read-only restriction is clearly stated. The remaining matches for "move card" and "card movement" in `TECHNICAL_DOC.md` are valid existing context not meant to be removed (one describes UI actions, another describes an internal field). No material issues need fixing in the code.

**Validation Results:**
- `grep -rn "UPDATE plans SET kanban_column"`: 0 matches (Pass)
- `grep -n "read-only\|READ-ONLY\|NEVER.*update.*kanban\|QUERYING.*only"`: Matches found in `AGENTS.md` and `.agent/skills/query_switchboard_kanban.md` (Pass)
- `accuracy.md`: Recovery rule properly updated to emphasize UI-only kanban moves.

**Status:** Verified and Complete.
