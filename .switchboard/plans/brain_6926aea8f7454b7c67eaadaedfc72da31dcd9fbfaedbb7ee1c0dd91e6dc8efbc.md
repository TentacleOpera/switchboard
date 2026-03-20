# Improve `get_kanban_state` Tool Efficiency and Mapping

The user noted significant overhead when asking for plans in specific columns. Currently, the `get_kanban_state` tool returns the entire board state (all 4 columns) with full metadata, even when only one column is needed. Additionally, the internal column keys do not match the UI labels, causing confusion.

## Proposed Changes

### [MCP Server] (file:///c:/Users/patvu/Documents/GitHub/switchboard/src/mcp-server/register-tools.js)

#### [MODIFY] [register-tools.js](file:///c:/Users/patvu/Documents/GitHub/switchboard/src/mcp-server/register-tools.js)
- Update the `get_kanban_state` tool definition to accept an optional [column](file:///c:/Users/patvu/Documents/GitHub/switchboard/src/webview/kanban.html#544-553) parameter.
- Modify the tool implementation to:
    - Filter results if the [column](file:///c:/Users/patvu/Documents/GitHub/switchboard/src/webview/kanban.html#544-553) parameter is provided.
    - Include a `label` field for each column that matches the UI (e.g., `CREATED` -> `Plan Created`).
    - Slightly trim redundant metadata if necessary (though the column filtering alone will reduce volume significantly).

## Verification Plan

### Manual Verification
1.  Run the updated `get_kanban_state` tool without arguments and verify all columns are returned with their new UI labels.
2.  Run the tool with `column: "CREATED"` (or "Plan Created" if supported) and verify only that column is returned.
3.  Check the total output size to ensure it is significantly smaller for single-column requests.

### Automated Tests
- I will attempt to add a new test case in `src/test/kanban-mcp.test.js` (creating a new file) if a simple harness can be constructed, or I will rely on manual tool calls as is standard for MCP tool updates when a full harness isn't available.
