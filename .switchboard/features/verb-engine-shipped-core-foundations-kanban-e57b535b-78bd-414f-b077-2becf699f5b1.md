# Verb Engine — Shipped Core: Foundations + Kanban

**Complexity:** 8

## Goal

The two A2b subtasks already implemented (Foundations: command services/return contract/generic dispatch, and the KanbanProvider arm burndown). Split out so the shipped work can be code-reviewed independently. Unblocks the Kanban browser board.

This feature carries no new work — it isolates the *built* part of the Host-Agnostic Verb Engine so it gets a focused review, separate from the still-backlogged provider burndowns.

## How the Subtasks Achieve This

- **Verb Engine · 1 — Foundations**: the hard core. Extracts the ~26 `switchboard.*` command bodies into host-agnostic domain services, establishes the **return-in-body** contract (arms `return` their result, not just push), adds `HostSecrets`, and replaces the 605-case per-provider switches with a single **generic allowlist + schema dispatcher** (`handleServiceVerb` → validated `_handleMessage`). This is the shared engine every other provider's burndown builds on.
- **Verb Engine · 4 — KanbanProvider Burndown (144 arms)**: migrates the board's arms in place onto the seams (verified host-agnostic — ~151 seam-calls now outnumber its vscode refs), so the Kanban board runs with no VS Code. The first fully migrated provider and the one the Kanban browser board depends on.

## Dependencies & sequencing

- **Cross-feature (downstream):** ·1 Foundations is the prerequisite for **every** other burndown — ·6 (Project feature) and ·2/·3/·5 (Rest feature) all rely on its generic dispatcher, return contract, command services, and seams. So this feature (specifically ·1) gates all remaining A2b work; it is already satisfied because both subtasks are built.
- **Internal order:** ·1 before ·4 (·4 consumes the foundations). Both are already implemented — the remaining action is **code review**, not build.
- **Guards:** byte-compatibility with the shipped extension (~4,000 installs) — per-provider tests must pass unchanged; the real acceptance signal is arms executing under a test seam bundle with **no `vscode` import reachable**, not merely "compiles".
- **Unblocks:** the Kanban browser board (Standalone Headless B2, kanban slice) and, via ·1, all remaining provider burndowns.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Verb Engine · 1 — Foundations: Command Services, Return Contract, Generic Dispatch](../plans/a2b-verb-engine-01-foundations.md) — **LEAD CODED**
- [ ] [Verb Engine · 4 — KanbanProvider Burndown (144 arms)](../plans/a2b-verb-engine-04-kanban-provider.md) — **LEAD CODED**
<!-- END SUBTASKS -->

