# Replace MCP Operations with Direct DB Access Skill

## Problem

Switchboard MCP tools (`move_kanban_card`, `get_kanban_state`, etc.) fail when the IPC connection to the Switchboard host is unavailable. However, many of these operations are simple database reads/writes with no complex side effects, making them safe to execute directly via the DuckDB instance.

The current architecture forces all kanban operations through the MCP layer, creating a single point of failure. When IPC is down, agents cannot perform basic operations like moving cards or querying kanban state, even though these are trivial database operations.

## Background

**Evidence from codebase:**
- Column select in ticket view (`review.html:1022-1029`) → calls `KanbanDatabase.updateColumn()`
- `updateColumn()` executes simple SQL: `UPDATE plans SET kanban_column = ?, updated_at = ? WHERE session_id = ?`
- No side effects, no cascading updates, no business logic beyond column name validation
- Column changes are already exposed to users via UI dropdown

**Safe MCP operations (simple DB access):**
- `get_kanban_state` → SELECT queries on `plans` table
- `move_kanban_card` → UPDATE on `kanban_column` field
- `query_plan_archive` → SELECT on archive tables
- `search_archive` → Full-text search on plan content

**Unsafe MCP operations (keep in MCP):**
- `start_workflow`/`stop_workflow`/`complete_workflow_phase` → Workflow orchestration
- `send_message`/`check_inbox` → IPC communication with agents
- ClickUp/Linear API tools → External API calls
- `generate_architectural_diagram` → Complex diagram generation
- `export_conversation` → File export operations

## Solution

Create a **DB Access Skill** (`src/skills/DatabaseAccessSkill.ts`) that provides direct DuckDB operations for safe MCP tools. This skill:

1. **Provides fallback methods** for safe MCP operations when IPC is unavailable
2. **Preserves validation** (e.g., column name validation from `VALID_KANBAN_COLUMNS`)
3. **Maintains audit logging** for traceability
4. **Is available to all agents** as a utility library

### Architecture

```
Agent Request
    ↓
Try MCP Tool
    ↓ (IPC unavailable)
Fallback to DatabaseAccessSkill
    ↓
Direct DuckDB Operation
```

### Implementation Plan

#### Phase 1: Create DatabaseAccessSkill

**File:** `src/skills/DatabaseAccessSkill.ts`

```typescript
export class DatabaseAccessSkill {
  constructor(private db: KanbanDatabase) {}

  // Safe read operations
  async getKanbanState(column?: string): Promise<KanbanState> {
    // Direct SELECT from plans table
    // Mirrors get_kanban_state MCP tool
  }

  async queryPlanArchive(sql: string): Promise<QueryResult> {
    // Direct SELECT from archive tables
    // Mirrors query_plan_archive MCP tool
  }

  async searchArchive(query: string): Promise<SearchResult[]> {
    // Full-text search on plan content
    // Mirrors search_archive MCP tool
  }

  // Safe write operations
  async moveKanbanCard(sessionId: string, targetColumn: string): Promise<boolean> {
    // Direct UPDATE on kanban_column
    // Includes VALID_KANBAN_COLUMNS validation
    // Mirrors move_kanban_card MCP tool
  }

  // Batch operations
  async moveMultipleCards(sessionIds: string[], targetColumn: string): Promise<{ success: string[], failed: string[] }> {
    // Batch UPDATE for performance
  }
}
```

#### Phase 2: Integrate with KanbanDatabase

**File:** `src/services/KanbanDatabase.ts`

- Add public methods for skill-level access
- Ensure validation logic is reusable
- Add audit logging hooks

#### Phase 3: Create Agent Utility

**File:** `src/agents/utils/databaseAccess.ts`

```typescript
import { DatabaseAccessSkill } from '../skills/DatabaseAccessSkill';

export async function safeKanbanOperation(
  mcpTool: () => Promise<any>,
  dbFallback: () => Promise<any>
): Promise<any> {
  try {
    return await mcpTool();
  } catch (err) {
    if (err.message?.includes('IPC not available')) {
      console.warn('[safeKanbanOperation] MCP unavailable, using DB fallback');
      return await dbFallback();
    }
    throw err;
  }
}
```

#### Phase 4: Update Agent Prompts

Add instruction to agent prompts:
```
When MCP tools fail with IPC errors, fall back to DatabaseAccessSkill for:
- get_kanban_state → use DatabaseAccessSkill.getKanbanState()
- move_kanban_card → use DatabaseAccessSkill.moveKanbanCard()
- query_plan_archive → use DatabaseAccessSkill.queryPlanArchive()
- search_archive → use DatabaseAccessSkill.searchArchive()
```

### Validation & Safety

**Preserve existing validation:**
- Column name validation (`VALID_KANBAN_COLUMNS` set)
- Session ID format validation
- SQL injection protection (parameterized queries)

**Add new safeguards:**
- Audit log all direct DB operations
- Rate limiting for batch operations
- Error handling that distinguishes DB errors from MCP errors

### Testing

**Unit tests:** `src/test/database-access-skill.test.ts`
- Test each skill method against known test DB
- Verify validation logic is preserved
- Test batch operations

**Integration tests:**
- Test MCP fallback behavior
- Verify audit logging
- Test with real kanban data

**Regression tests:**
- Ensure existing MCP tools still work
- Verify no breaking changes to KanbanDatabase

### Rollout Strategy

1. **Phase 1:** Implement skill with tests (no production usage)
2. **Phase 2:** Add to agent utility library (still opt-in)
3. **Phase 3:** Update agent prompts to recommend fallback
4. **Phase 4:** Monitor usage and audit logs
5. **Phase 5:** Consider deprecating safe MCP tools (long-term)

## Dependencies

**Existing code:**
- `src/services/KanbanDatabase.ts` - DB connection and validation
- `VALID_KANBAN_COLUMNS` constant - Column validation
- DuckDB instance management

**No new dependencies required** - uses existing DuckDB infrastructure.

## Success Criteria

1. Agents can move kanban cards when MCP IPC is unavailable
2. All validation logic is preserved in the skill
3. Audit logs track all direct DB operations
4. Unit test coverage > 80%
5. No regression in existing MCP tool functionality
6. Batch operations complete in < 1 second for 100 cards

## Risks & Mitigations

**Risk:** Agents bypass MCP for complex operations
- **Mitigation:** Only expose safe operations in skill; keep complex ops in MCP

**Risk:** Direct DB access corrupts data
- **Mitigation:** Preserve all validation; add audit logging; parameterized queries

**Risk:** Inconsistent state between MCP and DB
- **Mitigation:** MCP tools also use KanbanDatabase under the hood; skill is just a direct path

**Risk:** Skill becomes technical debt
- **Mitigation:** Document clearly; treat as fallback, not primary interface

## Related Plans

- `feature_plan_20260317_154731_autoban_bugs.md` - May benefit from reliable card movement
- Any plans involving bulk kanban operations - Can use batch methods

## Open Questions

1. Should the skill be auto-imported in agent contexts, or explicitly required?
2. Should we add a "force DB" flag to MCP tools to skip IPC?
3. What audit log retention policy should we use?
