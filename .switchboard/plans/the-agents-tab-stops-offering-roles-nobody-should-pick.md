# The Agents Tab Stops Offering Roles Nobody Should Pick

## Goal

Cut the optional agent roles down to the ones that earn a seat. **Ticket Updater**
goes entirely. **Acceptance Tester** goes, and its job folds into the Review
team's head. **Claude Designer / Claude Artifacts** go — the design and artifact
panels use Copy Prompt, which is what they should have used all along.

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

### `claude_artifacts` is not even a real role

The tab renders `data-role="claude_artifacts"` with a startup-command input. But
`claude_artifacts` appears in **no** defaults map — `DEFAULT_VISIBLE_AGENTS` and
`sharedDefaults.js` both carry `claude_designer` instead, labelled *"Claude
Designer"*. So the toggle writes a visibility key nothing reads, and the command
box writes a startup command for a role that has no config entry.

Two names for one idea, one of them orphaned in the markup. Nobody noticed
because a toggle that does nothing looks exactly like a toggle for a feature you
are not using.

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

## Metadata

**Complexity:** 5
**Tags:** agents, roles, kanban, columns, simplification, standalone
**Scope:** `src/services/agentConfig.ts`, `src/services/KanbanProvider.ts`,
`src/services/KanbanDatabase.ts`, `src/services/teamWiring.ts`,
`src/webview/agent-control.html`, `src/webview/sharedDefaults.js`,
`src/webview/terminals.js`. **Standalone only** — the extension is a launcher
sidebar and is not a verification target.

## Constraints

**Tracker sync must not regress.** Removing `ticket_updater` removes an agent
seat, not the ability to update tickets. Confirm the sync services cover what the
role's prompt did — and if the role did something they do not, that capability
moves into a service before the role goes.

**These columns shipped — migrate.** `ACCEPTANCE TESTED` and `TICKET UPDATER`
exist in released versions and may hold cards. They join `migrateDeprecatedColumns`
alongside `RESEARCHER`. Import before deleting; never unlink a card from a column
that is disappearing.

**Acceptance judging must actually land somewhere.** Deleting the tester without
folding its job into the Review head loses a capability the operator uses. The
Review team's head prompt gains the acceptance criteria explicitly — deferred
risks resolved, intent satisfied, follow-up plans written — in the same change
that removes the role.

**Keep the role constants honest.** `BuiltInAgentRole`, `BUILT_IN_AGENT_LABELS`,
`DEFAULT_VISIBLE_AGENTS`, `sharedDefaults.js` and the markup must end agreeing.
The `claude_artifacts` / `claude_designer` split is what disagreement looks like.

**No confirmation dialogs.**

## Proposed changes

### 1. Remove `ticket_updater` — role, column and config

Out of `BuiltInAgentRole`, `BUILT_IN_AGENT_LABELS`, `DEFAULT_VISIBLE_AGENTS`,
`DEFAULT_ROLE_CONFIG`/`sharedDefaults.js`, the role-config addons block
(`ticketUpdateMode` and friends), the Agents tab markup, and
`DEFAULT_KANBAN_COLUMNS` (`TICKET UPDATER`). Tracker updates remain the sync
services' job.

### 2. Remove `tester`, and fold acceptance into the Review head

Same removal set, plus `ACCEPTANCE TESTED` from the columns, plus
`_isAcceptanceTesterActive` and both of its carve-outs in `_getNextColumnId`.

The Review team's head prompt gains the acceptance responsibility in the same
diff: judge finished work against its acceptance criteria, confirm deferred risks
are resolved and intent is satisfied, and write a follow-up plan when it is not.
The team's `purpose` string is updated so the TEAMS tab says what the team now
does.

### 3. Remove `claude_designer` and the orphaned `claude_artifacts`

Both toggles and both command inputs come out of the Agents tab, along with
`claude_designer`'s entries in the defaults maps and its canned prompt. The design
and artifact panels keep working through Copy Prompt — verify that path exists on
both panels before the role is removed, and add it where it does not.

### 4. Migrate stranded cards

`ACCEPTANCE TESTED` and `TICKET UPDATER` join the `deprecatedColumns` list in
`migrateDeprecatedColumns`, which already runs on both hosts and is idempotent.
Destination: **`CODE REVIEWED`** — both stages sit after review, and a card that
reached either had already been reviewed; sending it to `PLAN REVIEWED` or
`CREATED` would discard that. See Outstanding questions.

### 5. Settle what `CODE REVIEWED` advances to

With no tester, `_getNextColumnId`'s `CODE REVIEWED → null` special case no longer
describes anything. Decide explicitly whether `CODE REVIEWED` advances to
`COMPLETED` or remains terminal for the advance button, and write the answer into
the code rather than leaving it to fall out of the skip rules.

## Verification plan

### Automated

- None of `ticket_updater`, `tester`, `claude_designer`, `claude_artifacts`
  appears in `BuiltInAgentRole`, `BUILT_IN_AGENT_LABELS`,
  `DEFAULT_VISIBLE_AGENTS`, `sharedDefaults.js` or `agent-control.html`.
- `DEFAULT_KANBAN_COLUMNS` contains neither `ACCEPTANCE TESTED` nor
  `TICKET UPDATER`; **asked of a running host**, `GET /kanban/columns` returns
  the reduced set.
- A card seeded in either retired column lands in `CODE REVIEWED`, with a reason
  naming the retired column; running the migration twice changes nothing.
- `_isAcceptanceTesterActive` and its carve-outs are gone from
  `_getNextColumnId`.
- **The Review head prompt contains the acceptance criteria** — asserted on the
  text, because "we folded it in" is otherwise unfalsifiable.
- **Tracker sync still updates a ticket** with no `ticket_updater` role present.
- The remaining role set is identical across all four catalogues — one test, all
  four sources, so the `claude_artifacts` class of drift cannot recur.

### Goal invariants

- No board column exists for a role that takes no delivery of a card.
- Every toggle in the Agents tab writes a key something reads.
- Acceptance judging still happens, by the Review head.
- No card is stranded in a column that no longer exists.

### Manual

Open the Agents tab and confirm the reduced list. Then run a card through review
and confirm the Review head judges acceptance, and that a ticket still syncs.

## Outstanding questions

- **Do retired-column cards go to `CODE REVIEWED` or `COMPLETED`?** `CODE REVIEWED`
  is proposed as the conservative choice — it keeps the card in the operator's
  hands rather than declaring work done on its behalf. `COMPLETED` is arguable for
  `TICKET UPDATER`, which sat immediately before it. Decide before writing the
  migration; it is the irreversible part.
- **Does `analyst`, `phone_a_friend`, `jules` or `project_manager` survive this
  cut?** The operator named three roles to remove. The remaining optional four
  were not discussed and are left alone deliberately — but the same question
  applies to each, and answering it now avoids a second pass.
