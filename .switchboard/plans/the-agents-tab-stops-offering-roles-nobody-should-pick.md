# The Agents Tab Stops Offering Roles Nobody Should Pick

## Goal

Cut the optional agent roles down to the ones that earn a seat. **Ticket Updater**
goes entirely. **Acceptance Tester** goes, and its job folds into the Review
team's head. **Claude Designer / Claude Artifacts** go — the design and artifact
panels use Copy Prompt, which is what they should have used all along.

> **Superseded:** "the design and artifact panels use Copy Prompt" — i.e. that
> Copy Prompt is already the only path, so removing the roles is free.
> **Reason:** Both panels also carry send-to-terminal paths that try a live
> `claude_artifacts`/`claude_import` terminal FIRST and only fall back to
> clipboard with an error toast: `planning.js:7131` posts
> `sendArtifactPromptToTerminal` (PlanningPanelProvider.ts:3607), `design.js:5499`
> posts `sendClaudeImportPrompt` (DesignPanelProvider.ts:3047), and
> DesignPanelProvider.ts:3077 handles `sendClaudeArtifactPrompt`. Delete the
> roles without touching those paths and every click degrades to "No
> claude_artifacts terminal could be reached" — a permanent silent failure.
> **Replaced with:** the send-to-terminal handlers, their webview buttons, and
> the `claude_artifacts`/`claude_import` startup-command fallbacks
> (`TaskViewerProvider.ts:9009-9018`) are removed in the same diff; the copy
> handlers stay.

## Problem analysis

### The tab offers fourteen toggles and most of them are noise

`agent-control.html` lists: planner, lead, coder, intern, reviewer, **tester**,
analyst, **ticket_updater**, researcher, **claude_designer**,
**claude_artifacts**, jules, phone_a_friend, project_manager.

An operator configuring a board is asked fourteen questions to answer what is
really one: *which CLIs run which jobs here.* Each toggle implies a seat worth
staffing, and several imply a pipeline stage that exists only because the toggle
does. The Acceptance Tester's own description says so outright:

> Optional by decision — **enabling it is what gives the pipeline a Completion
> Tested stage.**

A role that conjures a board column when ticked is not an option, it is a hidden
structural decision.

### The three being removed, and why

**Ticket Updater** — described as *"Synchronizes plan state and comments back to
connected project management systems (e.g. ClickUp/Linear)."* That is a
**service**, and it already exists as one: `ClickUpSyncService`,
`LinearSyncService`, `NotionSyncService`, `ContinuousSyncService`, none of which
references the `ticket_updater` role. Staffing an agent seat and a board column
to do what a sync service already does is pure duplication, and the column
(order 9000) sits between review and `COMPLETED` where it can capture cards.

> **Superseded:** "That is a service, and it already exists as one" — the claim
> that the sync services cover the role, making removal free.
> **Reason:** The toggle description misdescribes the role. The actual prompt
> (`agentPromptBuilder.ts:2793-2817`, and the PROMPTS-tab description at
> `agent-control.js:139`) is a **ticket triager**: it reads one imported
> ClickUp/Linear/Notion ticket and posts a verdict comment (severity, area,
> assessment, recommended action, auto/needs-human) back through the local API
> bridge. The sync services move state; none posts a triage verdict. Worse, an
> entire dormant pipeline targets the column: `handleEnableTriagePipeline`
> (`TaskViewerProvider.ts:10255-10355`) writes automation rules with
> `targetColumn: 'TICKET UPDATER'`; `migrateTriageRuleDefaults`
> (`extension.ts:1296-1349`) rewrites stored rules to point at it on every
> extension activation; and the `enableTriagePipeline` verb is wired end-to-end
> (`TicketsPanelProvider.ts:4521`, `LocalApiServer.ts:9801` + the
> SECRET_WRITE_VERBS set at :9435, `tickets.js:6040-6058`, dormant
> `display:none` buttons at `tickets.html:4197/4394`).
> **Replaced with:** removing `ticket_updater` deliberately drops the
> verdict-posting capability — stated, not discovered later — and the whole
> triage-pipeline surface (dormant markup, listeners, verb wiring, both
> handlers) is removed with it. Operator decided: remove it all.

**Acceptance Tester** — *"Judges finished changes against acceptance criteria
(deferred risks resolved and intent satisfied) and writes follow-up plans."* That
is a review judgement, and the Review team already exists to make review
judgements with a head that hands work out and reads what comes back. A separate
role for it splits one job across two seats and two columns.

