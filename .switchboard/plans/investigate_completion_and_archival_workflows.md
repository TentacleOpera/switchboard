# Investigate Completion and Archival Workflows

## Goal

Map and document the complete completion and archival workflows in Switchboard, including:
- What happens when a plan is marked as complete
- What triggers archival
- The code paths involved
- The relationship between "completed" status and "archived" status
- Settings and configuration options
- The difference between DuckDB archival and file-system archival

This is an **investigation and documentation plan**, not a bug fix. The goal is to produce clear documentation that explains how completion and archival work so that future changes can be made with full understanding.

## Metadata
**Tags:** documentation, backend, database
**Complexity:** 4

## Investigation Scope

### 1. Completion Workflow
- User action: Moving a plan to COMPLETED column
- Code entry points
- Status changes in database
- Side effects (archival, file movements, registry updates)
- Settings that control behavior

### 2. Archival Workflow
- What triggers archival (automatic vs manual)
- DuckDB archival (metadata)
- File-system archival (plan files)
- Archive settings and configuration
- Archive location (local vs cloud-synced)

### 3. Status Semantics
- `active` status
- `completed` status
- `archived` status
- `deleted` status
- How these map to kanban columns
- How these transition between each other

### 4. Configuration Settings
- `switchboard.archive.autoArchiveCompleted`
- `switchboard.archive.dbPath`
- Any other archive-related settings
- Where these are exposed in UI
- Default values

## Investigation Workstreams

### Workstream 1 — Trace the completion path
#### Tasks
- Find the code that handles moving a plan to COMPLETED column
- Trace the call stack from UI action to database update
- Document all side effects that occur on completion
- Identify where archival is triggered in the completion flow
- Check if there are conditional branches (e.g., based on settings)

#### Files to inspect
- `src/services/TaskViewerProvider.ts` (likely contains completion handlers)
- `src/services/KanbanProvider.ts` (kanban move handlers)
- `src/services/KanbanDatabase.ts` (database operations)
- `src/webview/kanban.html` (UI triggers)

#### Questions to answer
1. What function is called when a plan is moved to COMPLETED?
2. What database status changes occur?
3. Is archival always triggered on completion, or conditional?
4. What files are moved or copied during completion?
5. Are there any settings that modify completion behavior?

### Workstream 2 — Trace the archival path
#### Tasks
- Find the code that performs archival
- Trace both DuckDB archival and file-system archival
- Document what data is stored in DuckDB vs file-system
- Identify where archive path is configured
- Check if archival can be triggered independently of completion

#### Files to inspect
- `src/services/ArchiveManager.ts` (archive service)
- `src/services/TaskViewerProvider.ts` (may call ArchiveManager)
- `src/services/archiveSchema.sql` (DuckDB schema)
- `.switchboard/archive.duckdb` (actual archive database)

#### Questions to answer
1. What function performs archival?
2. What data is written to DuckDB?
3. What files are moved to `.switchboard/archive/plans/`?
4. Can archival be triggered manually (not just on completion)?
5. What is the relationship between DuckDB archival and file-system archival?

### Workstream 3 — Map status transitions
#### Tasks
- Create a state diagram showing all possible status transitions
- Document what triggers each transition
- Identify which transitions are automatic vs user-initiated
- Map statuses to kanban columns

#### Files to inspect
- `src/services/KanbanDatabase.ts` (status queries and updates)
- `src/services/TaskViewerProvider.ts` (status conversions)
- Database schema for `plans` table

#### Questions to answer
1. What are all possible statuses?
2. What transitions are possible between statuses?
3. Which transitions happen automatically?
4. Which transitions require user action?
5. How do statuses map to kanban columns?

### Workstream 4 — Audit archive settings
#### Tasks
- Find all archive-related configuration settings
- Document where each setting is defined
- Document where each setting is read/used
- Identify settings that are exposed in UI vs hidden
- Check default values for each setting

#### Files to inspect
- `package.json` (setting definitions)
- `src/webview/setup.html` (setup UI)
- `src/extension.ts` (settings registration)
- Runtime code that reads settings

#### Questions to answer
1. What archive-related settings exist?
2. Which are exposed in setup UI?
3. Which are phantom (defined but not used)?
4. What are the default values?
5. Where should each setting be exposed?

### Workstream 5 — Document the archive database schema
#### Tasks
- Read and document the DuckDB archive schema
- Document all tables and their purposes
- Document relationships between tables
- Identify what data is stored vs what is not stored

#### Files to inspect
- `src/services/archiveSchema.sql`
- `.switchboard/archive.duckdb` (query actual schema)

#### Questions to answer
1. What tables exist in the archive database?
2. What columns does each table have?
3. What relationships exist between tables?
4. What data is NOT stored in the archive?
5. How does the archive schema relate to the main kanban.db schema?

## Deliverables

### 1. Completion Workflow Diagram
A clear diagram or step-by-step description of what happens when a plan is marked complete, including:
- Entry point (user action)
- All function calls in the call stack
- Database status changes
- File system changes
- Archival side effects
- Settings that affect behavior

### 2. Archival Workflow Diagram
A clear diagram or step-by-step description of the archival process, including:
- Triggers (automatic vs manual)
- DuckDB operations (what data, where)
- File-system operations (what files, where)
- Configuration options
- Error handling

### 3. Status Transition Matrix
A matrix showing:
- All possible statuses
- All possible transitions between statuses
- What triggers each transition
- Whether each transition is automatic or user-initiated

### 4. Settings Documentation
A table of all archive-related settings, including:
- Setting name
- Default value
- Where it's defined
- Where it's used
- Whether it's exposed in UI
- Whether it's phantom (defined but unused)

### 5. Archive Schema Documentation
Documentation of the DuckDB archive schema, including:
- All tables and their purposes
- All columns and their types
- Relationships between tables
- What data is stored vs what is missing

### 6. Summary Document
A concise summary document that answers:
- What is the difference between "completed" and "archived"?
- When does archival happen?
- Can archival be disabled?
- Where are archived plans stored?
- How can archived plans be retrieved?
- What settings control archival behavior?

## Success Criteria

The investigation is complete when all deliverables are produced and the reviewer can answer:
1. What exactly happens when a plan is marked complete?
2. What exactly happens during archival?
3. What is the difference between "completed" and "archived" status?
4. What settings control completion and archival behavior?
5. Where are archived plans stored (both DuckDB and file-system)?
6. How can I retrieve or restore an archived plan?
7. What are the current bugs or gaps in the completion/archival system?

## Recommended Agent

Send to any agent (documentation task, complexity 4)
