# Restricting SQL Card Move Instructions to Manual Fallbacks

## Goal

Remove SQL-based database update instructions from the standard conversational routing in `AGENTS.md`, restricting card-moving scripts/SQL to a manual fallback skill (`kanban_operations`) that is only used when explicitly requested by the user.

## Metadata

- **Tags:** workflow, documentation, reliability
- **Complexity:** 3

## User Review Required

> [!IMPORTANT]
> The modification restricts `kanban_operations` and database write actions to manual user requests (fallback override). Normal agent execution will no longer run card-moving scripts/SQL queries.

## Open Questions

None.

## Complexity Audit

### Routine
- All changes are documentation-only (2 files: `AGENTS.md` and `kanban_operations/SKILL.md`)
- No code behavior changes
- Each edit is a text replacement or insertion in a markdown file
- The `query_switchboard_kanban.md` skill file was already corrected by the previous plan (`fix_agents_md_kanban_routing_ambiguity.md`) — no changes needed there

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** N/A — documentation only
- **Security:** Removing SQL UPDATE instructions from agent-facing docs reduces attack surface (agents can no longer be socially engineered into corrupting kanban state via conversational routing)
- **Side Effects:** Agents that previously auto-moved cards via SQL will no longer do so. This is the desired behavior. If a user explicitly requests a card move, the `kanban_operations` skill serves as the manual fallback — this must be clearly documented in the skill warning.
- **Dependencies & Conflicts:** The previous plan (`fix_agents_md_kanban_routing_ambiguity.md`) already updated `query_switchboard_kanban.md` and `accuracy.md`. This plan completes the remaining work on `AGENTS.md` and adds the `kanban_operations` skill as a registered fallback.

## Dependencies

None — this is a standalone documentation fix.

## Adversarial Synthesis

Key risks: (1) Imprecise line references and missing replacement text could lead to incomplete or inconsistent implementation. (2) An overly broad warning on `kanban_operations` would unnecessarily restrict the read-only `get-state.js` script. (3) Ambiguity about when the manual fallback is permitted could cause agents to either refuse legitimate user requests or continue auto-executing card moves. Mitigations: specify exact line numbers and replacement text, distinguish `move-card.js` from `get-state.js` in the warning, and explicitly permit fallback use on user request.

## Proposed Changes

### [AGENTS.md](file:///Users/patrickvuleta/Documents/GitHub/switchboard/AGENTS.md)

#### [MODIFY] Line 66 — Remove SQL UPDATE instruction from conversational routing

**Current text (line 66):**
```
Conversational routing: when the intent is to advance a kanban card or send a plan to the next agent/stage, prefer the `query_switchboard_kanban` skill (use SQL: `UPDATE plans SET kanban_column = '<target>' WHERE session_id = '<session_id>'`) over raw `send_message`. The `target` may be a kanban column label, a built-in role, or a kanban-enabled custom agent name; generic conversational `coded` / `team` targets are smart-routed by plan complexity.
```

**Replace with:**
```
Kanban column transitions are handled automatically by the system/host. Execution agents must NEVER attempt to update kanban columns directly via SQL or any other method during normal workflow execution. The `query_switchboard_kanban` skill is for QUERYING kanban state only (e.g., identifying plans in specific columns). To manually move a card when explicitly requested by the user, use the `kanban_operations` skill.
```

- **Context:** This is the line that directly instructs agents to use SQL UPDATE for card moves during conversational routing.
- **Logic:** Remove the SQL UPDATE instruction entirely. Remove the framing of "advancing a kanban card" as an agent intent during normal execution. State the rule directly: system handles transitions, agents don't. Add reference to `kanban_operations` as the explicit-user-request fallback.
- **Implementation:** Single string replacement at line 66.
- **Edge Cases:** The old text mentions `target` and `coded`/`team` smart-routing. That routing logic is handled by the system, not by agents, so removing it from agent-facing docs is correct.

#### [MODIFY] Line 83 — Update `query_switchboard_kanban` skill description to read-only

**Current text (line 83):**
```
| `query_switchboard_kanban` | Query kanban state or move cards via direct SQL access to kanban.db |
```

