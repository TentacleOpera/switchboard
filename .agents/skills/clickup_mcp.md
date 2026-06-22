# ClickUp MCP

> [!WARNING]
> ⚠️ **DEPRECATED**: This skill documents MCP tool usage. For new integrations and operations, **prefer the skill-based approach** using `clickup_api`, `clickup_fetch`, `clickup_modify_task`, etc.
>
> Keep this file *only* as a reference for uncovered MCP tools (e.g. `resolve_assignees`, `filter_tasks`, time tracking, and workspace hierarchy tools) which do not have skill equivalents yet.

## MCP Tool to Skill Mapping

For the following operations, use the corresponding skills instead of MCP tools:

| MCP Tool | Skill Replacement |
| :--- | :--- |
| `call_clickup_api` | `clickup_api` |
| `clickup_attach` | `clickup_attach` |
| `clickup_create_subpage` | `clickup_create_subpage` |
| `clickup_create_task` | `clickup_create_task` |
| `clickup_fetch` | `clickup_fetch` |
| `clickup_modify_task` | `clickup_modify_task` |

---

This skill is a **reference for MCP-only operations** that have no skill-based equivalent. For standard ClickUp operations (task CRUD, fetching, attaching, creating subpages), **prefer the skill-based approach** using `clickup_api`, `clickup_fetch`, `clickup_modify_task`, etc. For read-only cached ticket access (no MCP round-trips), see the `get_tickets.md` skill.


## When to Use

> [!IMPORTANT]
> The following use cases require MCP tools because no skill-based equivalent exists yet. For all other ClickUp operations, use the skills listed in the mapping table above.

- You need to resolve assignee names to numeric IDs before filtering or creating tasks (**no skill equivalent**)
- You need to filter tasks by multiple criteria (statuses, tags, due dates, lists) (**no skill equivalent**)
- You need to fetch subtasks without hitting the 50,000 token truncation limit (**no skill equivalent**)
- You need task time-in-status reporting (requires ClickApp enabled) (**no skill equivalent**)
- You need to manage dependencies, links, or tags between tasks (**no skill equivalent**)
- You need to track time or manage time entries (**no skill equivalent**)
- You need to work with ClickUp documents, chat, or reminders (**no skill equivalent**)
- You want to understand the boundary between MCP tools and the local API server

## Key Patterns

### Fetching All Subtasks Without Truncation

**Problem**: The default `get_task` response has a 50,000 token limit. For tasks with 20+ subtasks, this truncates the subtask list, making it incomplete.

**Solution**: Use `detail_level='summary'` with `subtasks=true` to fetch subtasks without full descriptions, avoiding the truncation limit.

**Example**:
```
get_task(
  task_id="abc123",
  detail_level="summary",
  subtasks=true
)
```

**When to use this pattern**: Tasks with 20+ subtasks, or when you only need subtask metadata (names, statuses, assignees) not full descriptions.

**Trade-off**: You get subtask metadata but not full subtask descriptions. If you need full descriptions for a specific subtask, make a follow-up call with that subtask's ID.

### Skill-Based vs MCP Tool Boundary

**Problem**: Two ways to access ClickUp data exist — skill-based LocalApiServer invocations (preferred) and MCP tools (fallback for uncovered operations). Knowing which to use prevents unnecessary round-trips and confusion.

**Skill-Based Invocations** (preferred for all covered operations):
- Task CRUD: `clickup_api`, `clickup_create_task`, `clickup_modify_task`
- Task fetching: `clickup_fetch`
- Attachments: `clickup_attach`
- Document pages: `clickup_create_subpage`
- Diagrams: `generate_diagram`
- Read-only cached access: `get_tickets.md` skill (`/task/clickup/{id}`, `/metadata/clickup`)

**MCP Tools** (fallback only — use when no skill equivalent exists):
- Assignee resolution: `resolve_assignees`
- Multi-criteria filtering: `filter_tasks`
- Search: `search`
- Dependencies, links, tags
- Time tracking
- Documents, chat, reminders
- Workspace hierarchy

**Decision heuristic**:
- Use skills for: task CRUD, fetching, attachments, document pages, diagrams, cached read-only access
- Use MCP tools for: assignee resolution, time-in-status, multi-criteria filtering, dependencies, links, tags, time tracking, workspace hierarchy, documents/chat/reminders

**Cross-reference**: See `get_tickets.md` for read-only cached ticket access patterns.

### Resolving Assignees by Name/Email

**Problem**: ClickUp filter and create operations require numeric assignee IDs, but users provide human-readable names or emails.

**Solution**: Use `resolve_assignees` to convert names/emails into numeric IDs before passing to other operations.

