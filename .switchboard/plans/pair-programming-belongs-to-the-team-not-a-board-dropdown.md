# Pair Programming Belongs to the Team, Not a Board Dropdown and a Buried Checkbox

## Goal

Pair programming becomes a property of a team, on by default for a team working independent plans. The board-wide mode select and the planner's `Aggressive Pair Programming` checkbox stop being the place it is configured.

### Problem analysis

**It is the cheapest quality-and-cost mechanism in the product and it is configured in two places, neither of which is a team.**

- `kanban.html:3029` — `#pairProgrammingModeSelect`, a **board-wide** dropdown whose first option is `Pair Programming: Off`.
- `kanban.html:3586` — `#plannerAddonAggressivePairProgramming`, a checkbox in the **planner's add-on list** in the Prompts tab, among approximately ten others.

> **Superseded:** `kanban.html:2995` and `kanban.html:3545` as the cited locations of the two surfaces.
> **Reason:** Line numbers drifted as the file grew; the elements are now at 3029 and 3586 respectively (verified by ID search this session).
> **Replaced with:** `kanban.html:3029` (`#pairProgrammingModeSelect`) and `kanban.html:3586` (`#plannerAddonAggressivePairProgramming`).

Neither is scoped to a team, and a team is exactly what the feature presupposes: a lead that takes the parts needing judgement and a cheaper seat that takes the rest. So today a team can exist with pair programming off, and pair programming can be on with no team to express it — the setting and the thing it describes are in different places.

**What it actually does.** `AGGRESSIVE_PAIR_PROGRAMMING_DIRECTIVE` is appended to the **planner's** prompt (`agentPromptBuilder.ts:2004`) and biases the routine/complex classification so more of a plan routes to the cheaper Coder and only the genuinely hard parts stay with the Lead Coder. The cost decision is therefore made at planning time, by the agent best placed to make it, against work already written down. `pairProgrammingEnabled` is read separately at `:2298` (lead) and `:2388` (coder).

