# The Teams Tab And Four Shipped Team Types

## Goal

Give teams their own tab, and ship four ready-made team types so the tab answers "what is this for" before any configuration exists.

### The problem

Reported from UAT, two complaints about one surface:

*"the UI for the feature agent grouping, delegates and phone-a-friend is extremely clunky. It really needs its own tab next to the Agents tab."*

*"I have no idea what the hell the delegates feature is in the Agents tab, and the UI does not make it any clearer."*

Both are true. The Agents tab stacks four `db-subsection` blocks: Agent Visibility & CLI Commands (`kanban.html:3005`), Custom Agents (`:3062`), Delegation & Phone-a-Friend (`:3085`, id `delegation-subsection`) and Agent Groups (`:3098`, id `agent-groups-subsection`). Two configure what an agent *is*; two configure how agents *combine*. They share a scroll and nothing else.

> **Superseded:** *"The Agents tab currently stacks five unrelated `db-subsection` blocks: Agent Visibility & CLI Commands (`:3005`), Custom Agents (`:3062`), Delegation & Phone-a-Friend (`:3085`), Agent Groups (`:3098`) and Role Selector (`:3142`). Three configure what an agent *is*; two configure how agents *combine*."*
> **Reason:** Role Selector is not in the AGENTS tab. `#agents-tab-content` closes at `kanban.html:3133`; `<!-- Prompts Tab Content -->` opens at `:3136` and Role Selector at `:3142` is the **PROMPTS** tab's first subsection. The AGENTS tab has four subsections, not five, and the split is two-and-two rather than three-and-two.
> **Replaced with:** Four subsections, two of which move. After the move the AGENTS tab holds **two** — Agent Visibility & CLI Commands, and Custom Agents. That is the correct "what an agent is" tab, and it is a cleaner outcome than the original framing implied. The "what does not move" list below is corrected accordingly.

### Root cause: the surface names a mechanism, not a purpose

"Delegation" is unexplained because the section configures only *how many children a role spawns*. The thing the word promises — agents working together, handing each other work — has never been visible anywhere. A reader cannot infer a purpose from a spinner labelled with an implementation noun.

Worse, the tab demands assembly. Switchboard makes you build a working arrangement out of roles, CLI commands, addons and groups, with no indication of which combinations are useful. Nothing on screen says *"here is a way of working."*

### The decision

Teams get a tab, and the tab leads with **team types** — complete working arrangements you adopt, not parts you assemble. Four ship. Adopting one is the whole of getting started.

## Metadata

**Complexity:** 7
**Tags:** frontend, ui, ux, refactor

## User Review Required

None.

## Complexity Audit

### Routine

- Adding a tab button and a content div follows the existing `shared-tab-btn` / `shared-tab-content` pattern exactly (`kanban.html:2750-2758`); switching is CSS-class based, so both panes live in one document.
- The gallery renders from a static constant, so it needs no persistence, no verb and no migration.
- Reusing `.db-subsection`, `.subsection-header`, `.agents-tab-inline-form` and `.strip-btn` means no new style vocabulary.
- The existing `getAgentGroups` / `saveAgentGroup` / `deleteAgentGroup` verbs already cover read, write and delete for adopted teams, so **no new verb is required** — see the note under Design.

### Complex / Risky