**Claude Designer / Claude Artifacts** — one imports a design from claude.ai, the
other is a *"terminal-only helper to download and upload claude.ai document
artifacts."* Both are one-shot, operator-initiated errands with a fixed prompt.
Copy Prompt does that without a standing seat, a startup command, a visibility
flag or a role config.

### `claude_artifacts` is not even a real role — corrected: the drift is three-way

> **Superseded:** "`claude_artifacts` appears in no defaults map —
> `DEFAULT_VISIBLE_AGENTS` and `sharedDefaults.js` both carry `claude_designer`
> instead."
> **Reason:** False — audited two maps, missed the third.
> `TaskViewerProvider._defaultVisibleAgents()` (`:9046-9062`) carries
> `claude_artifacts: false` and NOT `claude_designer`. So the drift runs both
> directions: agentConfig.ts + sharedDefaults.js know `claude_designer`;
> TaskViewerProvider's map knows `claude_artifacts`. There is also a THIRD
> pseudo-role in the same class: `claude_import`, with its own startup-command
> fallback (`TaskViewerProvider.ts:9015`) and its own send path
> (`sendClaudeImportPrompt`). It has no toggle, no defaults entry, no label —
> it exists only as a dispatch target.
> **Replaced with:** the removal set is `claude_designer` + `claude_artifacts`
> + `claude_import`, and the catalogue-consistency check must cover all
> visibility maps including `_defaultVisibleAgents`.

The tab renders `data-role="claude_artifacts"` with a startup-command input. But
`claude_artifacts` appears in **no** defaults map — `DEFAULT_VISIBLE_AGENTS` and
`sharedDefaults.js` both carry `claude_designer` instead, labelled *"Claude
Designer"*. So the toggle writes a visibility key nothing reads, and the command
box writes a startup command for a role that has no config entry.

Two names for one idea, one of them orphaned in the markup. Nobody noticed
because a toggle that does nothing looks exactly like a toggle for a feature you
are not using. (And `claude_artifacts` is doubly weird: it is orphaned in the
catalogues AND live as a dispatch target — see above.)

### Removing the two columns simplifies the pipeline's worst branch

`_getNextColumnId` carries a dedicated carve-out — `if (col.id === 'ACCEPTANCE
TESTED' && !acceptanceTesterActive) return true;` — plus an
`_isAcceptanceTesterActive()` probe, plus a special case returning `null` for
`CODE REVIEWED` when no tester is active. `TICKET UPDATER` is the other
role-column in that tail.

Both are also live instances of the trap that stalled this board on 2026-09-20:
a role column that advancing lands in and nothing services. `tester` and
`ticket_updater` are `false` today, so neither is in the pipeline — but that is a
config value away from changing, and `RESEARCHER` is exactly what that looks like.

### Touch-point inventory (what "remove the role" actually means)

The role strings are woven far past the catalogues. The complete excision set:

- **`src/services/agentConfig.ts`** — `BuiltInAgentRole` (:1),
  `BUILT_IN_AGENT_LABELS` (:186-196), `DEFAULT_VISIBLE_AGENTS` (:198-212),
  `DEFAULT_KANBAN_COLUMNS` (`ACCEPTANCE TESTED` :222, `TICKET UPDATER` :223),
  `VALID_ROLES` (:619). **Keep** `CustomAgentAddons.ticketUpdateMode` (:53) and
  its `parseCustomAgentAddons` legacy-key tolerance (:358-365) — that addon
  serves custom agents (`agentPromptBuilder.ts:3084`), not just the removed
  role; dropping it silently breaks stored custom-agent configs.
- **`src/services/agentPromptBuilder.ts`** — `tester` branch (:2435-2510),
  `ticket_updater` branch (:2780-2843) with `warnOnLegacyTicketUpdateMode`
  (:38-49), `CODE_TOUCHING_ROLES` (:1867), `CARD_MOVE_ROLES` (:1885),
  `STAGE_BY_ROLE`'s `claude_designer` entry (:899), tester refs at :1166/:1183,
  `columnToPromptRole` (:2940-2956), the built-in-roles error string (:2933).
  **Keep** the `ticketUpdateMode` options field (:501) and the custom-agent
  directive block (:3084-3091).