> **Superseded:** The original analysis treated `pairProgrammingMode` and `aggressivePairProgramming` as two controls describing one thing (pair programming's "strength"), differing only in location.
> **Reason:** They are two distinct mechanisms governing different code paths. `pairProgrammingMode` (`autobanState.ts:61`) is a **5-value enum** — `off | cli-cli | cli-ide | ide-cli | ide-ide` — that (a) triggers the split dispatch of a separate coder prompt (`KanbanProvider._dispatchWithPairProgrammingIfNeeded`, `:7226`), (b) bypasses intern routing so pair-mode plans route to coder (`:1650`, `:9592`), and (c) suppresses the frontend's optimistic cross-stage move so the backend's complexity route is authoritative (`kanban.html:10706`). `aggressivePairProgramming` is a **boolean** that biases the planner's routine/complex classification only. The enum carries host-routing information (which terminal is lead vs coder, CLI vs IDE); the boolean carries classification intensity. Collapsing both into "one control with a strength" loses the host-routing dimension.
> **Replaced with:** Two scopes with a shared intensity vocabulary — see *Proposed Changes §1* and the *Adversarial Synthesis*.

**Why default-on for a team.** A team's whole shape is a lead plus cheaper seats. Seating one and then leaving the mechanism that uses it switched off, behind a dropdown labelled `Off`, means the default team does not do the thing a team is for. The operator who would benefit most is the one who never finds the checkbox.

**Measured once, on a superseded build.** An Opus-solo run against an Opus-lead-plus-Gemini pair showed roughly a 30% token reduction — on a version where the lead had to work out dispatch itself, which the system now handles. The figure is directional only: it is not reproducible today, and **nothing in the product measures tokens** (see *Cost and token accounting*, this plan's sibling). Do not publish it, and do not use it to justify the default; the argument for the default is structural.

## Metadata

- **Complexity:** 6
- **Tags:** ui, refactor

> **Superseded:** Complexity 4; Tags: teams, prompts, cost, config, both-hosts.
> **Reason:** Complexity 4 undercounts: the work coordinates team-model extension, the prompt builder, two UI surfaces, the skill exporter, both composition roots, AND must re-home three non-prompt behaviors of `pairProgrammingMode` (split dispatch, routing bypass, FE move suppression) — that is multi-file coordination with moderate, well-scoped risk extending existing patterns (mixed tier, 5-6). The tags were all outside the allowed list (`teams`, `prompts`, `cost`, `config`, `both-hosts` are not valid tags); the allowed set has no exact match for "config relocation," so the closest valid tags are `ui` (two surfaces change) and `refactor` (the setting is relocated, not newly built).
> **Replaced with:** Complexity 6; Tags: ui, refactor.

## User Review Required

The plan's *Proposed Changes §2* presents an unresolved Either/Or (retire the board dropdown entirely vs. keep it as the non-team scope). This is a behaviour-removal decision for existing users and must be confirmed before implementation. See *Outstanding Questions*.

## Complexity Audit

### Routine
- Adding a `pairProgramming` field (`off | on | aggressive`) to the team group object and persisting it alongside the existing roster/head/pacing fields.
- Rendering the field in the Teams tab UI (a dropdown or tri-state toggle on the team card).
- Retiring the `#plannerAddonAggressivePairProgramming` checkbox from the Prompts tab and its save/load wiring (`kanban.html:4135`, `:7456`; `KanbanProvider` planner-addon resolution at `:6719`).
- Updating the `AgentSkillExporter` skill-markdown descriptions for the two flags (currently inaccurate — see *Edge-Case & Dependency Audit §5*).

### Complex / Risky
- Re-homing the three non-prompt behaviors of `pairProgrammingMode` when the board dropdown is retired or scoped: the split dispatch (`_dispatchWithPairProgrammingIfNeeded`), the intern→coder routing bypass (`:1650`, `:9592`), and the frontend optimistic-move suppression (`kanban.html:10706`). Each reads the global enum today; a team-scoped value must override them per-dispatch.
- Introducing a **team-scoped option resolution layer** in `generateUnifiedPrompt` (`KanbanProvider.ts:6168`) — today pair-programming options are resolved exclusively from global `autobanState` (`:6425`) and global `promptsConfig` (`:6404`, `:6427`). A team field has no path into the prompt builder without a new override that keys off the dispatch context.
- Resolving the host-routing dimension: the board enum's `cli-cli`/`cli-ide`/`ide-cli`/`ide-ide` values select which terminal receives the lead vs coder prompt. A team's roster already defines its seats, so the team field should carry intensity only (`off | on | aggressive`) and derive host routing from the roster — but this must be made explicit, not assumed.
- Diffing the composition roots of both hosts (extension `KanbanProvider` vs standalone `bootstrap.ts`) so the field is read and written identically on each.

## Edge-Case & Dependency Audit

1. **Teams are unreleased; the two old surfaces are not.** The team field and its default are a clean break needing no migration. The exposure is entirely on the non-team dispatch path that the board dropdown governs today — see change 2. Do not conflate the two halves, and do not write a migration for the half that has no users.
2. **A team with no cheaper seat.** Head-only teams exist. With no coder to route to, the directive is noise in the planner's prompt — resolve to off and say why, rather than emitting a split instruction with nowhere to send the routine half.
3. **The planner may not be in the team.** The directive lands in the *planner's* prompt while the setting now lives on a *coding* team.

   > **Resolved (code investigation this session):** Team dispatch flows through `generateUnifiedPrompt` → `buildKanbanBatchPrompt`, and pair-programming options are resolved from **global** `autobanState`/`promptsConfig` only (`KanbanProvider.ts:6404`, `:6425-6427`). There is no team-scoped planner today — the planner that receives the directive is whichever planner is dispatched for the team's plans (globally configured), not a team member. A team-scoped `pairProgramming` field therefore has **no existing path** into the planner's prompt; introducing one is the implementation crux (see *Complex / Risky*). The team field must be threaded into the dispatch context that `generateUnifiedPrompt` reads, and the planner branch (`:6404`) must prefer the team-scoped value over the global `promptsConfig.aggressivePairProgramming` when a team is the source.

4. **Both hosts.** The field is read on the prompt-building path and written from a panel each host serves separately. The standalone host confirms `aggressivePairProgramming` feeds dispatched prompts via the same `TaskViewerProvider` (`bootstrap.ts:1443` comment); the extension host resolves it in `KanbanProvider._getPromptsConfig`. Diff the composition roots by hand so the team field is read and written on both.
5. **`AgentSkillExporter` emits both flags** (`:102`, `:235`, `:240`). An exported skill must carry the resolved value, not a stale reference to a retired add-on. Additionally, the current skill-markdown descriptions are **factually wrong**: `pairProgrammingEnabled` is rendered as *"Engage in pair programming mode: explain your reasoning step by step"* (`:237`) and `aggressivePairProgramming` as *"Be proactive and aggressive in suggesting changes and improvements"* (`:242`) — neither describes what the flags actually do (split dispatch and routine/complex classification bias). Correct the descriptions when re-wiring the resolved value.

## Dependencies

- None. This plan is self-contained; the sibling *Cost and token accounting* plan is referenced for context only (the 30% figure) and is not a dependency.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) re-homing three non-prompt behaviors of the board enum (split dispatch, routing bypass, FE move suppression) is under-counted by the original plan and is where regressions hide; (2) no team-scoped option path exists in `generateUnifiedPrompt` today, so the team field is unwired without new plumbing; (3) the Either/Or on retiring the board dropdown is a behaviour-removal for existing users that the plan leaves open. Mitigations: enumerate every read site of `pairProgrammingMode` before touching any; add the team-scoped override as the first implementation step and gate the rest on it; force a User Review decision on the Either/Or before the non-team path is changed.

## Proposed Changes

### 1. The team owns the setting

Pair programming becomes a field on the team group object, alongside its roster (`members[]`), head (`headRole`), and pacing. **Default on** for a newly created team. A team is a lead and cheaper seats; the default should use them.

The team field carries **intensity only**: `off | on | aggressive`. The host-routing dimension that the board enum's `cli-cli`/`cli-ide`/`ide-cli`/`ide-ide` values carry is **implicit in the team's roster** — the lead and coder seats are the team's own terminals, so which terminal is lead vs coder is already defined by the roster, not by a pair-programming mode. Aggressive mode is the non-default intensity on the same field (biases the planner's routine/complex classification), not a second switch in a second panel.

