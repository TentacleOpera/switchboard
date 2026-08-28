# Standing Orders Composed From a Library, Delivered to Running Teams

**Complexity:** 7

## Goal

Standing orders must stop being prose stored in the database and become references composed at delivery. Today each team gets a fixed monolithic body copied into config when it is wired, so a correction to the wording in code never reaches a team that already exists — and the library the operator can see holds text snapshots, not links to the code that owns them. Give the composition mechanism a code-owned fragment registry resolved at render time, and give that library an operator-reachable surface.

### The failure this feature exists to prevent — measured 2026-08-28

A `Coding` team lead was delivered a standing order telling it to `POST /kanban/dispatch` a feature to `CODE REVIEWED` — an instruction removed from the codebase three days earlier. It obeyed, and advanced a card its own prompt forbade it to move.

The lead's group row was created 2026-08-17, snapshotting `NEW_CODING_HEAD_PROMPT` as it stood that day. The constant was rewritten three times after (08-19, 08-21, 08-25). Nothing re-reads it for an existing group: `migrateAgentGroups` never touches `headPrompt`. The 08-21 work added `PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT` to heal exactly this; `209cd7fc` (08-25) rewrote the prompt again and deleted the whole `PRE_*` family, and `team-scoped-role-routing.test.js:961-969` now pins that deletion shut — *"prompt text is never rewritten — deleting the snapshots was the point."*

The build running at the time was current and contained the fix. Every gate was green. Only the stored data was wrong. That is the whole feature: **snapshot-and-recognise was abandoned deliberately and nothing replaced it**, so persisted orders are now frozen with no path forward.

## How the Subtasks Achieve This

- **Compose standing orders from a library instead of installing monoliths** — the mechanism. A code-owned fragment registry with applicability predicates, resolved by `renderOrder` at delivery against the context `selectOrders` has already computed. `StandingOrder` gains `fragments?: string[]`; installers write ids, never prose; group templates stop carrying `headPrompt` text. This is what makes a wording change reach a team that is already running, with no migration and no re-spawn.
- **Standing Orders Library section in the tab** — the surface. Create, edit and delete definitions with a usage count, so the library is operable rather than source-only. It also renders the `fragmentId` link the mechanism adds, and the fork-on-edit behaviour that keeps an operator's customisation safe from the next release.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Compose standing orders from a library instead of installing monoliths](../plans/compose-standing-orders-from-a-library.md) — **PLAN REVIEWED** — ID: bf4bb2af-bc64-4329-9be9-1fc975c440d0
- [ ] [Standing Orders Library Section in the Tab](../plans/standing-orders-library-section-in-the-tab.md) — **PLAN REVIEWED** — ID: cb9b253a-3348-464b-8c76-0061917c7ada
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Compose first, then the tab section.** They are technically independent — the tab section builds on the already-shipped `StandingOrderDefinition` model and could land alone — but the mechanism adds an optional `fragmentId` to that model, and the tab renders it. Landing the tab first means shipping a library view that cannot show whether an entry tracks the code or has been forked, which is the distinction the operator most needs to see.

Neither subtask is blocked. `POST /kanban/task/complete`, previously recorded as a blocking dependency, exists and is live (`LocalApiServer.ts:1776`, `:1930`).

The existing **Standing Orders Library and Tab** feature is entirely CODE REVIEWED, so this is follow-on work rather than a duplicate home.

### Two subtasks were deleted from this feature, deliberately

*Review-Team Head Standing Orders Must Migrate On Read* and *Review-Team Head Orders: Supersede The First-Generation Text* were removed on 2026-08-28. Both proposed adding read-path recognisers and reintroducing frozen prompt snapshots for the Review team. Three reasons they went rather than being marked superseded:

1. **Their premise is false at HEAD.** Both assert that Coding migrates and only Review is stranded, citing `OLD_HEADPROMPT_FRAGMENT`, `BUGGY_HEADPROMPT_FRAGMENT`, `PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT` and `PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT`. All four are gone from the repo. Neither team migrates.
2. **Their mechanism is pinned against.** `OLD_REVIEW_TEAM_HEAD_PROMPT`, which the supersession plan proposes reintroducing, survives in exactly one place: the assertion keeping it deleted.
3. **A PLAN REVIEWED card is dispatchable.** Left on the board, either one would send a coder to reintroduce deleted constants and delete a contract assertion encoding a deliberate decision — with every gate green while it happened.