- **`src/services/KanbanProvider.ts`** — `'ACCEPTANCE TESTED': 'tester'` map
  (:4249), role lists (:5594-5595, :5875, :5938), `_getSourceColumnLabelForRole`
  (:5928), the `tester` card filter in `_getDefaultPromptPreviews` (:5965), the
  `tester`/`ticket_updater` config branches (:7595-7617 — see fold note below),
  `testerConfig`/`ticketUpdaterConfig` addon reads (:7845, :7849-8132),
  `_isAcceptanceTesterActive` (:17515) and both `_getNextColumnId` carve-outs
  (:8893, :8920, :8941), the `kind: 'reviewed' → 'tester'` fallback (:9026),
  the targetRole allowlist (:9055-9057), `getUATData`'s ACCEPTANCE TESTED read
  (:16438), the column→role map (:17027), plus :15641.
- **`src/services/TaskViewerProvider.ts`** — `_columnToRole` (:6446, :6448),
  `_targetColumnForRole` (:6479, :6488), `_roleForKanbanColumn` (:6501, :6511),
  the next-column tester probe (:6661), `_workflowNameForDispatchRole`
  (:8022/:8024), both `_ensureAcceptanceTesterDispatchEligible` gates
  (:8059, :8474) and the helper itself (:8402), `_isAcceptanceTesterActive`
  (:8397), the `claude_artifacts`/`claude_import` command fallbacks
  (:9009-9018), `_defaultVisibleAgents` (:9056-9058), `wsRoles` (:2966),
  role lists (:9362, :13941), `isTesterEligible`/`'tester-pass'` (:20860-20870),
  the `tester` dispatch branch (:23617-23627), `ROLE_TO_PERSONA_FILE`
  (:24537), `handleEnableTriagePipeline` (:10255-10369).
- **`src/services/KanbanDatabase.ts`** — `migrateDeprecatedColumns`
  (:3508-3545), the `defaultVisible` role list (:13973-13975).
- **`src/services/standingOrderFragments.ts` + `src/services/teamWiring.ts`** —
  the acceptance fold lands in `REVIEW_HEAD_WORK` (:226-249, the deduped single
  source consumed by `NEW_REVIEW_TEAM_HEAD_PROMPT` at :1099), the Review team's
  `purpose` (:1333), and `KNOWN_ROLE_WORDS` (:3423).
- **`src/services/kanbanColumnDerivationImpl.js`** — `'tester-pass'` (:84)
  currently derives `ACCEPTANCE TESTED`.
- **Webviews** — `agent-control.html` toggles (:3144-3153) + Prompts-tab
  `<select>` options (:3369, :3372); `agent-control.js` ROLE_DESCRIPTIONS
  (:137-139) + `standingOrdersTabBuiltInRoles` (:2849); `sharedDefaults.js`
  (visible :11/:13, role config :30/:32, labels :44/:46/:48,
  `PROMPT_OVERRIDE_EXCLUDED_KEYS` :59, `ROLE_ADDONS` :230/:250);
  `terminals.js` `GRID_BUILTIN_ROLES` + `KANBAN_ROLE_ORDER_FALLBACK`
  (:10922-10940); `kanban.html` column def (:3024), copy-label branches
  (:5979-5984), UAT empty-state strings (:2587, :9288); `project.js` label
  logic (:2449-2467); `tickets.html` dormant triage buttons + hint text +
  result divs (:4197-4201, :4394-4398); `tickets.js` listeners (:6040-6058);
  `planning.js` `sendArtifactPromptToTerminal` button (:7131);
  `design.js` `sendClaudeImportPrompt` (:5499).
- **Panels** — `PlanningPanelProvider.ts:3607-3625`,
  `DesignPanelProvider.ts:3047-3099`.
- **Triage excision** — `TicketsPanelProvider.ts:4521`, `LocalApiServer.ts:9801`
  + `:9435` SECRET_WRITE_VERBS, `TaskViewerProvider.handleEnableTriagePipeline`,
  `extension.ts:migrateTriageRuleDefaults` (:1296-1349), generated
  `verbAllowlist.ts` + `protocol-catalog.json` (regenerate),
  `docs/IPC_PROTOCOL.md:396`, stale comment `LocalApiServer.ts:3333-3337`.
- **Extension host (forced edits, not new seams)** — `extension.ts:3605-3609`
  `allBuiltInAgents` drops the three dead entries; `migrateTriageRuleDefaults`
  is deleted outright because it actively writes the dead column. These are
  removals forced by the shared-code deletion, not compatibility work.

## Metadata