**Replace with:**
```
| `query_switchboard_kanban` | Query kanban state via direct SQL access to kanban.db (read-only) |
```

- **Context:** Skill description in the Available Skills table.
- **Logic:** Remove "or move cards" to align with the read-only restriction already enforced in the skill file.
- **Implementation:** Single string replacement at line 83.

#### [INSERT] After line 83 — Register `kanban_operations` as manual fallback skill

**Insert the following row in the skills table:**
```
| `kanban_operations` | Move kanban cards via move-card.js — MANUAL FALLBACK ONLY, use only when user explicitly requests a card move |
```

- **Context:** The `kanban_operations` skill is not currently listed in the AGENTS.md skills table. Agents have no official reference for when to use it.
- **Logic:** Register the skill with a clear description that it is a manual fallback, not for automatic use during workflow execution.
- **Implementation:** Insert a new table row after the `query_switchboard_kanban` row (after line 83, before line 84).
- **Edge Cases:** The `get-state.js` script within this skill is read-only and freely usable, but the skill description focuses on the move-card capability since that's the restricted operation. The SKILL.md file itself will distinguish between the two scripts.

### [SKILL.md](file:///Users/patrickvuleta/Documents/GitHub/switchboard/.agent/skills/kanban_operations/SKILL.md)

#### [MODIFY] Add strict constraint/warning at the top of the skill file

**Insert the following warning block after the `---` frontmatter and before the `# Kanban Operations` heading (between lines 4 and 6):**

```markdown
> ⚠️ **MANUAL FALLBACK ONLY** — The `move-card.js` script is an override/recovery mechanism. Do NOT run it automatically during standard workflow routing. Use it ONLY when the user has explicitly requested a card move. The `get-state.js` script is read-only and may be used freely.
```

- **Context:** The skill file currently has no constraint on when `move-card.js` should be used.
- **Logic:** Add a prominent warning that distinguishes between the two scripts: `move-card.js` is restricted to explicit user requests, while `get-state.js` is freely available for querying.
- **Implementation:** Insert the warning block between the frontmatter (line 4) and the heading (line 6).
- **Edge Cases:** The warning must mention both scripts to avoid agents interpreting the restriction as applying to the entire skill (which would block legitimate read-only queries via `get-state.js`).

## Verification Plan

### Automated Tests

```bash
# Verify no SQL UPDATE instructions remain in AGENTS.md conversational routing
grep -n "UPDATE plans SET kanban_column" AGENTS.md
# Expected: zero matches

# Verify "move cards" language is removed from query_switchboard_kanban description
grep -n "or move cards" AGENTS.md
# Expected: zero matches

# Verify read-only restriction is present in AGENTS.md
grep -n "read-only\|READ-ONLY\|QUERYING.*only" AGENTS.md
# Expected: match on the updated skill description line

# Verify kanban_operations is registered in the skills table
grep -n "kanban_operations" AGENTS.md
# Expected: match showing the new table row

# Verify MANUAL FALLBACK ONLY warning is present in SKILL.md
grep -n "MANUAL FALLBACK ONLY" .agent/skills/kanban_operations/SKILL.md
# Expected: match showing the warning block

# Verify get-state.js is explicitly called out as freely usable
grep -n "get-state.js.*read-only\|get-state.js.*freely" .agent/skills/kanban_operations/SKILL.md
# Expected: match in the warning block
```

### Manual Verification
* Inspect the updated [AGENTS.md](file:///Users/patrickvuleta/Documents/GitHub/switchboard/AGENTS.md) and [SKILL.md](file:///Users/patrickvuleta/Documents/GitHub/switchboard/.agent/skills/kanban_operations/SKILL.md) files to ensure that:
  - Default routing rules in `AGENTS.md` do not mention SQL queries or direct DB updates for card moves.
  - `query_switchboard_kanban` is clearly designated as read-only in the skills table.
  - `kanban_operations` is registered in the skills table as a manual fallback skill.
  - The warning in `kanban_operations/SKILL.md` is prominent, distinguishes between `move-card.js` (restricted) and `get-state.js` (freely usable), and explicitly permits use when the user requests it.

---

**Recommendation:** Send to Intern (complexity ≤ 3)
