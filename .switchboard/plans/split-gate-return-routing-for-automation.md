# Split-Gate Return Routing via Standing Orders

## Goal

When the improve-plan protocol's mandatory split gate halts and returns a split proposal, the planner needs runtime instructions for what to do with that return. The workflow itself is mode-agnostic (check, halt, return) — the routing behavior belongs in the standing orders system, which injects role-scoped instructions into agent prompts. This plan adds a `role`-scoped standing order for the `planner` role that tells the planner: when the split gate halts, write the split proposal into the plan's `## Outstanding Questions`, add a visible marker at the top of the plan, and post a blocked report to the orchestrator reports channel.

### Root Cause Analysis

The improve-plan workflow (after the `enforce-mandatory-split-gate` plan's changes) halts and returns a split proposal, but says nothing about where the return goes. The standing orders system is the existing mechanism for runtime instructions scoped by role — a `role: 'planner'` order is injected into every planner's prompt via `roleMap` resolution (`TaskViewerProvider.ts:798-804`). The orchestrator reports channel (`.switchboard/orchestrator/reports/`) is the existing file-based inbox where agents post messages for the orchestrator (`ScheduledJobsService.ts:181-191`). Both mechanisms already exist and are fully landed; this plan wires them together for the split-gate case.

## Metadata

**Complexity:** 3
**Tags:** feature, backend
**Project:** Browser Switchboard

## User Review Required

This plan adds a standing order configuration. Per the consultation mode rules, no implementation will occur until the user has reviewed this plan and explicitly instructed to proceed.

## Complexity Audit

### Routine
- Creating a standing order with a known scope (`role: 'planner'`) and instruction text via the existing API endpoint (`POST /terminals/standing-orders`, `LocalApiServer.ts:6084-6085`)
- The standing orders system already supports `role` scope (`standingOrders.ts:204-212`, landed per `standing-orders-role-scope.md` Completion Summary)
- The orchestrator reports channel already exists (`.switchboard/orchestrator/reports/`, bootstrapped by `bootstrapOrchestratorReportsDirectory` at `ScheduledJobsService.ts:181-191`)
- Role-scoped orders render as plain rules via `renderOrder` (`standingOrders.ts:248-257`) — no "Regarding terminal" framing

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions**: None — standing orders are read at prompt-build time and serialized through `_writeChain` (`standingOrders.ts:41-60`).
- **Security**: None — standing orders are localhost-only config, same trust boundary as all agent instructions.
- **Side Effects**: The standing order applies to ALL planners, not just improve-plan planners. The instruction text is explicitly conditional on the split gate triggering ("When the improve-plan split gate halts...") so it does not interfere with other planner workflows (e.g. initial plan creation). A planner running a non-improve-plan workflow sees the instruction but the condition is not met, so it is inert.
- **Dependencies & Conflicts**: Depends on the `enforce-mandatory-split-gate-in-improve-plan-protocol` plan — the split gate must exist in the workflow before there's a halt to route. The standing order instruction references the orchestrator reports channel, which already exists. The `role` scope is fully landed (`standing-orders-role-scope.md` Completion Summary + Review Findings confirm tests pass at 63/0).

## Dependencies

- `enforce-mandatory-split-gate-in-improve-plan-protocol` — the workflow change must land first; this plan routes the halt return that the workflow produces.

## Adversarial Synthesis

Key risks: (1) The standing order applies to all planners, so the instruction must be conditional ("when the split gate halts") rather than unconditional — a planner running initial plan creation should not see split-gate routing as a standing rule. Mitigation: the instruction text is explicitly conditional on the split gate triggering. (2) If no orchestrator is active, the planner posts a report to the reports directory that no one reads immediately. Mitigation: the plan-level marker (written into the plan file) is the persistent signal that survives regardless of orchestrator state — the report is the active notification, the marker is the durable record. The report sits harmlessly in the reports directory until an orchestrator wakes and scans it.

## Proposed Changes

### Change 1: Add a `role`-scoped standing order for `planner`

**Creation mechanism:** `POST /terminals/standing-orders` (handler at `LocalApiServer.ts:4290-4376`, route registered at `:6084-6085`) with body:

```json
{
  "action": "add",
  "parent": "",
  "child": "",
  "scope": "role",
  "role": "planner",
  "instruction": "<exact instruction text below>"
}
```

**Field values:**
- `parent`: `""` (empty string) — role-scoped orders do not use `parent`; the test convention (`standing-orders-marker-contract.test.js:769`) uses `parent: ''`.
- `child`: `""` (empty string) — role-scoped orders do not use `child`; same convention.
- `scope`: `"role"` — validated by the API handler (`LocalApiServer.ts:4329-4332`).
- `role`: `"planner"` — validated as required for `role` scope (`LocalApiServer.ts:4355-4359`). The `planner` role is a real role: the "PLAN REVIEWED" kanban column has `role: 'planner'` (`agentConfig.ts:152`).
- `instruction`: the exact text below.

**Exact instruction text** (renders as `- ${instruction}\n` per `renderOrder` at `standingOrders.ts:248-257` — plain rule, no "Regarding terminal" framing for non-`pair` scopes):

> When the improve-plan split gate halts (the plan has 3+ distinct deliverables or 2+ independently-shippable phases), do the following in order: (1) Write the split proposal into the plan file under a `## Outstanding Questions` section as a `[user]` item, including the proposed boundary breakdown (which sections become which new plan files, with a one-line rationale per boundary). (2) Add a visible marker at the top of the plan file, directly below the title: `> **Needs split — unsuitable for coding as-is. See Outstanding Questions.**` (3) Post a blocked report to the orchestrator reports channel by writing a file directly to `.switchboard/orchestrator/reports/report-<YYYYMMDDTHHMMSSZ>-blocked-<5digits>.md` with YAML frontmatter `from: planner`, `kind: blocked`, `planId: <full path to the plan file>`, `created: <ISO 8601 timestamp>`, followed by a body describing the split proposal and the plan ID. Always post the report — if no orchestrator is currently active, the report sits harmlessly in the directory and is picked up on the next orchestrator wake. Do not improve the mega-plan. Do not write split files. The pass is terminal after these three steps.

> **Superseded:** (3) If an orchestrator is active, post a report to the orchestrator reports channel at `.switchboard/orchestrator/reports/report-<UTC-compact>-blocked-<5digits>.md` with `kind: blocked`, `from: planner`, and the plan ID.
> **Reason:** The "if an orchestrator is active" condition is uncheckable from the planner — an LLM agent in a terminal has no API to query orchestrator state. The condition is a fiction the planner cannot evaluate. Additionally, the frontmatter was underspecified (missing `planId` path format and `created` timestamp).
> **Replaced with:** Always post the report. If no orchestrator is active, the report sits harmlessly in the reports directory and is picked up on the next orchestrator wake. The plan-level marker (step 2) is the durable signal that survives regardless of orchestrator state. Full frontmatter specified: `from`, `kind`, `planId`, `created`.

**Rendering note:** The `renderOrder` function (`standingOrders.ts:248-257`) renders all non-`pair` scopes as `- ${o.instruction}\n`. The instruction text above will appear in the planner's prompt as a single bullet rule inside the `=== STANDING ORDERS ===` block. No "Regarding terminal" framing is emitted for `role` scope.

## Verification Plan

### Automated Tests
None — this plan creates a standing order configuration entry via the existing API. No source code is modified, so no unit tests are added. The existing test suite (`standing-orders-marker-contract.test.js`) already covers role-scoped order selection, rendering, and `roleMap` resolution.

### Manual Verification
1. Confirm the standing order is created with `scope: 'role'`, `role: 'planner'`, `parent: ''`, `child: ''`, and the exact instruction text above — verify via `GET /terminals/standing-orders` (`LocalApiServer.ts:6080-6081`).
2. Confirm the instruction text is explicitly conditional on the split gate ("When the improve-plan split gate halts...") — does not fire on every planner run.
3. Confirm the instruction says "Always post the report" — no uncheckable "if orchestrator is active" condition.
4. Confirm the report frontmatter specification includes all four fields: `from`, `kind`, `planId`, `created`.

### Scenario Test (mental walkthrough)
- **Scenario A (split gate triggers, orchestrator active):** Gate halts → planner writes Outstanding Questions + marker in plan → planner posts report to `.switchboard/orchestrator/reports/` → orchestrator picks up report on next wake → orchestrator reads plan content, sees marker, does not dispatch → human reviews later, sees both the report and the plan marker. Correct.
- **Scenario B (split gate triggers, no orchestrator):** Gate halts → planner writes Outstanding Questions + marker in plan → planner posts report to `.switchboard/orchestrator/reports/` → report sits unread → plan sits with marker. Any downstream consumer (human checking the board, orchestrator started later, another agent) reads the plan, sees the marker, knows it needs human review. The report is picked up when an orchestrator eventually wakes. Correct.
- **Scenario C (split gate does not trigger):** Gate passes → planner proceeds normally → standing order is irrelevant for this pass (the condition "when the split gate halts" is not met). Correct.
- **Scenario D (planner running non-improve-plan workflow):** Planner receives the standing order in its prompt → reads "When the improve-plan split gate halts..." → condition is not met (not running improve-plan) → instruction is inert. Correct.

## Outstanding Questions
- **[user]** When the orchestrator picks up the `kind: blocked` report, what exactly does it do? The working assumption is: log a note to its session file (`.switchboard/orchestrator/session.md`) recording that the plan is blocked — needs split, awaiting human review — then skip it and move on. This behavior likely belongs in the orchestrator persona protocol (`.agents/protocols/switchboard-orchestrator/`), not in the planner's standing order. This plan does not modify the orchestrator protocol — the orchestrator's handling of `kind: blocked` reports is defined elsewhere and is out of scope. The exact logic is still to be finalised.
