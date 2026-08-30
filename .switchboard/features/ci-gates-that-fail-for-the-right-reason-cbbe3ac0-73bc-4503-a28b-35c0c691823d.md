# CI Gates That Fail For the Right Reason

**Complexity:** 6

## Goal

Make the test gates report the truth: a gate that passes because it cannot see the defect is worse than no gate, and a gate that is red for its own reasons trains everyone to ignore it.

Five defects, one theme. A composition-root parity gate that never actually fails. Source-pin regexes that anchor on a first clause and go false-red. A kanbanColumnDerivation test red at HEAD and unwired from CI. A vscode-test harness that fails locally with ENOENT, blocking two suites. And mirror:check not asserting that a gated skill carries no source frontmatter.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [`mirror:check` must assert that a gated skill carries no source frontmatter](../plans/mirror-check-asserts-invocation-frontmatter-invariant.md) — **CREATED** — ID: 8f5ed8f4-4fe2-4133-ad65-bab3721f861d
- [ ] [kanbanColumnDerivation test is red at HEAD and unwired from CI](../plans/feature_plan_20260827161631_kanban-column-derivation-test-red-and-unwired.md) — **CREATED** — ID: ad6a5878-d5eb-4603-ac73-4decf6386fa1
- [ ] [vscode-test harness fails locally with ENOENT, blocking KanbanProvider and agentPromptBuilder suites](../plans/feature_plan_20260827161633_vscode-test-harness-enoent-locally.md) — **CREATED** — ID: cada9980-c314-4924-88dc-7c865052d1cc
- [ ] [Audit source-pin regexes for first-clause anchoring false-reds](../plans/feature_plan_20260827161637_audit-source-pin-regexes-first-clause-false-reds.md) — **CREATED** — ID: 1cc288cc-aedb-4691-a65e-9b6b669536b7
- [ ] [A composition-root parity gate that actually fails](../plans/a-composition-root-parity-gate-that-actually-fails.md) — **CREATED** — ID: a82e0a62-9e12-4997-839a-2151c4d49f68
<!-- END SUBTASKS -->
