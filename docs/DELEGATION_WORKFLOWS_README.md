# Delegation Workflow Requirements

Use this document when creating or updating any workflow that dispatches work to external agents.

## Purpose
- Prevent ambiguous handoffs.
- Keep delegation operationally simple.
- Use explicit operator confirmation as the completion gate.
- Avoid brittle reply-correlation contracts.

## Message Contract (Required)
1. Commands (`delegate_task`, `execute`) MUST be delivered to recipient `inbox`.
2. Dispatching workflow SHOULD capture `dispatch-id` and `dispatch-created-at` from `send_message` for audit logs.
3. Completion is **user-confirmed** (operator says worker is done); do not require delegate reply actions.
4. Sender identity is inferred from caller/workflow context.

## Polling Contract
When waiting for delegated completion:
- Polling inbox with `check_inbox` is optional and for visibility only.
- If used, poll inbox with supported filters:
  - `box: "inbox"`
  - `filter: "delegate_task" | "execute" | "all"`
  - `since: "<dispatch-created-at>"` (optional)
- Do **not** rely on `reply_to` or response-correlation keys.
- Do not treat inbox message presence as completion.

## Timeout Contract (Required)
- Define:
  - initial wait
  - reminder interval/backoff
  - hard timeout
- On timeout:
  - notify user that remote completion was not confirmed
  - call `stop_workflow(reason: "... timed out")` when timeout blocks forward progress

## Yield Mode
All delegation workflows use **user-confirmed yield**: the dispatching agent stops and waits for the operator to confirm the delegate has finished. Do not poll or loop autonomously after dispatch. Ask the user to reply when done.

## Delegate Prompt Requirements
Every delegated prompt MUST include:
1. Objective and scope
2. Files/artifacts to read/write
3. Verification commands
4. Completion protocol:
   - delegated worker stops and waits
   - lead resumes only after explicit user confirmation

## Artifact and Safety Requirements
- Never leak private planning paths (`brain/`, private `task.md`) to delegates.
- Stage sharable artifacts into `.switchboard/handoff/`.
- Require `complete_workflow_phase(..., artifacts=[...])` gates where results are expected.

## Builder Checklist
For every workflow with external delegation, verify all are present:
- Dispatch metadata capture (`dispatch-id`, `created-at`) for auditability
- User-confirmed completion step
- Optional inbox visibility polling only (no reply correlation)
- Timeout stop path
- Yield mode declaration