**Tags:** refactor, ui, database
**Complexity:** 6
**Scope:** `src/services/agentConfig.ts`, `src/services/agentPromptBuilder.ts`,
`src/services/KanbanProvider.ts`, `src/services/KanbanDatabase.ts`,
`src/services/TaskViewerProvider.ts`, `src/services/teamWiring.ts`,
`src/services/standingOrderFragments.ts`,
`src/services/kanbanColumnDerivationImpl.js`,
`src/services/PlanningPanelProvider.ts`, `src/services/DesignPanelProvider.ts`,
`src/services/TicketsPanelProvider.ts`, `src/services/LocalApiServer.ts`,
`src/webview/agent-control.{html,js}`, `src/webview/sharedDefaults.js`,
`src/webview/terminals.js`, `src/webview/kanban.html`, `src/webview/project.js`,
`src/webview/tickets.{html,js}`, `src/webview/planning.js`,
`src/webview/design.js`, `src/extension.ts` (forced removals only),
generated `src/generated/verbAllowlist.ts` + `protocol-catalog.json`, and the
contract tests enumerated below. Standalone is the verification target; the
extension is a launcher sidebar.

## User Review Required

Three operator decisions are resolved, not open:

- **Migration destination: `CODE REVIEWED`** — for cards stranded in
  `ACCEPTANCE TESTED` or `TICKET UPDATER`. Both sat after review; bouncing to
  `PLAN REVIEWED` discards reviewed state and `COMPLETED` declares work done.
- **Triage pipeline: remove it all** — the dormant buttons, the listeners, the
  verb wiring, `handleEnableTriagePipeline`, and `migrateTriageRuleDefaults`.
  The verdict-posting capability goes with the role; that is deliberate.
- **`CODE REVIEWED` stays terminal for advance** — `_getNextColumnId` returns
  `null`, so no advance/copy button renders. Cards reach `COMPLETED` by drag or
  `completeAll`. This also dodges a real defect: advancing into role-less
  `COMPLETED` would fall through `_generatePromptForDestinationRole`'s
  lead/coder fallback and copy a junk coding prompt.

## Constraints

**Tracker sync must not regress.** Removing `ticket_updater` removes an agent
seat, not the ability to update tickets. Confirm the sync services cover what the
role's prompt did — and if the role did something they do not, that capability
moves into a service before the role goes.

> **Resolved against the code:** the role's prompt does triage-verdict posting,
> which the sync services do NOT cover. Per the operator's call above, that
> capability is dropped with the role, not moved. What must not regress is the
> sync/write-back itself (`realTimeSyncEnabled`, `completeSyncEnabled`,
> `writeBackOnComplete` paths in the automation services) — those are
> role-independent and untouched.

**These columns shipped — migrate.** `ACCEPTANCE TESTED` and `TICKET UPDATER`
exist in released versions and may hold cards. They join `migrateDeprecatedColumns`
alongside `RESEARCHER`. Import before deleting; never unlink a card from a column
that is disappearing.

> **Mechanism correction:** `migrateDeprecatedColumns` does not "join a list" —
> it has ONE hardcoded destination (`'PLAN REVIEWED'`,
> `KanbanDatabase.ts:3515-3519`). Sending the two new columns to `CODE REVIEWED`
> requires extending it to per-column destinations; see Proposed Changes §5.

**Acceptance judging must actually land somewhere.** Deleting the tester without
folding its job into the Review head loses a capability the operator uses. The
Review team's head prompt gains the acceptance criteria explicitly — deferred
risks resolved, intent satisfied, follow-up plans written — in the same change
that removes the role.

> **Landing site pinned:** `REVIEW_HEAD_WORK` in `standingOrderFragments.ts`
> (:226-249) is the ONE source — `NEW_REVIEW_TEAM_HEAD_PROMPT` appends to it.
> Fold there, not in the team def, or the two-channel delivery reintroduces the
> drift its comment describes. The fold must also carve out the fragment's own
> "Do NOT collect them into a new markdown file under .switchboard/plans/" ban:
> a bounded follow-up plan IS meant to be swept by the plan watcher as a new
> card — findings are banned from that directory, follow-up plans are not.

**Keep the role constants honest.** `BuiltInAgentRole`, `BUILT_IN_AGENT_LABELS`,
`DEFAULT_VISIBLE_AGENTS`, `sharedDefaults.js` and the markup must end agreeing.
The `claude_artifacts` / `claude_designer` split is what disagreement looks like.

**No confirmation dialogs.**

## Complexity Audit

### Routine
- Deleting toggle rows and `<option>` entries from `agent-control.html`.
- Trimming role strings from ~15 lists/maps across providers and webviews.
- Removing the `tester`/`ticket_updater`/`claude_designer` prompt-builder
  branches and defaults entries.
- Removing dormant triage markup/listeners and the `enableTriagePipeline` verb
  chain.
