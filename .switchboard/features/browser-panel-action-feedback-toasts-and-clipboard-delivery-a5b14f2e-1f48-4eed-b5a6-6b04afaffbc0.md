# Browser panel action feedback: toasts and clipboard delivery

**Complexity:** 6

## Goal

Verb buttons in the browser/standalone cockpit give no feedback: host notifications are thrown at the VS Code window or console-logged, and the standalone clipboard seam is a no-op so copy buttons copy nothing while the UI reports success. Two subtasks: bridge host notifications into browser panel toasts via request-scoped capture, and finish the prompt-copy return-body retrofit so transport.js can write the browser clipboard.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Bridge host notifications to the browser panels so verb buttons stop looking dead](../plans/feature_plan_20260811143000_bridge-host-notifications-to-browser-toasts.md) — **CREATED**
- [ ] [Finish the prompt-copy return-body retrofit so standalone copy buttons actually copy](../plans/feature_plan_20260811143001_standalone-copy-prompt-verbs-never-reach-a-clipboard.md) — **CREATED**
<!-- END SUBTASKS -->