> **Superseded:** "Aggressive mode stays a separate, non-default intensity on the same field rather than a second switch elsewhere — one control with a strength, not two controls in two panels."
> **Reason:** That framing conflated `pairProgrammingMode` (a 5-value host-routing enum that drives split dispatch + routing bypass) with `aggressivePairProgramming` (a boolean classification bias). "One control with a strength" implies a single scalar; the board enum is not a scalar and carries routing information the team field does not need (the roster supplies it).
> **Replaced with:** The team field is intensity-only (`off | on | aggressive`); host routing is derived from the roster. The board enum remains a separate concern for the non-team path (see §2).

**Implementation surface:**
- Team group object (`agentsTabAgentGroups` in `kanban.html`; persisted via the terminal-groups settings accessor used by `teamWiring.ts` / `agentGroupInstantiation.ts`): add `pairProgramming: 'on' | 'off' | 'aggressive'`, default `'on'` on team creation (`teamsTabAdopt`, `kanban.html:5626`).
- Teams tab UI: render the field on the team card / flow diagram, with the one-line description from §4.
- `generateUnifiedPrompt` (`KanbanProvider.ts:6168`): add a team-scoped override so the planner branch (`:6404`) and the lead/coder branch (`:6425-6427`) prefer the team's resolved value over the global `autobanState`/`promptsConfig` when the dispatch context is a team.

