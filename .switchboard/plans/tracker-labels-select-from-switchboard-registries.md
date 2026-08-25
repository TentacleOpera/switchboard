# Tracker labels select from Switchboard-owned registries — an import filter, a queue switch, and preset selectors

## Goal

Give Linear and ClickUp labels a job that fits Switchboard's actual model: **selecting** from registries Switchboard owns. An opt-in import filter so a workspace's hundreds of issues do not all become cards, a closed-vocabulary switch to enqueue, and selectors that name a prompt preset or skill set. Labels never carry content — only a choice from a fixed set.

> **This plan replaced a team-routing design, and the reason is worth keeping.** The earlier version proposed `lead:coder` labels routing an issue to a specific team's lead, reusing `resolveTeamScopedRoleTerminal`. It does not fit: **Switchboard is a pipeline, and a card passes through several teams** — planner, then coder, then reviewer. "Which team" is therefore a property of the card's *current stage*, which Switchboard already knows and updates as the card moves, not a static property a label could hold. A single team label would be wrong for most of the card's life. The resolver work in that version falls away with it.

### Problem Analysis

**Every issue in a tracker becomes a candidate, and most should not.** A Linear or ClickUp workspace holds hundreds of issues across teams that have nothing to do with agent work. Nothing today lets an operator say *which* issues are Switchboard's, so import scope is guessed from projects, lists or queries rather than declared per issue. An opt-in label is the cheapest possible declaration and it removes the guessing entirely.

**And labels are the only Linear/ClickUp affordance left over once the hierarchy maps natively.** Project → Project, Feature → parent Issue, subtask → Sub-issue, column → workflow state, tags → labels, complexity → estimate, priority → priority. The structural mapping needs no invention, which frees labels for things the trackers have no field for. The question was never "how do we squeeze Switchboard into labels" but "what does Switchboard need that has no native home".

**Three things qualify, and they share one shape.** Selecting whether an issue is in scope; selecting that it should be enqueued; selecting which prompt or skill set applies. All are *choices from a set Switchboard defines*. None is content.

**That shape matters because it keeps the command vocabulary closed.** `the-remote-command-vocabulary-is-closed.md` establishes that the remote surface may author content and move a card, and that a free-text instruction channel is what turns a reviewed-plan pipeline into a remote shell. A label from a **fixed vocabulary** is not that channel — it is exactly the typed switch that plan's mechanism section endorses: no free text, a set the extension defines, semantics the extension owns. `sb:queue` is a boolean switch that happens to be spelled as a label.

The line is therefore precise, and it is the whole safety argument here: **a label may name a preset; it may never be one.** `sb:prompt:review-hardening` selecting a locally-registered prompt is a switch. A label whose text becomes prompt input is the instruction channel wearing a costume, and an unrecognised label must be ignored rather than interpreted.

### Existing Namespace — Reconciliation with Shipped Behavior

**The codebase already uses a `switchboard` / `switchboard:` label namespace for outbound tracking.** This plan proposes a **separate `sb:` prefix for inbound switches**. The two are deliberately distinct and must not be merged:

- **Linear outbound:** `_ensureSwitchboardLabel` (`LinearSyncService.ts:2108`) creates a label named `switchboard` (color `#6366f1`) during setup, stored as `config.switchboardLabelId`. It is applied to every issue Switchboard creates (`LinearSyncService.ts:2343`, `:2435`). On import, the `switchboard` label name is filtered out of the Tags metadata line (`LinearSyncService.ts:2756`: `.filter(n => n !== 'switchboard')`).
- **ClickUp outbound:** Switchboard writes `switchboard:<planId>` tags on outbound sync (`ClickUpSyncService.ts:2973`). On import, tasks with `switchboard:`-prefixed tags are **skipped entirely** (`ClickUpSyncService.ts:3223-3224`: `hasSwitchboardTag` → `skipped++; continue`) — this is a dedup filter ("already owned by Switchboard, don't re-import"). Additionally, `switchboard:`-prefixed tags are filtered out of the Tags metadata line (`ClickUpSyncService.ts:3285`).

**Why `sb:` is separate from `switchboard:`:** The existing `switchboard:` prefix means "Switchboard created this — skip on import" (outbound tracking / dedup). The proposed `sb:` prefix means "operator wants Switchboard to act on this — include on import" (inbound switch). These are **opposite semantics**. Merging them would mean `switchboard:queue` is simultaneously "skip" (existing dedup) and "enqueue" (new switch) — a contradiction. The `sb:` prefix avoids this collision entirely.

