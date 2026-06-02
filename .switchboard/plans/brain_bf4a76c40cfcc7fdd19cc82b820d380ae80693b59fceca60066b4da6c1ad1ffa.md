# Resolve Switchboard Chat Workflow and Agent Persona Path Resolution in Control Plane Mode

Switchboard allows multiple child workspace repositories to share a single parent workspace folder (control plane) containing a unified `.switchboard/` and `.agent/` configuration scaffolding.

Currently, several features resolve file paths using the active child workspace root directly instead of the effective workspace root (parent/control plane). This implementation plan corrects these path lookups.

Per the user's request for Option B, the Action Strip chat workflow button will be updated to copy the dispatch prompt directly to the clipboard (matching the card-level button behavior) instead of reading raw file contents from disk.

## User Review Required

> [!IMPORTANT]
> - The Action Strip chat workflow copy button (`copyChatWorkflow`) will now copy the dispatch prompt (instructing the agent to read `.agent/workflows/switchboard-chat.md`) instead of reading raw file content from disk. This removes the file system dependency entirely from this button.
> - Lookup paths for Agent Personas and Airlock Rules will correctly use the resolved effective workspace root to support control planes/parent workspaces.

## Proposed Changes

---

### Extension Services

#### [MODIFY] [KanbanProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts)

Update the `copyChatWorkflow` message handler to write the dispatch prompt string to the clipboard directly, rather than reading raw file content from the filesystem.

#### [MODIFY] [TaskViewerProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts)

1. Update `_getPersonaForRole` to resolve the effective workspace root before loading the persona markdown file.
2. Update `_handleAirlockExport` to resolve the effective workspace root before reading the `how_to_plan.md` rule file.

## Verification Plan

### Automated Tests
- N/A

### Manual Verification
1. Run the extension development host.
2. Open the Kanban board.
3. Click the "Copy switchboard-chat workflow to clipboard" button in the Action Strip.
4. Verify that the dispatch prompt is copied to the clipboard without throwing a warning message.
5. Verify that agent personas and Airlock exports locate the shared `.agent` files from the parent control plane root when active in child workspaces.