### 2. Retire the two old surfaces, and migrate what they hold

**The default needs no migration, and the obvious concern about it is vacuous.** Teams have never shipped. There is no existing team for a new default to apply to, and no install whose behaviour it can change — a team-scoped default cannot reach a user who has no teams. Do not write a "respect the operator's previous choice" import; there is no choice to respect and nothing to import into.

**The real question is the reverse: what happens to the path that has it today.** `pairProgrammingMode` is persisted and read (`autobanState.ts:61`, normalized at `:98-103`) and the planner add-on persists in `roleConfig_planner.addons.aggressivePairProgramming` (`KanbanProvider.ts:6719`) — both shipped, both governing **non-team** dispatch on the installed base right now. If pair programming becomes team-only, those installs lose a behaviour they have. So decide, and state it:

- **Either** the board-level setting survives as the scope for non-team dispatch, and the team field governs teams — two scopes because there are genuinely two dispatch paths, not two answers to one question. Under this option the board enum keeps its host-routing values (non-team dispatch has no roster to derive them from), and the team field carries intensity only.
- **Or** pair programming becomes team-only and the board dropdown is retired, which is a deliberate behaviour removal for existing users and should be recorded as one rather than discovered. Under this option the three non-prompt behaviors of the enum (split dispatch, routing bypass, FE move suppression) must be re-homed or removed explicitly.

Either way, preserve the legacy keys rather than dropping them. The planner add-on checkbox is retired regardless — a ~ten-item add-on list in the Prompts tab is not where this is decided.

> **Superseded:** "an eight-item add-on list in the Prompts tab."
> **Reason:** The planner add-on group (`kanban.html:3564`) contains approximately ten checkboxes (Switchboard Safeguards, Constitution, PRD Reference, Aggressive Pair Programming, Git Prohibition, Clear Antigravity Context, Caveman Output, Skip Compilation, Skip Tests, Advise Research, Write Feature Description If Empty).
> **Replaced with:** "a ~ten-item add-on list in the Prompts tab."

### 3. Board-level and team-level must not both be authoritative

Once the team owns it, the board-wide mode is not a second answer that competes. Either it is gone, or it is the value inherited by teams that have not set one — and if it is the latter, the resolved value must carry its source so "which store answered" is answerable after the fact. A boolean read from two places with no tag is precisely the fallback-indistinguishable-from-a-real-value failure this repository keeps hitting.

**Implementation note:** the resolved-value-with-source requirement applies to the planner branch (`KanbanProvider.ts:6404`) and the lead/coder branch (`:6425-6427`) alike. The team-scoped override introduced in §1 is the mechanism: when a team is the dispatch context, its value wins and is tagged `source: 'team'`; otherwise the global value wins and is tagged `source: 'board'` (or `source: 'default'` if both are unset). Log the tag on resolution, not just on disagreement.

### 4. Say what it does where it is set

The current label is `Pair Programming: Off` in a dropdown of modes, which tells an operator nothing about what turning it on does. Where the team exposes it, one line: the planner splits each plan by difficulty, so the lead takes what needs judgement and the coder takes the rest.

## Verification Plan

### Automated Tests

> **Session directive:** Compilation and automated tests are SKIPPED for this improve run. The checks below remain written down; they are not executed now.

1. A newly created team has pair programming on, and its planner prompt carries the directive without anyone opening a settings panel.
2. A team with it switched off produces a planner prompt with no directive.
3. An install with **no teams** behaves exactly as it does today on the non-team dispatch path — assert the team default reaches nothing outside a team.
4. Legacy keys survive the migration and are readable, and a second upgrade run is a no-op.
5. With the team and the board disagreeing, the resolved value names its source in the log.
6. A head-only team resolves to off with a stated reason, and emits no split directive.
7. An exported skill carries the resolved value, and its description matches what the flag does (split dispatch / classification bias), not the current inaccurate text.
8. Both hosts set and read the field, verified by diffing the composition roots.
9. The three non-prompt behaviors of the retired/scoped board enum (split dispatch, intern→coder routing bypass, FE optimistic-move suppression) behave correctly under the team-scoped value — assert a team with pair programming on triggers the split dispatch and suppresses intern routing, and a team with it off does neither.