**The existing outbound labeling and dedup logic remains unchanged.** This plan adds inbound `sb:` label handling on top of the existing `switchboard`/`switchboard:` outbound machinery. The two coexist: an issue can have both a `switchboard` label (outbound, SB-created) and an `sb:queue` label (inbound, operator-set), and both are handled independently.

> **Superseded:** Non-goal "Switchboard writing labels. Inbound only, so it can never prune a label a person created."
> **Reason:** As written, this contradicts shipped behavior — Switchboard already writes labels outbound (`switchboard` on Linear, `switchboard:<planId>` on ClickUp). A coder reading the original non-goal would think they need to stop outbound labeling, breaking the dedup filter.
> **Replaced with:** "Switchboard does not write **`sb:` switch labels** outbound. The existing `switchboard` / `switchboard:` outbound labels remain — they are the dedup mechanism. Inbound only applies to the `sb:` namespace, so Switchboard can never prune an `sb:` label a person created."

### Root Cause

Labels are the most flexible thing a tracker offers, which makes them the default place to put anything that does not fit elsewhere. Without a stated rule they accumulate meaning until they are an untyped API — and in a system that feeds LLM agents, an untyped API that reaches prompt input is a security surface rather than a convenience.

### Non-goals

- Team routing. Retired above; the pipeline model does not support it.
- Labels carrying prompt text, instructions, or any free-form content.
- Switchboard writing **`sb:` switch labels** outbound. The existing `switchboard` / `switchboard:` outbound labels remain — they are the dedup mechanism. Inbound only applies to the `sb:` namespace, so Switchboard can never prune an `sb:` label a person created — this also removes the namespace-collision problem an outbound `sb:` sync would have had.
- Replacing project/list-based import scoping. The label is an additional, more precise selector.

## Metadata

> **Superseded:** **Complexity:** 4
> **Reason:** The plan touches multiple files (LinearSyncService, ClickUpSyncService, planMetadataUtils, a new registry module, two protocol docs), requires reconciliation with the existing `switchboard`/`switchboard:` namespace, and introduces an edge-triggered queue switch with persistent state. That is multi-file coordination with moderate, well-scoped risks — a 5, not a 4.
> **Replaced with:** **Complexity:** 5

**Complexity:** 5
**Tags:** api, backend, feature, security, ux

## User Review Required

Yes — four decisions.

1. **Is the import filter opt-in or opt-out?** Recommendation: **opt-in** (`sb:switchboard` or similar), configurable, and **off by default** so existing installs keep their current import scope. Opt-out would silently start importing a whole workspace on upgrade.
2. **Prefix.** Recommendation: one reserved prefix (`sb:`) for every Switchboard-recognised inbound label, deliberately distinct from the existing `switchboard` / `switchboard:` outbound namespace (see Namespace Reconciliation above). An operator can see at a glance which labels the tooling reads, and so an unrecognised `sb:` label is a visible typo rather than silence.
3. **Does an unrecognised `sb:` label warn?** Recommendation: yes, once, on the card — a mistyped `sb:qeue` should not fail silently. This is the difference between a switch panel and a guessing game.
4. **Do preset selectors ship in the first cut?** Recommendation: **no.** Land the import filter and the queue switch first; prompt and skill selectors are the two that touch agent input and deserve the closed-vocabulary enforcement to exist and be tested before they use it.

## Complexity Audit

### Routine

- Reading labels from the issue payload — already done (`LinearSyncService.ts:63` `LinearIssue.labels`, per-team label load in `getAutomationCatalog` at `:332-374`).
- A registry of recognised `sb:` labels and their meanings.
- An import predicate consulting the filter label.
- Filtering `sb:`-prefixed labels from the Tags metadata line — extends the existing pattern at `LinearSyncService.ts:2756` (filters `switchboard`) and `ClickUpSyncService.ts:3285` (filters `switchboard:*`).

### Complex / Risky