- **Moving a section out of `#agents-tab-content` silently unhooks it.** Both the config collector and the autosave bindings are scoped to that container id. See Design.
- The Agent Groups section's own on-screen copy documents the instantiate button that a sibling subtask deletes; leaving it makes the new tab describe a control that no longer exists.
- `phoneAFriendTargets` is shipped role-config state with meaningful `inherit` / `none` / explicit semantics; it has diverged before when two editors wrote it.
- The tab must work in both hosts. `kanban.html` is rendered by the shared panel module, so the markup is free — but any new verb would need a router in both hosts, allowlist and catalog rows, and a `verbSchemas.ts` block (PRD contracts #5 and #7). Avoiding new verbs is what keeps this a 7.

## Edge-Case & Dependency Audit

### Race Conditions

- Two panels open on one workspace both editing teams: `KanbanProvider._mutateAgentGroups` (`:4373-4392`) already serialises the read-modify-write for exactly this case. Reuse it; do not write the key directly.
- The live-instance disclosure reads fleet state that changes under it. Render it from the same fleet push the rest of the board uses rather than a private poll.

### Security

- No new wire surface if the existing verbs are reused. If a new verb is added, it needs a permissive, field-accurate schema at the HTTP boundary (PRD contract #5) — a schema that rejects a valid webview payload is a regression on shipped installs.

### Side Effects

- Two subsections disappear from a tab operators know. Anyone who has bookmarked the Agents tab for delegate counts will not find them.
- Adopting a type writes a new team, which — once auto-start ships — changes what starting that head role does. `USE` is therefore a behaviour-changing action, not a bookmark.

### Dependencies & Conflicts

- **Depends on** *Team Members Gain A Scope And A Relationship*: the tab renders `scope` and `relationship` per member and its editor writes them. Building it first means building an editor for fields that do not exist yet, then revisiting it.
- **Depends on** *A Team Starts With Its Head Role*: the gallery's head-role uniqueness rule and its disabled-card state only mean something once head role is a trigger. That subtask also deletes the INSTANTIATE button this tab would otherwise inherit.
- **Shares `kanban.html`** with *A Team Starts With Its Head Role*. Different regions of the file, but under the project's one-stream-per-file rule they serialise.
- **Precedes** *Seed A Starter Team, And Migrate*: the seeded starter is rendered by this tab.
- The `Custom team` card and the editor replace the Agent Groups inline form (`kanban.html:3108-3131`), including its hardcoded eight-role head-role `<select>` (`:3112-3122`).

### Scope check

Three deliverables live here — the tab shell plus gallery, the adopted-teams list plus editor, and the move of two subsections out of AGENTS. They are **not independently shippable** and are deliberately kept in one plan: a tab with a gallery but no editor is a dead-click surface (PRD contract #6 forbids it), and moving Delegation & Phone-a-Friend before the tab exists would mean two live editors over one config — the precise condition that made `phoneAFriendTargets` diverge before. One plan, one merge.

## Dependencies

- `sess_20260812190004 — head-role auto-start` (must land first)
- `sess_20260812190005 — member scope and relationship` (must land first)
- `sess_20260812190006 — TEAMS tab and shipped team types`

## Adversarial Synthesis

Key risks: moving two subsections out of `#agents-tab-content` and silently detaching them from the config collector and the load-time autosave bindings that are scoped to that container, producing controls that render and accept edits that never persist; leaving `phoneAFriendTargets` writable from two places; and shipping on-screen copy that still describes the deleted INSTANTIATE button. Mitigations: re-scope both the collector queries and the autosave wiring in the same change and verify by editing a moved control and reloading — not by looking at it; move the sections rather than copying them; and rewrite the Agent Groups blurb with the move. Reusing the existing three agent-group verbs is what keeps this change inside one webview file and off the parity/ratchet gates.

## Design

### A new TEAMS tab

Added to the shared tab strip (`kanban.html:2750-2758`), between AGENTS and PROMPTS. Named TEAMS, not SUBAGENTS: "subagents" names the plumbing, "teams" names the way of working.

### The gallery — four shipped types

| type | heads on | members | for |
| :-- | :-- | :-- | :-- |
| Feature team | `lead` | 3 × coder, shared reviewer | works a feature's subtasks one at a time |
| Planning team | `planner` | shared researcher | turns tickets and ideas into plans |
| Solo coder | `coder` | phone-a-friend | no lead — a cheap second pair of eyes at batch end |
| Review team | `reviewer` | tester | verifies finished work before it ships |

Plus a **Custom team** card: any head role, any members.

Each card shows its **head role first**, because that is both the trigger and the uniqueness key. A card carries its composition, one sentence of purpose, and either `USE` (not adopted) or a live count plus `edit`.

**One type per head role.** Auto-start needs a single answer to "what starts when a lead starts", so a card whose head role is already claimed renders disabled with the claiming team named. This is also the sizing rule that stops the gallery sprawling: adding a fifth type means finding a fifth role worth heading a team.

### `USE` forks; it never binds

`USE` copies the shipped definition into the workspace's own teams and opens it for editing. The shipped definition is never mutated, so the gallery means the same thing on every install and an upgrade can add or revise types without disturbing anything adopted.

### Reuse the existing verbs — add none

Adopted teams are rows in `terminals.agentGroups`, which already has three allowlisted verbs: `getAgentGroups`, `saveAgentGroup`, `deleteAgentGroup` (`KanbanProvider.ts:11479-11520`), all routed through the serialised `_mutateAgentGroups`. The tab reads, writes and deletes through those. That keeps the change inside `kanban.html` plus its provider arms, and off `verbAllowlist.ts`, `protocol-catalog.json`, `verbSchemas.ts` and the return-contract ratchet entirely. If a new verb turns out to be unavoidable, PRD contract #7 applies in full: provider arm returning in-body, schema at the boundary, router wired in **both** hosts, and the ratchet ceiling for the provider adjusted in the same change.

### Below the gallery — the teams you have

One card per adopted team: name, head role, members with their scope and relationship, a collapsible live-instance list, and `edit` / `remove`. A capacity footnote reports fleet usage against `MAX_LIVE_DELEGATE_PTYS` with the per-head cap named, in grey, below the list — auto-start makes the ceiling reachable without ever opening this tab, so the number is shown, but it is a constraint you check rather than the subject of the screen.

Runtime state is a **disclosure, not a status readout**. An earlier iteration led each row with a live pill and timestamps; the section then read as a monitoring dashboard, and dashboards are read-only, so the authoring controls stopped registering as controls. Live state sits under the definition as one collapsible line.

### The editor — three fields plus two per member

Name, head role (claimed roles disabled and annotated), and one row per member: role, count, scope, relationship. One row per role — the role dropdown excludes roles already used — which makes member names structurally unambiguous and removes any reason for a per-member label.

The relationship dropdown lists the presets that have a template. `custom` is a UI sentinel with an empty body and must not be selectable for a member — selecting it would install an empty standing order that looks configured and does nothing.

**No per-member `label` or `command`.** Both duplicated role configuration. Names are already built as `<head>-<role><n>`; commands belong to roles, and `intern` already exists as a cheaper built-in with custom agents covering the rest. The rule the tab holds to: **it composes roles, it never configures them.** Note that `label` and `startupCommand` remain on the stored `DelegateDefinition` shape (`agentConfig.ts:3-8`) and are preserved on write — they simply have no editor. Dropping them on save would destroy configuration the migration plan explicitly preserves.

A static line states what is not a choice: *"Every member reports to the head. Closing the head closes its own members; shared members stay."*

### What moves, and what does not

Move out of AGENTS: **Delegation & Phone-a-Friend** (`:3085`) and **Agent Groups** (`:3098`).
Stay in AGENTS: **Agent Visibility & CLI Commands** (`:3005`) and **Custom Agents** (`:3062`) — they configure agents generally. (Role Selector is in the PROMPTS tab and is not involved; see the superseded callout above.)

Moved, not duplicated. Two live editors over one config is how `phoneAFriendTargets` diverged before.

### Moving a section out of `#agents-tab-content` unhooks it — re-scope both bindings

This is the concrete hazard of the move, and it is invisible on inspection because the controls still render.

Two mechanisms in `kanban.html` are scoped to the AGENTS container by id:

| site | what it does | what breaks on a move |
| :-- | :-- | :-- |
| `agentsTabCollectConfig` (`:4507-4521`) | `document.querySelectorAll('#agents-tab-content input[type="text"][data-role]')` and the same for `.agents-tab-visible-toggle` | a moved input is outside the selector, so its value stops being collected into the `saveStartupCommands` payload |
| autosave wiring (`:4527-4534`) | binds `change` / `blur` at script load over `#agents-tab-content input[type="checkbox"]` and `input[type="text"][data-role]` | a moved control has **no listener at all** — it accepts edits that are never saved |

Both are one-time, load-time, container-scoped queries. Re-scope both to cover the new container (or bind per-section rather than per-tab) **in the same change**, and verify by editing a moved control and reloading the panel. "The control renders in the new tab" proves nothing about either binding.

### Rewrite the copy that describes the deleted button

The Agent Groups section's blurb (`kanban.html:3100-3105`) reads *"…instantiate it wired. Instantiating creates the terminals, parents workers to the lead, and installs the standing orders that make them report back… Editing a definition affects the next instantiation only, not already-running terminals."* Every sentence describes the INSTANTIATE button that *A Team Starts With Its Head Role* deletes. Rewrite it for auto-start when the section moves, or the flagship new tab ships documenting a control that no longer exists.

## Implementation Notes

- `kanban.html` is a self-contained webview: handlers go in its own inline script, alongside the existing `agentsTab*` functions. Reuse `.db-subsection`, `.subsection-header`, `.agents-tab-inline-form` and `.strip-btn` rather than inventing a parallel style vocabulary; the gallery card is the one genuinely new component.
- Shipped types are static definitions in source, not seeded rows — seeding is the migration plan's job and concerns only the *adopted* list. The gallery renders from the constant on every install, including ones that have adopted nothing.
- `phoneAFriendTargets` per-terminal overrides move with the Delegation section. They are shipped state with meaningful `inherit` / `none` / explicit semantics (`agentConfig.ts:290-304`; editors at `kanban.html:4238-4322`); carry them across intact and consider hiding them behind a disclosure so a rarely-used exception list does not outweigh the rule it modifies.
- The Solo coder type supplies the phone-a-friend *terminal*; the batch-end trigger that fires it stays exactly where it is in role config. Composition and dispatch are separate layers and this tab owns only the first.
- No confirm dialogs. `remove` removes on the click. Per `CLAUDE.md`, and because `window.confirm()` is a silent no-op in a VS Code webview.
- Move the `agentsTabRenderAgentGroups` / `agentsTabShowGroupForm` handlers with their markup rather than leaving them under an `agentsTab*` name in the AGENTS region — a function whose name says AGENTS and whose DOM lives in TEAMS is the next reader's trap.

## Proposed Changes

### `src/webview/kanban.html` — tab strip and containers

- **Context.** `:2750-2758` is the tab strip; content divs follow, switched by the `active` class.
- **Implementation.** Add a `TEAMS` button between AGENTS and PROMPTS and a `#teams-tab-content` div. Move the `#delegation-subsection` and `#agent-groups-subsection` blocks into it.
- **Edge Cases.** Both panes exist in one document; the move changes container ancestry, which is exactly what breaks the scoped bindings below.

### `src/webview/kanban.html` — bindings

- **Context.** `agentsTabCollectConfig` (`:4507`), autosave wiring (`:4527-4534`).
- **Implementation.** Re-scope every `#agents-tab-content`-anchored query so moved controls are still collected and still bound.
- **Edge Cases.** Verify by round-trip (edit → reload), not by render.

### `src/webview/kanban.html` — gallery, adopted list, editor

- **Context.** New markup plus inline handlers; the existing inline form at `:3108-3131` is superseded.
- **Implementation.** Gallery from a static constant; adopted list from `getAgentGroups`; editor writes through `saveAgentGroup`; `remove` calls `deleteAgentGroup` immediately.
- **Edge Cases.** Preserve `label` / `startupCommand` on save. Exclude `custom` from the relationship dropdown. Disable claimed head roles in both the gallery and the editor's dropdown.

### `src/webview/kanban.html` — copy

- **Context.** `:3100-3105`.
- **Implementation.** Rewrite for auto-start; remove every reference to instantiating.

## Verification Plan

1. **The tab exists** between AGENTS and PROMPTS, and its content is reachable in both the extension panel and the browser cockpit.
2. **The gallery explains itself.** On an install with nothing adopted, the tab shows four types with head roles, compositions and purposes — no empty state, no "create your first team".
3. **`USE` forks.** Adopt Feature team, edit the copy, confirm the gallery card still describes the shipped definition unchanged.
4. **Head-role uniqueness is visible.** With Feature team adopted, a card heading on `lead` renders disabled naming the claimer. Confirm the editor's head-role dropdown matches.
5. **Sections moved, not copied.** Delegation & Phone-a-Friend and Agent Groups no longer appear in AGENTS; Agent Visibility & CLI Commands and Custom Agents remain, and those two are the only subsections left there. No control edits the same config from two tabs.
6. **Moved controls still save — the round-trip check.** Change a delegate count and toggle a checkbox in the moved Delegation section, then reload the panel. Both values persist. Then change an agent CLI command in AGENTS and reload; it persists too — confirming the re-scoped collector did not lose the controls that stayed.
7. **`phoneAFriendTargets` survive.** A pre-existing per-terminal override still applies after the move, including an explicit `none`.
8. **Editor constraints.** One row per role; label and command absent from the UI but preserved on disk after an edit-and-save; claimed head roles disabled; `custom` not offered as a relationship.
9. **Live state.** With two teams running, each shows its instances on expand and the capacity footnote reports fleet usage against 32 with the per-head cap named.
10. **No confirm gate.** `remove` acts on one click. Grep the diff for `confirm(` and reject any hit.
11. **No stale copy.** Grep the TEAMS tab markup for "instantiate"; zero hits.
12. **Solo coder end to end.** Adopt it, start a coder, confirm the phone-a-friend terminal starts with it and the batch-end trigger still fires as before.

### Automated Tests

Per the session directive, no compilation or automated-test run is part of this pass's verification; the checks above are manual. At implementation time the relevant existing suites are the kanban webview tests and anything naming `agents-tab` or `agentGroups` — a container-scoped selector change is exactly the class of edit those tests exist to catch.

## Recommendation

Complexity 7 → **Send to Lead Coder**.

## Completion Summary

Added a TEAMS tab between AGENTS and PROMPTS in the shared tab strip, with a `#teams-tab-content` container holding three sections: a Team Types gallery, a Your Teams list with editor, and the moved Delegation & Phone-a-Friend subsection. The gallery renders four shipped team types (Feature team, Planning team, Solo coder, Review team) plus a Custom team card from a static `SHIPPED_TEAM_TYPES` constant — each card shows head role first, member composition with scope annotations, one sentence of purpose, and either `USE` (not adopted) or a disabled note naming the claiming team when the head role is already taken. `USE` forks the shipped definition into the workspace's own teams and opens it for editing; the shipped definition is never mutated. The member editor row now writes `scope` (per-team/shared dropdown) and `relationship` (dropdown of `MEMBER_RELATIONSHIP_PRESETS` — the six LINK_PRESETS ids excluding `custom`), while preserving `label` and `startupCommand` from existing definitions on save. The Agent Groups blurb was rewritten to describe auto-start instead of the deleted instantiate button, and the form title/buttons now say "Team" instead of "Agent Group". The `agentsTabCollectConfig` and autosave bindings were re-scoped to query both `#agents-tab-content` and `#teams-tab-content` so moved controls are still collected and still bound. Tab hydration was split: AGENTS loads only startup commands and custom agents; TEAMS loads agent groups, role configs, delegation panel, and renders the gallery. All agent-group functions were renamed from `agentsTab*` to `teamsTab*` to match their DOM home. `npm run parity:check` passes green and the link-presets mirror contract test passes.

## Review Findings

MAJOR, fixed: `getAgentGroups`, `saveAgentGroup` and `deleteAgentGroup` were absent from the generated `KANBAN_VERBS`, and that Set gates `KanbanProvider.handleServiceVerb` (`:7759`) — so every TEAMS-tab read and write threw `Unknown Kanban verb` over HTTP and the tab was dead in the browser cockpit, failing verification step 1 and PRD contract #6; `npm run catalog:generate` restored them (`parity:check` had been green only because allowlist and catalog were stale together). The rest holds: both subsections moved rather than copied, `agentsTabCollectConfig` and both load-time autosave bindings are re-scoped across `#agents-tab-content` and `#teams-tab-content`, tab hydration is split, `label`/`startupCommand` are preserved on save, `custom` is absent from the relationship dropdown, `remove` acts on one click with no `confirm(` anywhere in the tab, and the moved blurb no longer mentions instantiating. Validation: `node --check` on the webview clean, typecheck clean, all nine static gates exit 0; files changed by this review are `protocol-catalog.json` and `src/generated/verbAllowlist.ts`. Two NITs left as-is: a new team defaulting to an already-claimed `lead` head role still saves a collision (the converter then marks it unassigned, non-destructively), and `DELEGATE_PARENT_NOTICE`'s `agentInstanceId` parameter is now unused. Remaining risk: the member role field is free text, so a typo yields a terminal with no CLI — the shipped types' `researcher` and `tester` are both real roles and were verified against the role select.
