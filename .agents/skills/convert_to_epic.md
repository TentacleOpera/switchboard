---
description: Convert an existing Switchboard plan into an Epic card.
---

# Convert Plan to Epic

Use this skill when the user wants to turn a regular plan into an Epic.

## Steps

1. Identify the target plan by its plan file path or session ID.
2. Open the plan file and prepend `[EPIC]` to the `## Goal` heading (e.g. `## [EPIC] Goal`).
3. Save the plan file.
4. Post a message to the Switchboard backend to mark the plan as an epic:
   - Message type: `convertToEpic`
   - Payload: `{ sessionId: '<planSessionId>', workspaceRoot: '<workspaceRoot>' }`
5. If the user wants to add subtasks, list the subtask plan files and post `addSubtaskToEpic` messages for each.

## Notes

- A plan that is already a subtask of another epic (`epicId` set) cannot be converted to an epic.
- Reverting: send `convertToEpic` with `revert: true`.