- **The import filter changes what exists, not just what is shown.** Turning it on for a workspace that was importing broadly means cards stop arriving; turning it off means a flood. Neither should happen silently on upgrade, and the transition needs a count ("this will import 412 issues") before it runs.
- **Removing a filter label does not unimport a card.** The plan file and row already exist. So the label controls *entry*, and departure is the board's own deletion path — worth stating, because operators will expect symmetry and there isn't any.
- **The queue switch needs edge-triggered semantics and a specified storage location.** A label that remains present is a standing `true`, and a poll that acts on presence enqueues repeatedly. Consume once and record that the label was acted on in a `tracker_label_actions` table (issueId, labelName, firedAt, outcome), following the request-row pattern from `the-remote-command-vocabulary-is-closed.md`. A re-add is a new row rather than a replay.
- **Preset selectors are the part that touches prompts.** Enforcement must be a registry lookup with a hard refusal on miss — never a fuzzy match, never a fallback to using the label text. A near-miss that silently resolves to the wrong preset is worse than a refusal, and a fallback to text is the channel this plan exists to prevent.
- **Two providers, one vocabulary.** ClickUp tags and Linear labels differ in casing and character rules; the registry should match normalised names (lowercase, trim) so `SB:Queue` and `sb:queue` are the same switch. Preset names are registered case-sensitively — the registry is the source of truth, normalisation is for label-to-registry lookup only. Two presets whose registered names differ only in case is a registration error caught at registry load, not a matching ambiguity.
- **Namespace coexistence with the existing `switchboard` / `switchboard:` outbound labels.** The import filter and the existing ClickUp dedup skip (`switchboard:` = skip) must not interfere. The import filter is an additional predicate evaluated alongside the existing skip, not a replacement for it.

## Edge-Case & Dependency Audit

**Race conditions**
- A label added and removed between polls: the switch either fired or did not; record which in `tracker_label_actions` so a re-add is a new request rather than a replay.
- Import filter applied while a delta pull is mid-flight.

**Security**
- The closed vocabulary is the control. Anyone who can label an issue can enqueue work or select a preset from the registry — which is the same authority as moving a card, and bounded by the same review gate. What they cannot do is supply new instructions, and that boundary must be enforced by lookup rather than convention.
- An unrecognised label must be inert. Interpreting the unknown is how a closed set becomes an open one.
- A `switchboard:`-prefixed label (existing outbound) must never be interpreted as an `sb:` switch. The prefix check is exact: `sb:` only, never `switchboard:`.

**Side effects**
- `remote-control-dispatch-acknowledgment-writeback.md`'s receipt should name which switch fired, so a label-triggered enqueue is visible rather than mysterious. This is additive to that plan's dispatch receipt.
- `sanitizeTags`' allowlist (`planMetadataUtils.ts:12`) drops unrecognised tags on DB import — but `sb:` labels are written to the `> **Tags:**` metadata line in the plan file first (`LinearSyncService.ts:2768`, `ClickUpSyncService.ts:3299`), and `sanitizeTags` only runs when the watcher parses the file. `sb:` labels must be filtered at the **write site** (extending the existing filter at `LinearSyncService.ts:2756` and `ClickUpSyncService.ts:3285`), not just relied on to be dropped by `sanitizeTags` on import. The plan file's Tags line is human-readable; `sb:queue` appearing there is noise even if it doesn't survive to the DB.
- The `linear-api` and `clickup-api` protocols document label handling and need the `sb:` registry listed alongside the existing `switchboard` / `switchboard:` outbound labels.

**Migration**
- Additive and off by default. No install changes import scope until the filter is enabled, and the enable step reports what it will do first.

## Dependencies

- **Inherits the vocabulary boundary from** `the-remote-command-vocabulary-is-closed.md`; the registry is that plan's typed switch set expressed in a tracker's labels. The `tracker_label_actions` table follows that plan's request-row pattern (id, claimed-at, completed-at, outcome).
- **Independent of** `linear-oauth-actor-app-for-per-lead-attribution.md`.
- **Coordinate with** the tags mapping: labels that are switches must be excluded from tag import — at the write site (`LinearSyncService.ts:2756`, `ClickUpSyncService.ts:3285`), extending the existing `switchboard` / `switchboard:` filters, not only via `sanitizeTags`.
- **Coordinate with** `remote-control-dispatch-acknowledgment-writeback.md`: the dispatch receipt should name which `sb:` switch fired.

## Adversarial Synthesis