- Updating the ~15 contract tests that assert the current role set (see
  Verification Plan).

### Complex / Risky
- `migrateDeprecatedColumns` gains per-column destinations — an irreversible DB
  rewrite of shipped state; a wrong destination silently re-plans finished work.
- The acceptance fold into `REVIEW_HEAD_WORK` must override that fragment's own
  plans-directory ban for exactly one artifact type — easy to write a prompt
  that contradicts itself.
- Stored-state stragglers: saved `automationRules` with
  `targetColumn: 'TICKET UPDATER'` can write the dead column name into `plans`
  AFTER the boot migration runs (the column is a free string in the DB).
- `columnToPromptRole('CODE REVIEWED')` and the `kind: 'reviewed'` fallback both
  name `tester` today — missing either leaves a dispatch path to a deleted role.

## Edge-Case & Dependency Audit

- **Race Conditions:** `migrateDeprecatedColumns` runs once at boot per host
  (`extension.ts:754`, `bootstrap.ts:839`). A card written into a retired column
  after boot (stored automation rule firing, API write) strays — the automation
  rule load path must refuse or strip retired `targetColumn`/`finalColumn`
  values (log it — silent strip is the fallback-shape bug). `tester-pass` stage
  markers already in flight must not derive `ACCEPTANCE TESTED`.
- **Security:** removing `enableTriagePipeline` shrinks the secret-write verb
  set — pure reduction, no new surface. The triager prompt's API-bridge comment
  posting goes away with it.
- **Side Effects:** stored `visibleAgents` keys (`tester: true` in
  `~/.switchboard/integration-config.json`) become inert — preserved, unread,
  correct per the unknown-keys rule. `extension.ts:allBuiltInAgents` keeps
  working after trimming since it is a plain list. `missionStage.ts` derives
  everything from `DEFAULT_KANBAN_COLUMNS`, so `resolveStageForHeadRole('tester')`
  fails loudly ("works at no pipeline column") — the desired behavior.
- **Dependencies & Conflicts:** generated files (`verbAllowlist.ts`,
  `protocol-catalog.json`) must be regenerated, not hand-edited.
  `kanban-custom-column-dispatch-regression.test.js:41` regex-asserts the
  `acceptanceTesterActive` carve-out — it must be rewritten, not just deleted.
  `agentPromptBuilder.test.ts:765-805` asserts `ACCEPTANCE TESTED` must remain —
  invert or delete.

## Dependencies

- None.

## Adversarial Synthesis

Key risks: the excision is broad (~20 source files + ~15 test files) and every
missed reference is a silent dispatch-to-nowhere; the column migration is
irreversible and needs a per-column destination the current mechanism lacks; and
stored automation rules can resurrect the dead column after boot. Mitigations:
the touch-point inventory above is exhaustive (grep-verified), the migration is
idempotent with a logged count, retired-column values are refused loudly at the
rule-load boundary, and the catalogue-consistency test covers all three
visibility maps plus the markup so the `claude_artifacts` drift class cannot
recur.

## Proposed Changes

### 1. Remove `ticket_updater` — role, column, config, and the triage pipeline

**Catalogue excision.** Out of `BuiltInAgentRole`, `BUILT_IN_AGENT_LABELS`,
`DEFAULT_VISIBLE_AGENTS`, `VALID_ROLES` (`agentConfig.ts`), `DEFAULT_ROLE_CONFIG`
+ `BUILT_IN_AGENT_LABELS` + `ROLE_ADDONS` + `PROMPT_OVERRIDE_EXCLUDED_KEYS`
(`sharedDefaults.js` — the set becomes empty; keep the export and its
`webview-shim-injection-contract.test.js` shape or update both), the Agents-tab
toggle row (`agent-control.html:3146`), the Prompts-tab `<option>`
(`agent-control.html:3372`), `ROLE_DESCRIPTIONS` (`agent-control.js:139`),
`standingOrdersTabBuiltInRoles` (`agent-control.js:2849`), `GRID_BUILTIN_ROLES`
+ `KANBAN_ROLE_ORDER_FALLBACK` (`terminals.js:10924/:10939`),
`_defaultVisibleAgents` (`TaskViewerProvider.ts:9056`), `defaultVisible`
(`KanbanDatabase.ts:13975`), the copy-label branch (`kanban.html:5983`),
`project.js` label arms (:2456, :2461), `_workflowNameForDispatchRole`
(`:8024`), all column↔role maps (TaskViewerProvider :6448/:6479/:6501,
KanbanProvider :17027), the `ticketUpdaterConfig` block
(`KanbanProvider.ts:7849-8132`), `resolvedOptions.ticketUpdateMode` (:7616),
the targetRole allowlist (:9057), and the `ticket_updater` prompt branch +
`warnOnLegacyTicketUpdateMode` (`agentPromptBuilder.ts:38-49, :2780-2843`).

