# Host-Agnostic Verb Engine (A2b)

**Complexity:** 8

## Goal

Make the extension's 605 _handleMessage arms genuinely host-agnostic via INVERT-AND-INJECT — seams injected into the providers in place, results returned in the HTTP body, generic allowlist+schema dispatch — so external agents get readable responses now and B1 (headless standalone) becomes possible later. Split out of the Standalone Headless Switchboard (npx) feature so the burndown can proceed provider-by-provider instead of all 605 arms in one go. Subtask 1 concentrates the hard part (the ~26 switchboard.* command-body extractions, the return contract, HostSecrets, the generic dispatcher); subtasks 2–6 are one mechanical burndown per provider (Design 62 → Setup 117 → Kanban 144 → TaskViewer 110 → Planning 172). Design rationale lives in the attached design-record card (a2b-genuine-verb-extraction-burndown.md) — do not dispatch that card.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [A2b — Host-Agnostic Verb Engine — Design Record (INVERT-AND-INJECT)](../plans/a2b-genuine-verb-extraction-burndown.md) — **PLAN REVIEWED**
- [ ] [Verb Engine · 1 — Foundations: Command Services, Return Contract, Generic Dispatch](../plans/a2b-verb-engine-01-foundations.md) — **PLAN REVIEWED**
- [ ] [Verb Engine · 2 — DesignPanelProvider Burndown (62 arms)](../plans/a2b-verb-engine-02-design-panel.md) — **PLAN REVIEWED**
- [ ] [Verb Engine · 3 — SetupPanelProvider Burndown (117 arms)](../plans/a2b-verb-engine-03-setup-panel.md) — **PLAN REVIEWED**
- [ ] [Verb Engine · 4 — KanbanProvider Burndown (144 arms)](../plans/a2b-verb-engine-04-kanban-provider.md) — **PLAN REVIEWED**
- [ ] [Verb Engine · 5 — TaskViewerProvider Burndown (110 arms)](../plans/a2b-verb-engine-05-taskviewer-provider.md) — **PLAN REVIEWED**
- [ ] [Verb Engine · 6 — PlanningPanelProvider Burndown (172 arms)](../plans/a2b-verb-engine-06-planning-panel.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