Their surviving requirement is absorbed into subtask 1's Migration section: an old-generation system row must convert, not be mistaken for an operator literal. That is why the migration discriminates on **scope**, not on text.

## Team Dispatch Instructions

### Shipping order

1. **Compose standing orders from a library** — the mechanism. Ready to code.
2. **Standing Orders Library section in the tab** — the surface. Ready to code; prefer after 1 so it can render `fragmentId`.

### Per-subtask dispatch

#### Compose standing orders from a library instead of installing monoliths
- **Seat:** Coder (complexity 7)
- **Acceptance criteria:** Changing a fragment body constant changes what an already-wired team is told, on its next message, with no migration, no re-spawn and no config write — this is the core assertion and it fails at HEAD. Every emitted set is the composition of fragments applicable to that team's actual shape, resolved at delivery. No emitted set contains contradictory card-movement instructions. A team with no reviewer seat is never told to move a card to `CODE REVIEWED`. A team with no orchestrator is never told to post an orchestrator report. Every seat retains exactly one completion obligation under every combination. After wiring a team, no standing-order row and no definition contains any registry fragment's body text, and the group row carries no `headPrompt`. A `team`/`team-head` row holding first-generation text converts to fragment ids; `global`/`pair`/`role` rows are byte-identical before and after. An operator-authored order is never altered by a code change.
- **Scope constraints:** Compose at **delivery**, never at install — writing composed prose into config reproduces the freeze in a new shape. Add no frozen prompt snapshots and no text-matching recognisers; the migration discriminates on scope. Do not reintroduce `OLD_REVIEW_TEAM_HEAD_PROMPT` or any `PRE_*` head-prompt constant — `team-scoped-role-routing.test.js:961-969` pins them deleted and that decision stands. Composition stays server-side; the client renders what it is given and must never resolve a fragment id (`terminals.js:10353`). The registry and composer live in shared services with no `vscode` import — three composition roots reach the installers. Do not re-derive team membership; consume `selectOrders`' resolution. Mark `context-aware-completion-reporting.md` superseded. Treat the team installers as unreleased state — clean break, no compat shim; confirm `GLOBAL_QUEUE_DONE_ORDER_BODY`'s release status separately before touching it.
- **Open decision for the coder to resolve before coding:** whether `missionControlArmed` is trustworthy orchestrator liveness (legacy `orchestratorArmed` renamed; `orchestratorActive` does not exist). If it is not, drop that axis from v1 rather than composing on a guess.

#### Standing Orders Library Section in the Tab
- **Seat:** Coder (complexity 5)
- **Acceptance criteria:** Library section renders above assignments with create/edit/delete and usage counts. `getStandingOrders` verb returns `definitions` alongside `orders` in one round-trip. `addStandingOrder` threads `definitionId` through to `makeStandingOrder`. Three new verbs (`addStandingOrderDefinition`, `updateStandingOrderDefinition`, `deleteStandingOrderDefinition`) resolve through `_resolveStandingOrdersRoot` and appear in the fleet-root contract test's verb list. Assign-from-library dropdown on the add form. Linked-assignment detach notice shown. Role-not-found badge renders. `mutateStandingOrderDefinitions` skips write when mutator returns input by reference. No `onclick=` anywhere (CSP). No `type` field on verb returns.
- **Scope constraints:** Do not add a separate `getStandingOrderDefinitions` verb (usage count would race). Do not call `syncDefinitionToAssignments` from inside a `mutateStandingOrderDefinitions` callback (deadlocks the shared write chain). Run `npm run catalog:generate` after adding verb cases. No confirm gates (CLAUDE.md).

### Reconciliation notes

- **The two subtasks converge; they are no longer separate concepts.** An earlier revision of this feature recorded the fragment registry and `StandingOrderDefinition` as distinct systems and left the question to the user. That has been decided: `StandingOrderDefinition` gains an optional `fragmentId`. A definition carrying one is a library view of a registry fragment and renders from code; an operator editing it **forks** it — `fragmentId` is dropped and the text becomes a literal, never touched again. Leaving them separate would ship two libraries with the same name and different semantics, and would leave the shipped one storing prose, which is the failure this feature exists to fix.
- **The delivery gap named in the Goal is closed by resolution, not by rewriting.** There is no recomposition-trigger list, because there is nothing to recompose: roster changes, pacing flips and queue-mode changes take effect on the next delivery because the context is read then.