**Triage pipeline excision (same diff).** Delete the two dormant
`btn-enable-triage-*` buttons + hint text + result divs
(`tickets.html:4197-4201, :4394-4398`), their listeners
(`tickets.js:6040-6058`), the `enableTriagePipeline` verb arm
(`TicketsPanelProvider.ts:4521`), the verb from `LocalApiServer.ts:9801` and the
SECRET_WRITE_VERBS set (:9435), `handleEnableTriagePipeline`
(`TaskViewerProvider.ts:10255-10369`), and `migrateTriageRuleDefaults`
(`extension.ts:1296-1349` — forced: it writes the dead column on every
activation). Regenerate `verbAllowlist.ts` + `protocol-catalog.json`; update
`docs/IPC_PROTOCOL.md:396` and the stale comment at `LocalApiServer.ts:3333-3337`.

**Stored-rule stragglers.** At ClickUp/Linear `loadConfig` (or the automation
execution boundary), a rule whose `targetColumn` or `finalColumn` is a retired
column id is skipped with a logged warning naming the rule — never silently
rewritten, never executed. This is the loud-failure half of the migration.

Tracker updates remain the sync services' job — unchanged.

### 2. Remove `tester`, and fold acceptance into the Review head

Same catalogue set as §1, plus: `ACCEPTANCE TESTED` from
`DEFAULT_KANBAN_COLUMNS` and `kanban.html:3024`; `_isAcceptanceTesterActive`
from BOTH providers (`KanbanProvider.ts:17515`, `TaskViewerProvider.ts:8397`)
with `_ensureAcceptanceTesterDispatchEligible` (:8402) and its three call sites
(:8059, :8474, :23618); both `_getNextColumnId` carve-outs (:8920, :8941) and
the `acceptanceTesterActive` read (:8893); the `isTesterEligible`/`'tester-pass'`
auto-advance arm (:20860-20870); the `tester` dispatch branch (:23617-23627);
`'tester': 'tester.md'` in `ROLE_TO_PERSONA_FILE` (:24537); the `tester` prompt
branch (`agentPromptBuilder.ts:2435-2510`); `CODE_TOUCHING_ROLES`/
`CARD_MOVE_ROLES` entries; `_getSourceColumnLabelForRole` (:5928); the tester
card filter (:5965); the `tester` config branch (:7595-7611); `testerConfig`
(:7845); `getUATData`'s `ACCEPTANCE TESTED` read (:16438) and the UAT
empty-state strings (`kanban.html:2587, :9288`).

**Role-mapping corrections (the gaps the original plan missed):**

- `columnToPromptRole('CODE REVIEWED')` returns `'tester'` today
  (`agentPromptBuilder.ts:2949-2950`) — with no tester, it returns `null`.
  Remove the `ACCEPTANCE TESTED`/`TICKET UPDATER` cases too.
- The `kind: 'reviewed' → 'tester'` fallback (`KanbanProvider.ts:9026`) becomes
  `role = null` — a reviewed-kind source with no explicit role must fail into
  the generic path, not dispatch to a deleted role.
- `kanbanColumnDerivationImpl.js:84`: `'tester-pass'` must not keep deriving
  `ACCEPTANCE TESTED`. Remap it to `'CODE REVIEWED'` — a stale in-flight marker
  should land the card where it was reviewed, not fall through to `CREATED`.

**The fold (same diff).** Extend `REVIEW_HEAD_WORK`
(`standingOrderFragments.ts:226-249`) so the head's triage explicitly: (a)
verifies every recorded `## Deferred Findings` entry is resolved or re-deferred
with a reason — distinguishing "no deferred record" from "no deferred findings",
per the tester prompt's rule; (b) judges intent against the plan's `## Goal`
(and PRD/constitution when resolved — see below), not just the plan's letter;
and (c) may write ONE bounded follow-up plan to `.switchboard/plans/` when
acceptance fails — scope-limited to unresolved deferred findings or named intent
gaps, exactly the tester prompt's bound. The fragment's existing "never write
.md to .switchboard/plans/" ban must be reworded to ban finding-blobs while
permitting the deliberate follow-up plan. Update the Review team's `purpose`
(`teamWiring.ts:1333`) so the TEAMS tab says what the team now does.

