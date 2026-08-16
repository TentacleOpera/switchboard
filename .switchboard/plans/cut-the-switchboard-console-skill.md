# Cut the `/switchboard` Console Skill Down to the Console

## Goal

`/switchboard` is 631 lines. Half of it exists to run two commands and print a five-item menu. Cut it to the console it claims to be: read the board export the extension already writes, present the menu, wait.

### Why

| Section | Lines | For |
| :--- | ---: | :--- |
| 1. Entry Protocol | **132** | run two commands, report, stop |
| 2. Menu | **180** | print five lines, wait |
| 6. Column Oversight | **114** | an automation engine's protocol |
| 7. Project Pipeline | 29 | a wrapper over §6 |
| 3, 4, 5, 8 | 150 | features, IDs, setup, hard rules |

**The entry protocol rebuilds something that already exists.** `KanbanDatabase` auto-exports `.switchboard/kanban-board.md` (whole board) and `kanban-state-<slug>.md` (per column) on every board change. The skill ignores the first, runs a bespoke `awk` pipeline over the second, and then spends ~15 bullets re-deriving what the exporter already knew: column display labels, assigned agent names, column ordering, slug-vs-ID mapping, which rows are features. Every one of those rules exists because the reconstruction lost information the export had.

**It accumulated a rule per defect and never consolidated.** Each rule is individually justified — someone hit that bug. Collectively they are unreadable, and an unreadable skill gets partially followed, which produces the next defect and the next rule. §2 contains its own changelog: *"The skill was tuned hard for terseness, but that discipline only ever covered the entry snapshot… This principle closes that gap."* Then restates the same point a paragraph later.

**Two automation engines are documented inside the console's front door.** §6 and §7 are 143 lines of pass protocol — queue semantics, lane rules, halt/stop/resume, state-file ownership — in a skill whose job is to report state and wait.

## What is cut

**1. The entry protocol reads `kanban-board.md`.** One `curl /health` for liveness and live terminals, one read of the export. Delete the `awk` pipeline and the snapshot-reconstruction rules with it: labels, agent names, ordering, slugs, feature-row detection are the exporter's job and it already does them. If the export is missing a field the entry report needs, add it to the exporter — do not re-derive it in prose.

**2. §6 and §7 move out** to their own skill. The console keeps one line per menu item pointing at it.

**3. The self-narration goes.** No changelogs, no "this resolves the X defect", no explaining a rule's history to the agent reading it. State the rule. `Proactive, not eager` survives as the two bullets it actually is.

**4. The verb-rail traps and read/write contract go.** This skill already says the `switchboard-orchestration` skill owns the HTTP contract, then duplicates a chunk of it — payload field names, canonical column IDs, which verbs return data on the WS hub. Keep the pointer, delete the copy.

## What survives untouched

Entry-then-stop. The five-item menu. The `workspaceRoot` requirement on every call. Never asking for a UUID. The Hard Rules. Deletes execute immediately.

**Rules move; they do not evaporate.** Every rule here was paid for by a defect. A rule that belongs to the exporter moves into the exporter; one that belongs to the HTTP contract moves to `switchboard-orchestration`; one that belongs to the oversight engine moves with it. Only the self-narration is deleted outright, because it was never a rule.

## Open question, not settled here

Whether the attended oversight pass should survive at all is a decision for the automation-mode work, not this plan. This plan moves it out of the console either way.

## Metadata

**Complexity:** 4
**Tags:** docs, refactor, ux

## Verification Plan

1. The entry report for a real board is materially identical to today's — same columns, same labels, same agent names, same counts.
2. Entry costs one `curl` and one file read. No `awk` pipeline remains in the skill.
3. Rename a column on the board: the entry report follows, with no skill edit.
4. `/switchboard` no longer contains queue semantics, lane rules, or pass state-file ownership.
5. No sentence in the skill describes the skill's own history or a defect it once had.
6. Nothing in it duplicates the `switchboard-orchestration` HTTP contract.
7. The entry protocol is under 30 lines and the whole skill is under 300.
