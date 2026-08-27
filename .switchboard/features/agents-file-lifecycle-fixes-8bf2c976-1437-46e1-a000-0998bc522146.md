# .agents file lifecycle fixes

**Complexity:** 5

## Goal

Fix the .agents file lifecycle: deletion guard gaps in performSetup and _bootstrapControlPlaneLayout, .claude mirror not regenerating on deletion, and protocols/ directory lacking ledger/drift/retirement mechanism.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Deletion guard gaps: performSetup and _bootstrapControlPlaneLayout restore retired .agents files](../plans/feature_plan_20260827144001_deletion-guard-gaps-performSetup-and-bootstrap.md) — **CREATED** — ID: 5c3c59b5-f2ca-49d5-bcaf-4727d34faac4
- [ ] [.claude/ mirror keeps retired skill until next version bump after .agents/ deletion](../plans/feature_plan_20260827144002_claude-mirror-not-regenerating-on-deletion.md) — **CREATED** — ID: 4044524c-c4c3-442c-986d-027491f67b5b
- [ ] [.agents/protocols/ has no ledger, drift line, or retirement mechanism](../plans/feature_plan_20260827144003_protocols-directory-no-ledger-drift-retirement.md) — **CREATED** — ID: d2fb7a78-9ad6-454b-b12f-539dcdcbd40e
<!-- END SUBTASKS -->