**Constitution/PRD resolution.** The `tester` branch resolves the workspace
constitution (`KanbanProvider.ts:7608-7611`) and treats PRD refs as contextual.
Port that resolution to the `reviewer` path so review dispatches still see the
invariants the tester used to get — otherwise the fold loses the baseline it
judges against.

### 3. Remove `claude_designer`, `claude_artifacts`, AND `claude_import`

All three pseudo-roles go:

- `claude_designer`: `DEFAULT_VISIBLE_AGENTS` (`agentConfig.ts:209`),
  `sharedDefaults.js` (visible :13, role config :32, label :48, `ROLE_ADDONS`
  :250-264), `STAGE_BY_ROLE` (`agentPromptBuilder.ts:899`), `wsRoles`
  (`TaskViewerProvider.ts:2966`), `GRID_BUILTIN_ROLES` (`terminals.js:10924`),
  KanbanProvider `claudeDesignerConfig` reads (:7854, :7943, :7957, :7969, :7981)
  and the role list (:5595).
- `claude_artifacts`: the Agents-tab toggle (`agent-control.html:3152`),
  `_defaultVisibleAgents` (`TaskViewerProvider.ts:9058`), the command fallback
  (:9009), `sendArtifactPromptToTerminal` + its planning.js button (:7131,
  `PlanningPanelProvider.ts:3607-3625`), `sendClaudeArtifactPrompt`
  (`DesignPanelProvider.ts:3077-3099`), the label lookups
  (`TaskViewerProvider.ts:7240, :22705`), `extension.ts:3609`.
- `claude_import`: the command fallback (`TaskViewerProvider.ts:9015`),
  `sendClaudeImportPrompt` + its design.js button (:5499,
  `DesignPanelProvider.ts:3047-3066`).

The copy handlers (`copyArtifactPrompt`, `copyClaudeImportPrompt`,
`copyClaudeArtifactPrompt`) stay — they are the intended path. Any webview
button that only ever sent-to-terminal is removed; a button with a copy sibling
keeps the copy half.

### 4. `CODE REVIEWED` is terminal for advance — written, not emergent

Operator decided: no next column means no advance/copy button. With the columns
gone, `CODE REVIEWED`'s only successor is `COMPLETED`; write the terminality
explicitly in `_getNextColumnId` (`if (normalizedColumn === 'CODE REVIEWED')
return null;` beside the parallel-lane split) rather than letting it fall out of
skip rules — and delete the `acceptanceTesterActive` read it replaces. Do NOT let
advance reach `COMPLETED`: `promptSelected` would copy a lead/coder fallback
prompt for a role-less destination. Cards complete via drag or `completeAll` —
unchanged from today's default behavior.

### 5. Migrate stranded cards — per-column destinations

Extend `migrateDeprecatedColumns` (`KanbanDatabase.ts:3508-3545`) from one
hardcoded destination to a `{from, to}` map:

- `CONTEXT GATHERER`, `CODE_RESEARCHER`, `SPLITTER`, `RESEARCHER` →
  `PLAN REVIEWED` (unchanged)
- `ACCEPTANCE TESTED`, `TICKET UPDATER` → `CODE REVIEWED`

Keep the count-then-update-then-`_persist()` structure and the logged line, but
log per-destination counts so "which rule moved this card" is answerable after
the fact. Idempotent; runs at boot on both hosts.

### 6. Extension host — forced removals only

`extension.ts:3605-3609` drops `Acceptance Tester`, `Ticket Updater`,
`Claude Artifacts` from `allBuiltInAgents`; `migrateTriageRuleDefaults`
(:1296-1349) is deleted (it writes the dead column). No other extension work —
it is the legacy host being removed; the shared files carry the change for both.

## Verification Plan

### Automated Tests