**Example**:
```
# First resolve
resolved = resolve_assignees(
  assignees=["John Doe", "jane@example.com"]
)
# Returns: [12345, 67890]

# Then use IDs in filter
filter_tasks(
  list_ids=["list123"],
  assignees=[12345, 67890]
)
```

**Error to avoid**: Passing human-readable names directly to `filter_tasks` or create operations — these expect numeric IDs and will fail or return no results.

### Filtering Tasks by Multiple Criteria

**Problem**: You need to find tasks matching multiple conditions (e.g., specific statuses AND tags AND due date range).

**Solution**: Use `filter_tasks` with multiple filter parameters. Understanding the logic is critical:
- Multiple values **within one filter type** use OR logic (e.g., `statuses=["In Progress", "Done"]` matches tasks with EITHER status)
- Multiple filter **types** use AND logic (e.g., `statuses=["In Progress"]` + `tags=["urgent"]` matches tasks that are BOTH "In Progress" AND have "urgent" tag)

**Example**:
```
filter_tasks(
  list_ids=["list123", "list456"],  # OR: tasks in list123 OR list456
  statuses=["In Progress", "Review"],  # OR: tasks with status "In Progress" OR "Review"
  tags=["urgent", "bug"],  # OR: tasks with "urgent" OR "bug" tag
  due_date_from="2024-01-01",  # AND: also must be due after this date
  due_date_to="2024-12-31"  # AND: also must be due before this date
)
```

**Result interpretation**: This returns tasks that are (in list123 OR list456) AND (In Progress OR Review) AND (urgent OR bug) AND (due between 2024-01-01 and 2024-12-31).

### Task Time-in-Status Reporting

**Problem**: `get_task_time_in_status` fails with "ClickApp not enabled" errors if the workspace doesn't have the "Total time in Status" ClickApp installed.

**Solution**: Check workspace ClickApp settings before relying on this tool. The ClickApp must be enabled at the workspace level for time-in-status data to be available.

**Example**:
```
# This will fail if ClickApp not enabled
get_task_time_in_status(task_id="abc123")
# Error: "Total time in Status ClickApp is not enabled for this workspace"
```

**Workaround**: If the ClickApp is not available, estimate time-in-status by comparing task creation time and status change timestamps from `get_task` (if available), or use the local API server's full task details which may include history.

**When to use this pattern**: Only when you know the workspace has the ClickApp enabled, or when you can gracefully handle the error and fall back to alternative methods.

### Creating Subtasks

**Problem**: You need to create a task as a subtask of a parent task.

**Solution**: Use the `parent` parameter in `create_task`. Note that ClickUp does not allow nested subtasks (subtasks of subtasks).

**Example**:
```
create_task(
  name="Subtask name",
  list_id="list123",
  parent="parent_task_id",  # Makes it a subtask
  description="Description"
)
```

**Error to avoid**: Trying to create a subtask of a task that is already a subtask — this will fail with "Cannot make subtasks of subtasks".

## Tool Categories

### Task Operations
- `get_task` — Fetch single task details (use `detail_level='summary'` for subtasks)
- `create_task` — Create new task (use `parent` to create subtask)
- `update_task` — Update existing task properties
- `delete_task` — Delete a task
- `move_task` — Move task to a different list (changes home list)
- `add_task_to_list` — Add task to additional list (keeps original home list)
- `remove_task_from_list` — Remove task from additional list

### Search and Filter
- `search` — Universal search across workspace (tasks, docs, whiteboards, dashboards, attachments, chat)
- `filter_tasks` — Filter tasks by multiple criteria (statuses, tags, lists, assignees, due dates)

### Comments
- `get_task_comments` — Get task comments
- `get_threaded_comments` — Get threaded replies for a comment
- `create_task_comment` — Create task comment

### Dependencies and Links
- `add_task_dependency` — Set dependency between tasks (waiting_on or blocking)
- `remove_task_dependency` — Remove dependency between tasks
- `add_task_link` — Link two tasks together (bidirectional)
- `remove_task_link` — Remove link between tasks

### Tags
- `add_tag_to_task` — Add tag to task (tag must exist in space)
- `remove_tag_from_task` — Remove tag from task

### Assignees
- `resolve_assignees` — Convert names/emails/"me" to numeric user IDs
- `find_member_by_name` — Get member by name or email

