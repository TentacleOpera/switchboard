# Fix AGENTS.md references to deprecated handoff workflows

## Goal
Remove references to deprecated handoff workflows from AGENTS.md to prevent agents from incorrectly attempting to use delegation for tasks that should be handled directly.

## Background
The AGENTS.md file currently contains extensive references to `/handoff`, `/handoff-chat`, `/handoff-relay`, and `/handoff-lead` workflows in the Workflow Registry, Code-Level Enforcement table, and Architecture diagram. These workflows are deprecated, but the protocol document still directs agents to use them, causing confusion.

## Proposed Changes

### 1. Remove handoff workflows from Workflow Registry
Remove or mark as deprecated the following entries in the Workflow Registry table:
- `/handoff`, `/handoff --all` → `handoff.md`
- `/handoff-chat`, `/handoff chat` → `handoff-chat.md`
- `/handoff-relay`, `/handoff relay` → `handoff-relay.md`
- `/handoff-lead`, `/handoff lead` → `handoff-lead.md`

Location: `/Users/patrickvuleta/Documents/GitHub/switchboard/AGENTS.md` lines 17-20

### 2. Update Code-Level Enforcement table
Remove rows referencing handoff-dependent actions:
- `execute` action requiring `handoff`, `improve-plan`, or `handoff-lead`
- `delegate_task` action requiring `handoff`

Location: `/Users/patrickvuleta/Documents/GitHub/switchboard/AGENTS.md` lines 52-53

### 3. Update Switchboard Global Architecture diagram
Remove `/handoff-lead` and `/handoff --all` from the architecture diagram and clarify that implementation is now handled via Kanban sidebar.

Location: `/Users/patrickvuleta/Documents/GitHub/switchboard/AGENTS.md` lines 61-72

### 4. Add Workflow File Editing policy
Add a new rule clarifying how workflow files should be modified. Since delegation is deprecated, workflow files (`.agent/workflows/`, `.agent/personas/`) must be edited directly by the user or via a specific documented process.

Suggested addition after line 91 (after the Safety section).

### 5. Remove or revise Timeout & Completion section
The Timeout & Completion section (lines 76-81) and Delegate Prompt Requirements section (lines 83-91) assume handoff-based delegation. These need to be removed or rewritten to reflect the new Kanban-based workflow.

## Verification Plan
- [ ] Workflow Registry contains only active workflows (`/accuracy`, `/improve-plan`, `/challenge`, `/chat`)
- [ ] Code-Level Enforcement table removed or updated to reflect current capabilities
- [ ] Architecture diagram shows Kanban-based flow, not handoff delegation
- [ ] Workflow file editing policy is documented
- [ ] Timeout/Completion sections removed or updated for new model

## Open Questions
- [ ] Should `/improve-plan` also be removed if it's similarly deprecated?
- [ ] Is there a replacement delegation mechanism, or is all implementation now user-driven via Kanban?