Update-then-run (all currently assert the OLD role set and will fail until
edited): `src/services/__tests__/agentPromptBuilder.test.ts` (:765-805 asserts
`ACCEPTANCE TESTED` must remain — invert), `KanbanProvider.test.ts` (:149-272
stubs `_isAcceptanceTesterActive`),
`kanban-custom-column-dispatch-regression.test.js` (:41 regex asserts the
carve-out — rewrite), `standalone-kanban-fork-detector.test.js` (:49
columnIdPattern), `stage-marker-commit-contract.test.js` (:100, :106, :178),
`minimal-prompt.test.js` (:183), `kanban-default-prompt-previews.test.js`
(:55, :66, :91), `agent-prompt-builder-subagents.test.js`,
`agent-prompt-builder-ticket-updater-modes.test.js` (whole file — delete or
repurpose to custom-agent `ticketUpdateMode` coverage),
`claude-protocol-block-size-contract.test.js` (:163),
`no-curl-in-generated-prompts-contract.test.js` (:83),
`batch-move-team-prompt-contract.test.js` (:240, :293),
`builtin-role-dispatch-coverage.test.js` (:131 asserts
`'tester':'tester-pass'` — update the expected map), `review-team-triage.test.js`
(the REVIEW_HEAD_WORK fold will change its assertions),
`setup-panel-element-ids.test.js` (:44), `goal-invariant-verification.test.js`
(:379), `team-scoped-role-routing.test.js` (:971, :1040),
`webview-shim-injection-contract.test.js` (:136),
`.github/workflows/integration-tests.yml` (:1256).

New/changed assertions:

- None of `ticket_updater`, `tester`, `claude_designer`, `claude_artifacts`,
  `claude_import` appears in `BuiltInAgentRole`, `BUILT_IN_AGENT_LABELS`,
  `VALID_ROLES`, `DEFAULT_VISIBLE_AGENTS`, `_defaultVisibleAgents`,
  `DEFAULT_ROLE_CONFIG`, `BUILT_IN_AGENT_LABELS` (sharedDefaults), `ROLE_ADDONS`,
  `GRID_BUILTIN_ROLES`, `agent-control.html`, `agentPromptBuilder`'s role
  branches or error string. One test, all sources — the drift class cannot recur.
- `DEFAULT_KANBAN_COLUMNS` contains neither `ACCEPTANCE TESTED` nor
  `TICKET UPDATER`; asked of a **running host**, `GET /kanban/columns` returns
  the reduced set.
- A card seeded in either retired column lands in `CODE REVIEWED` with a logged
  per-destination count; a `RESEARCHER` card still lands in `PLAN REVIEWED`;
  running the migration twice changes nothing.
- `_getNextColumnId('CODE REVIEWED')` returns `null`; no `acceptanceTester`
  symbol remains in either provider.
- `columnToPromptRole('CODE REVIEWED')` is `null`; `'tester-pass'` derives
  `CODE REVIEWED`.
- `REVIEW_HEAD_WORK` contains the acceptance clauses (deferred-findings
  verification, intent-vs-Goal judging, bounded follow-up plan) — asserted on
  the text, because "we folded it in" is otherwise unfalsifiable.
- `enableTriagePipeline` appears nowhere in verb tables, allowlists, or panel
  handlers; `handleEnableTriagePipeline` and `migrateTriageRuleDefaults` are
  gone.
- Tracker sync still updates a ticket with no `ticket_updater` role present.
- No send-to-terminal path references `claude_artifacts` or `claude_import`;
  the copy handlers remain.

### Goal Invariants

- `TICKET UPDATER` and `ACCEPTANCE TESTED` are absent from
  `DEFAULT_KANBAN_COLUMNS` AND resolvable as retired ids in
  `migrateDeprecatedColumns` — absent *here*, migrated *there*. (Paired:
  deleting the column without migrating strands shipped cards; migrating
  without deleting leaves the trap.)
- `tester`, `ticket_updater`, `claude_designer`, `claude_artifacts`,
  `claude_import` appear in zero entries of every role catalogue AND the Agents
  tab markup offers exactly the surviving roles.
- `_getNextColumnId('CODE REVIEWED') === null` AND `completeAll`/`completeSelected`
  still move a `CODE REVIEWED` card to `COMPLETED` — terminal for advance does
  not mean unreachable completion.
- Acceptance judging survives: `REVIEW_HEAD_WORK` text contains
  deferred-findings verification and bounded follow-up-plan authority.
- No board column exists for a role that takes no delivery of a card.

### Manual

Open the Agents tab on the running board (`http://127.0.0.1:7777`) and confirm
the reduced list — and confirm the served bundle postdates the edit (stale-dist
check: `ps -eo lstart` on the host vs the bundle mtime). Run a card through
review and confirm the Review head judges acceptance. Import a ClickUp/Linear
ticket and confirm sync still writes back with no triage stage. Check the
Tickets tab shows no triage button.

## Outstanding Questions

- **[user]** Do `analyst`, `phone_a_friend`, `jules` or `project_manager`
  survive this cut? The operator named three roles to remove; the remaining
  optional four were not discussed and are left alone deliberately — but the
  same question applies to each, and answering it now avoids a second pass —
  proceeding on the assumption that they stay.