### Goal Invariants

- **Assert** a `pairProgramming` field exists on the team group object written by `teamsTabAdopt` (`kanban.html:5626`) with default value `'on'`.
- **Assert** `#plannerAddonAggressivePairProgramming` is **absent** from `kanban.html` (retired checkbox).
- **Assert** the planner branch in `generateUnifiedPrompt` (`KanbanProvider.ts:6404`) reads a team-scoped value when the dispatch context is a team, and falls back to the global value otherwise — paired: the global read is still present for the non-team path.
- **Assert** `AgentSkillExporter` (`:235`, `:240`) emits the **resolved** pair-programming value, and the skill-markdown description text does **not** contain "explain your reasoning step by step" or "be proactive and aggressive in suggesting changes" (the inaccurate descriptions are gone).
- **Assert** every read site of `pairProgrammingMode` in `KanbanProvider.ts` (`:1650`, `:6425`, `:7230`, `:9592`) and `kanban.html` (`:10706`) either consults the team-scoped value when a team is in context, or is explicitly documented as non-team-only.

## Outstanding Questions

- **[user]** Should the board-wide `#pairProgrammingModeSelect` dropdown be **retired entirely** (pair programming becomes team-only — a deliberate behaviour removal for existing non-team users) or **kept as the non-team scope** (two scopes because there are two dispatch paths)? — proceeding on the assumption that it is **kept as the non-team scope** (the lower-risk option that preserves existing behaviour), but this must be confirmed before the non-team path is changed because the alternative removes a shipped behaviour.
- **[user]** Does the team field's `aggressive` intensity map to the same `AGGRESSIVE_PAIR_PROGRAMMING_DIRECTIVE` the planner add-on used, or should the directive text be revisited for the team context (where the planner may not be a team member)? — proceeding on the assumption that the directive text is reused verbatim; the team-scoped override only changes *whether* it is appended, not *what* it says.

## Completion Summary

Implemented per the Outstanding-Question decision (board dropdown kept as the non-team scope). Added a `pairProgramming` field (`off | on | aggressive`, default `'on'`) to the team group object — written by `teamsTabAdopt` and `teamsTabSaveAgentGroup`, rendered as a dropdown in the Teams tab form and shown on the team card. Added `readTeamPairProgramming` + `resolveTeamDefinitionForHeadTerminal` helpers in `teamWiring.ts` and a `resolveTeamPairProgrammingForTerminal` resolver on `KanbanProvider` (head-only teams resolve to `'off'` with a stated reason). Threaded the team value into `generateUnifiedPrompt` via a `teamPairProgramming`/`dispatchTargetTerminal` override (with a `pairProgrammingSource` provenance tag logged on resolution) for both the planner and lead/coder branches, and into the split dispatch (`_dispatchWithPairProgrammingIfNeeded` and the TaskViewerProvider batch pair dispatch). Retired the `#plannerAddonAggressivePairProgramming` checkbox (markup + load + save listener); the legacy `roleConfig_planner.addons.aggressivePairProgramming` key is preserved on read so existing non-team installs keep their behaviour. Corrected the inaccurate `AgentSkillExporter` skill-markdown descriptions for both flags. Every remaining read site of the board enum (`resolveRoutedRole`, `resolveAutoDispatchColumn`, the IDE-lead host-routing sites, and the FE optimistic-move suppression) is documented as non-team-only. Both hosts share the same `KanbanProvider`/`TaskViewerProvider` and webview, so the team field is read and written identically on each. Per session directives, compilation and automated tests were not run.