Key risks: a preset selector that falls back to label text is the free-text instruction channel the vocabulary plan refuses, reached by a different route; the plan proposes `sb:` without acknowledging the existing `switchboard`/`switchboard:` outbound namespace, risking operator confusion and a `switchboard:queue` mistype being silently skipped by the existing dedup rather than warned; `sb:` labels reach the plan file's Tags line before `sanitizeTags` drops them, so isolation must be at the write site; and the queue switch's "fired" state has no specified storage. Mitigations: registry lookup with hard refusal and no text fallback; a Namespace Reconciliation section documenting why `sb:` is distinct from `switchboard:`; write-site filtering extending the existing `switchboard`/`switchboard:` pattern; and a `tracker_label_actions` table for edge-triggered consumption.

## Proposed Changes

1. **A registry of recognised `sb:` labels** with their meanings, one place, provider-neutral. New file: `src/services/trackerLabelRegistry.ts`. Exports a `TRACKER_LABEL_DEFINITIONS` map (label name → definition: kind, handler reference, version) and a `resolveTrackerLabel(rawName: string): { matched: boolean; definition?: TrackerLabelDefinition; normalisedName: string }` function. Normalisation: lowercase + trim. Matching: exact normalised match against registry keys. No fuzzy, no fallback.

2. **Import filter** (`sb:switchboard`, configurable, off by default): only labelled issues become candidates.
   - **Linear** (`LinearSyncService.ts`, the `filteredTasks` loop starting at `:2750`): when the filter is enabled, skip issues whose labels do not include a label resolving to `sb:switchboard`. The existing `switchboard` label filter at `:2756` remains unchanged.
   - **ClickUp** (`ClickUpSyncService.ts`, the filter loop starting at `:3190`): when the filter is enabled, skip tasks whose tags do not include a tag resolving to `sb:switchboard`. The existing `hasSwitchboardTag` skip at `:3223-3224` (dedup for `switchboard:`-tagged tasks) remains unchanged and is evaluated **before** the new filter.
   - Enabling reports the count it will import before running.

3. **Queue switch** (`sb:queue`): edge-triggered, consumed once, recorded as fired.
   - New table `tracker_label_actions` (issueId TEXT, labelName TEXT, firedAt TEXT, outcome TEXT, PRIMARY KEY (issueId, labelName)). Created via the existing `KanbanDatabase` migration path.
   - On each sync, for each issue with an `sb:queue` label: check `tracker_label_actions` for an existing (issueId, `sb:queue`) row. If present, skip (already fired). If absent, enqueue the work, insert a row with `firedAt = now` and `outcome = 'enqueued'`.
   - Removing and re-adding the label: the row persists, so a re-add does not re-fire. To re-enqueue, the operator removes the row (via board deletion of the card, which cascades) or uses a different mechanism. This matches the vocabulary plan's "retry is explicit" property.

4. **Unrecognised `sb:` labels warn once** on the card and are otherwise inert. A label matching the `sb:` prefix but not resolving in the registry triggers a single warning comment (via `postManagedComment` on Linear / the ClickUp comment route) naming the unrecognised label. The warning is posted once per (issueId, labelName) — tracked in `tracker_label_actions` with `outcome = 'unrecognised-warned'` to avoid repeat warnings on every poll.

5. **Switch labels never enter the tags field — at the write site.**
   - **Linear** (`LinearSyncService.ts:2756`): extend the existing `.filter(n => n !== 'switchboard')` to also filter any label whose lowercased name starts with `sb:`.
   - **ClickUp** (`ClickUpSyncService.ts:3285`): extend the existing `.filter(n => !n.toLowerCase().startsWith('switchboard:'))` to also filter any tag whose lowercased name starts with `sb:`.
   - This prevents `sb:` labels from appearing in the `> **Tags:**` metadata line in the plan file. `sanitizeTags` (`planMetadataUtils.ts:12`) remains as a backstop but is not the primary defense.

6. **Preset selectors** (`sb:prompt:<name>`, `sb:skills:<name>`) — deferred to a second cut, resolved strictly by registry lookup, hard refusal on miss, never a text fallback.

7. **Document the registry** in the `linear-api` (`.agents/protocols/linear-api/SKILL.md`) and `clickup-api` (`.agents/protocols/clickup-api/SKILL.md`) protocols. List both the existing `switchboard` / `switchboard:` outbound labels AND the new `sb:` inbound switches, with their distinct semantics.

### Migration

Additive, off by default, no import-scope change until enabled, and the enable step is preceded by a count. The `tracker_label_actions` table is created via the existing `KanbanDatabase` migration path (additive — no existing table altered).