### Time Tracking
- `start_time_tracking` — Start time tracking on a task
- `stop_time_tracking` — Stop currently running time tracker
- `add_time_entry` — Add manual time entry
- `get_current_time_entry` — Get currently running time entry
- `get_task_time_entries` — Get time entries for a specific task
- `get_time_entries` — Get time entries across workspace for reporting
- `get_task_time_in_status` — Get time spent in each status (requires ClickApp)
- `get_bulk_tasks_time_in_status` — Get time in status for multiple tasks (requires ClickApp)

### Workspace and Hierarchy
- `get_workspace_hierarchy` — Get workspace structure (spaces, folders, lists)
- `get_workspace_members` — Get all members in workspace
- `get_list` — Get list details by ID or name
- `get_folder` — Get folder details by ID or name
- `update_list` — Update list properties
- `update_folder` — Update folder properties
- `create_list` — Create list in space
- `create_list_in_folder` — Create list in folder
- `create_folder` — Create folder in space
- `get_custom_fields` — Get custom field definitions

### Documents
- `create_document` — Create document in space/folder/list
- `create_document_page` — Create page in document
- `list_document_pages` — List all pages in document
- `get_document_pages` — Get content of specific pages
- `update_document_page` — Update existing page

### Chat
- `get_chat_channels` — Get chat channels in workspace
- `get_chat_channel_messages` — Get messages from chat channel
- `get_chat_message_replies` — Get threaded replies for chat message
- `send_chat_message` — Send message to chat channel

### Reminders
- `create_reminder` — Create personal reminder
- `update_reminder` — Update existing reminder
- `search_reminders` — Search and list reminders

### Files
- `attach_task_file` — Attach file to task (base64 or URL)

## Tool Quick Reference

| MCP Tool | Primary Use | Key Parameters |
|----------|-------------|----------------|
| `get_task` | Fetch single task details | `task_id`, `detail_level` ("summary" for subtasks), `subtasks` (bool) |
| `create_task` | Create new task/subtask | `list_id`, `name`, `parent` (for subtasks), `assignees` (numeric IDs) |
| `update_task` | Update existing task | `task_id`, `status`, `assignees` (numeric IDs), `priority` (string) |
| `delete_task` | Delete task | `task_id` |
| `move_task` | Move task to different list | `task_id`, `list_id` |
| `search` | Universal search | `keywords`, `filters` |
| `filter_tasks` | Filter by criteria | `list_ids`, `statuses`, `tags`, `assignees` (numeric IDs), `due_date_from`, `due_date_to` |
| `resolve_assignees` | Convert names/emails to IDs | `assignees` (array) |
| `add_task_dependency` | Add dependency | `task_id`, `depends_on`, `type` ("waiting_on" or "blocking") |
| `add_task_link` | Link tasks | `task_id`, `links_to` |
| `add_tag_to_task` | Add tag | `task_id`, `tag_name` |
| `start_time_tracking` | Start timer | `task_id` |
| `stop_time_tracking` | Stop timer | (no params) |
| `add_time_entry` | Manual time entry | `task_id`, `start`, `duration` or `end_time` |
| `get_task_time_in_status` | Time in status | `task_id` (requires ClickApp) |

**Note**: For full parameter documentation, refer to the MCP server schema. This table highlights the most commonly used tools and parameters.

## Common Errors

| Error String | Cause | Fix |
|--------------|-------|-----|
| "Task not found" or "404" | Invalid `task_id` passed to `get_task` | Verify the task ID exists by using `filter_tasks` first to list valid IDs |
| "Assignee not found" | Human-readable name passed to filter/create instead of numeric ID | Use `resolve_assignees` to convert names to IDs first |
| "Total time in Status ClickApp is not enabled" | Workspace doesn't have the required ClickApp installed | Check workspace ClickApp settings; fall back to estimation or disable time-in-status queries |
| "Subtasks truncated" or incomplete subtask list | Default `detail_level` with many subtasks exceeds 50,000 token limit | Use `detail_level="summary"` with `subtasks=true` to avoid truncation |
| "No results" from filter | Filter criteria too restrictive or using wrong logic (OR vs AND) | Review filter logic: same-type filters use OR, different-type filters use AND. Broaden criteria. |
| "Cannot make subtasks of subtasks" | Trying to create subtask of a task that is already a subtask | Create as sibling subtask under the same parent instead |
| "Priority must be a string" | Passed numeric priority (1,2,3,4) instead of string ("urgent","high","normal","low") | Use string values for priority |

## Related Skills

- **`get_tickets.md`** — Local API server access for ClickUp/Linear. Use this for full task details (descriptions, comments, attachments) without MCP round-trips. The boundary: MCP tools for quick lookups and specific operations; local API server for full details and bulk metadata.
- **`archive.md`** — Skills registry and archive operations. Use this to find other available skills or to query historical plans.
