# AGENTS.md - Switchboard Protocol

## ðŸš¨ STRICT PROTOCOL ENFORCEMENT ðŸš¨

This project relies on **Switchboard Workflows** defined in `.agent/workflows`.

**Rule #1**: If a user request matches a known workflow trigger, you **MUST** execute that workflow exactly as defined in the corresponding `.md` file. Do not "wing it" or use internal capability unless explicitly told to ignore the workflow.

**Rule #2**: You MUST NOT call `send_message` with actions `request_review`, `execute`, or `delegate_task` without first starting the appropriate workflow via `start_workflow()`. The tool will reject the call. This is enforced at the code level.

**Rule #3**: The `send_message` tool auto-routes actions to the correct recipient based on the active workflow. You do NOT need to specify a recipient. If the workflow requires a specific role (e.g. `reviewer`), ensure an agent with that role is registered.

### Workflow Registry

| Trigger Words | Workflow File | Description |
| :--- | :--- | :--- |
| `/challenge`, `/challenge --self`, `challenge --self` | **`challenge.md`** | Internal adversarial review (Grumpy Persona + Balanced Synthesis). No external agent needed. |
| `/handoff`, `/handoff --all`, `handoff --all` | **`handoff.md`** | Default terminal delegation workflow. Optional `--all` only. |
| `/handoff-chat`, `/handoff chat`, `handoff-chat`, `handoff chat` | **`handoff-chat.md`** | Clipboard/chat delegation workflow. Optional `--all` only. |
| `/handoff-relay`, `/handoff relay`, `handoff-relay`, `handoff relay` | **`handoff-relay.md`** | Relay workflow: execute complex work now, stage remainder, then pause for model switch. |
| `/handoff-lead`, `/handoff lead`, `handoff-lead`, `handoff lead` | **`handoff-lead.md`** | Lead Coder one-shot execution workflow for large feature requests. |
| `/accuracy` | **`accuracy.md`** | High accuracy mode with self-review (Standard Protocol). |
| `/enhance` | **`enhance.md`** | Deep planning and structural audit before challenge/handoff. |
| `/chat` | **`chat.md`** | Activate chat consultation workflow. |


### âš ï¸ MANDATORY PRE-FLIGHT CHECK

Before EVERY response, you MUST:

1. **Scan** the user's message for explicit workflow commands from the table above (prefer `/workflow` forms).
2. **Do not auto-trigger on generic language** (for example: "review this", "delegate this", "quick start") unless the user explicitly asks to run that workflow.
3. **If a command match is found**: Read the workflow file with `view_file .agent/workflows/[WORKFLOW].md` and execute it step-by-step. Do NOT improvise an alternative approach.
4. **If no match is found**: Respond normally.

### Execution Rules

1. **Read Definition**: Use `view_file .agent/workflows/[WORKFLOW].md` to read the steps.
2. **Execute Step-by-Step**: Follow the numbered steps in the workflow.
   - If a step says "Call tool X", call it.
   - If a step says "Generate artifact Y", generate it.
3. **Do Not Skip**: Do not merge steps or skip persona adoption unless the workflow explicitly allows it (e.g. `// turbo`).
4. **Do Not Improvise**: If a workflow exists for the user's request, you MUST use it. Calling tools directly (e.g. `send_message` with `request_review`) without following the workflow is a protocol violation and will be rejected by the tool layer.

### Code-Level Enforcement

The following actions are enforced at the tool level and WILL be rejected if misused:

| Action | Required Active Workflow |
| :--- | :--- |
| `execute` | `handoff`, `challenge`, or `handoff-lead` |
| `delegate_task` | `handoff` |
| `submit_result` | *(no restriction â€” this is a response)* |
| `status_update` | *(no restriction â€” informational)* |

Sending to non-existent recipients is always rejected (even when auto-routed).

### 🏗️ Switchboard Global Architecture

```
User ──► Switchboard Operator (chat.md)
              │  Plans captured in .switchboard/plans/features/
              │
              ├──► /challenge      Internal adversarial review (grumpy + synthesis)
              ├──► /handoff-lead   One-shot Lead Coder execution (large features)
              ├──► /handoff --all  Bulk terminal delegation (small features)

All file writes to .switchboard/ MUST use IsArtifact: false.
All inter-agent completion signals use the yield pattern (NO POLLING).
All CLI terminal payloads MUST be a single line: "Please execute the plan at: [ABSOLUTE PATH]"
```

### ⏱️ Timeout & Completion

- **Initial wait**: 120 seconds before first check-in.
- **Hard timeout**: 600 seconds (10 minutes). On timeout: call `stop_workflow(reason: "<agent> timed out")`.
- **Do not advance** to the next phase without the required artifact or result.
- **Completion** is yield-based: ask the user to confirm when the delegate is done. Do not poll.

### 📋 Delegate Prompt Requirements

Every delegated prompt MUST include:
1. Objective and scope
2. Files/artifacts to read/write
3. Verification commands
4. Completion protocol: delegate stops and waits; lead resumes only after explicit user confirmation

**Safety**: Never leak private planning paths (`brain/`, private `task.md`) to delegates. Stage sharable artifacts into `.switchboard/handoff/`.