## Verification Plan

- **Import filter:** with it on, assert only labelled issues import and the count reported before enabling matched what arrived. With it off, assert current behaviour exactly.
- **No silent flip:** upgrade an install with the filter unset; assert import scope is unchanged.
- **Unimport asymmetry:** remove the filter label from an imported issue; assert the card remains and the behaviour is documented rather than surprising.
- **Queue switch is edge-triggered:** leave `sb:queue` in place across several polls; assert exactly one enqueue and one `tracker_label_actions` row. Remove and re-add; assert no second enqueue (row persists).
- **Unknown label:** add `sb:qeue`; assert one warning, no action, and no interpretation. Assert a `tracker_label_actions` row with `outcome = 'unrecognised-warned'` prevents repeat warnings.
- **No text fallback:** add `sb:prompt:does-not-exist`; assert refusal, and specifically assert the label text never reaches a prompt — the test this plan exists for.
- **Case and provider parity:** `SB:Queue` in Linear and `sb:queue` in ClickUp resolve to the same switch; two distinct presets differing only in case are rejected at registry load.
- **Tags isolation:** assert no `sb:` label appears in a plan's `> **Tags:**` metadata line (write-site filter), and no `sb:` label appears in the DB tags column (sanitizeTags backstop).
- **Namespace coexistence:** an issue with both a `switchboard` label (Linear outbound) and an `sb:queue` label (inbound) is handled correctly — the `switchboard` label is filtered from tags, the `sb:queue` label fires the queue switch, and neither interferes with the other. A `switchboard:queue` tag on ClickUp is skipped by the existing dedup (`hasSwitchboardTag`) and does NOT fire the queue switch (prefix check is `sb:` only).
- **Vocabulary closure:** assert no label path can deliver free text into prompt input, matching the contract test in the vocabulary plan.

### Goal Invariants

- Assert `src/services/trackerLabelRegistry.ts` exists and exports `TRACKER_LABEL_DEFINITIONS` with at least `sb:switchboard` and `sb:queue` entries.
- Assert `resolveTrackerLabel('SB:Queue').matched === true` and `resolveTrackerLabel('sb:qeue').matched === false` (normalised lookup, hard refusal on miss).
- Assert `LinearSyncService.ts:2756` filters labels whose lowercased name starts with `sb:` (in addition to the existing `switchboard` filter).
- Assert `ClickUpSyncService.ts:3285` filters tags whose lowercased name starts with `sb:` (in addition to the existing `switchboard:` filter).
- Assert a `tracker_label_actions` table exists in `KanbanDatabase` with columns (issueId, labelName, firedAt, outcome).
- Assert no code path interprets a `switchboard:`-prefixed label as an `sb:` switch (prefix check is `sb:` only).

## Uncertain Assumptions

The user was advised to run web research to confirm the following external API behaviors before implementation:

- **Linear label names — character restrictions and case sensitivity.** The `sb:` prefix scheme depends on Linear allowing colons in label names. The codebase creates a label named `switchboard` (no colon) but never tests colons. If Linear rejects colons in label names, the `sb:` format is invalid for Linear and an alternative separator or naming scheme is needed. Linear's case-sensitivity rules for label names also affect whether normalisation is necessary or redundant.
- **ClickUp tag names — case sensitivity and uniqueness rules.** The codebase uses `switchboard:<planId>` tags (proving colons are allowed), but ClickUp's case-sensitivity and uniqueness rules for tags are not documented in the code. This affects whether `SB:Queue` and `sb:queue` are distinct tags in ClickUp's storage or the same tag.

## Outstanding Questions

- **[user]** Should the import filter support a negative form (`sb:ignore`) for workspaces that would rather opt out of a broad existing scope than re-label everything? — proceeding on the assumption that it will not, and the opt-in `sb:switchboard` is the only filter direction in the first cut.
- **[user]** Do preset selectors belong on the issue at all, or on the plan once imported — where the operator can see them beside the plan they affect? — proceeding on the assumption that they belong on the issue (as a selection from a registry), deferred to the second cut regardless.
- **[user]** Is there a case for the queue switch carrying a target (`sb:queue:review`), and does that reintroduce the routing problem this plan retired? — proceeding on the assumption that `sb:queue` is a bare boolean with no target, and target-bearing variants are out of scope.
