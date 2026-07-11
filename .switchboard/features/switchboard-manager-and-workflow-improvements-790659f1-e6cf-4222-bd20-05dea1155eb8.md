# Switchboard Manager and workflow improvements

**Complexity:** 8

## Goal

Make the Switchboard management console the product's real front door — reachable through a clean, host-identical command surface and pleasant to talk to once you're in. Today internal workflows leak into the user's slash menu (differently on Antigravity vs Claude Code), and the console itself leaks plumbing (UUIDs, raw filenames, ISO timestamps) and goes silent instead of offering the obvious next step. These two plans are grouped because they are one delivery: the entry-point refactor decides *where* the console persona lives and how users reach it, and the voice/proactivity pass decides *what that persona says* — the refactor physically absorbs the console body the voice pass edits.

## How the Subtasks Achieve This

- **Refactor Switchboard Entry Points to Four `switchboard-`Tagged Front Doors (Skillify Internal Workflows, No Host Drift)**: Reduces `.agents/workflows/` to exactly four self-named doors (`/switchboard`, `/switchboard-cloud`, `/switchboard-remote`, `/switchboard-memo`), folds the 524-line manage-console skill into the `/switchboard` door body, moves internal extension-dispatched workflows (improve-plan, improve-feature, accuracy, orchestrator) into stripped `.agents/skills/` invisible to both hosts' menus, rewrites the Claude Code mirror manifest to the same four doors, cleans stale workflow files off existing installs, and migrates the persisted `plannerWorkflowPath` config. This delivers the "one obvious command, identical on every host" entry experience.
- **Make the Switchboard Manage Console Speak Human and Offer the Next Step**: Rewrites the manage-console persona prose so it never leaks UUIDs/plan filenames/raw ISO timestamps, replaces the collapsed "terminal N" board header with named pre-CODE-REVIEWED columns, adds a "proactive, not eager" principle (every turn ends with one offered next step), humanizes dispatch confirmations from fields the API already returns, and adds a lightweight session-scoped single-dispatch completion watch. This makes the console the four-front-doors refactor promotes actually feel like a product.

## Dependencies & sequencing

- **Cross-feature:** none open — the only external dependency, the frontmatter-strip mechanism (`fix-skill-discovery-frontmatter-spam.md`), is already landed. The refactor supersedes the abandoned router-model plan `consolidate-switchboard-front-doors.md`.
- **Shipping order (binding):** the **console voice plan lands first**, the **four-front-doors refactor second**. The voice plan edits `.agents/skills/switchboard-manage/SKILL.md`; the refactor deletes that file after absorbing its body verbatim into `.agents/workflows/switchboard.md`. Reversing the order deletes the voice plan's target and invalidates every line reference in it. Both plans now carry this constraint in their Dependencies sections (with a 1:1 contingency mapping in the voice plan if the order is ever violated).
- **Guards:** the refactor must land atomically with its config migration and stale-file cleanup (§F/§G of its plan) — a partial land leaves planner/orchestrator dispatch pointing at moved files on ~4,000 installs.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Refactor Switchboard Entry Points to Four `switchboard-`Tagged Front Doors (Skillify Internal Workflows, No Host Drift)](../plans/refactor-switchboard-four-front-doors.md) — **LEAD CODED**
- [ ] [Make the Switchboard Manage Console Speak Human and Offer the Next Step](../plans/switchboard-manage-console-voice-and-proactivity.md) — **LEAD CODED**
<!-- END SUBTASKS -->

