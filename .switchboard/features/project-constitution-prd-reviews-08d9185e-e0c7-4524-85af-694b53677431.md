---
description: 'Make the PRD/constitution the authored, enforced source of product intent — easy to author, and actually checked at acceptance.'
---

# Project constitution/prd reviews

**Complexity:** 6

Switchboard's "product intent" layer (the per-project **PRD** and the workspace **constitution**) and the **acceptance review** that is supposed to enforce it were built at different times and do not yet connect into a coherent system. This epic closes that gap from both ends: make intent docs easy to author/import, and make the acceptance reviewer actually judge work against them.

Two reinforcing workstreams:

1. **Author/import the intent docs (the bridge).** Add "Set as Requirements (PRD)" and "Set as Constitution" actions to the planning.html Docs tab, reusing the multi-source doc importer that already exists there (local / ClickUp / Linear / **Notion**). This converges the legacy global Notion "design doc" (`planner.designDocLink`) onto the modern per-project PRD + workspace constitution system that project.html owns — its input is hidden (config still honored for back-compat). Includes 3-way collision handling (Replace / Append / Keep) for the single-slot case, reusing the existing in-webview duplicate-doc modal (never a confirm gate).

2. **Enforce the intent (the tester rework).** Rework the `tester` role so it sources its acceptance baseline from the new PRD/constitution (not the legacy Notion doc it was built around) and judges code against **product intent and the spirit of the plan, not the letter** — explicitly differentiated from the code `reviewer`, which checks code-vs-plan. The constitution becomes a real fallback baseline (today it never reaches the tester).

**Why grouped:** one workstream *supplies* the intent docs, the other *consumes* them. The bridge is only valuable if something uses the docs; the tester rework is only valuable if the docs are easy to author. Mutually reinforcing, with no hard ordering dependency — they can land in either order.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Rework the Acceptance Tester into an Intent-Conformance Reviewer](../plans/feature_plan_20260628212519_acceptance-tester-intent-conformance-rework.md) — **CODE REVIEWED**
- [ ] [Bridge planning.html Docs → Project Context (Set as Requirements / Constitution)](../plans/feature_plan_20260628213500_docs-to-project-context-bridge.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

