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

### Root Cause

Labels are the most flexible thing a tracker offers, which makes them the default place to put anything that does not fit elsewhere. Without a stated rule they accumulate meaning until they are an untyped API — and in a system that feeds LLM agents, an untyped API that reaches prompt input is a security surface rather than a convenience.

### Non-goals

- Team routing. Retired above; the pipeline model does not support it.
- Labels carrying prompt text, instructions, or any free-form content.
- Switchboard writing labels. Inbound only, so it can never prune a label a person created — this also removes the namespace-collision problem an outbound sync would have had.
- Replacing project/list-based import scoping. The label is an additional, more precise selector.

## Metadata

**Complexity:** 4
**Tags:** api, backend, feature, security, ux

## User Review Required

Yes — four decisions.

1. **Is the import filter opt-in or opt-out?** Recommendation: **opt-in** (`sb:switchboard` or similar), configurable, and **off by default** so existing installs keep their current import scope. Opt-out would silently start importing a whole workspace on upgrade.
2. **Prefix.** Recommendation: one reserved prefix (`sb:`) for every Switchboard-recognised label, so an operator can see at a glance which labels the tooling reads, and so an unrecognised `sb:` label is a visible typo rather than silence.
3. **Does an unrecognised `sb:` label warn?** Recommendation: yes, once, on the card — a mistyped `sb:qeue` should not fail silently. This is the difference between a switch panel and a guessing game.
4. **Do preset selectors ship in the first cut?** Recommendation: **no.** Land the import filter and the queue switch first; prompt and skill selectors are the two that touch agent input and deserve the closed-vocabulary enforcement to exist and be tested before they use it.

## Complexity Audit

### Routine

- Reading labels from the issue payload — already done (`LinearSyncService.ts:63`, per-team label load at `:338`).
- A registry of recognised `sb:` labels and their meanings.
- An import predicate consulting the filter label.

### Complex / Risky

- **The import filter changes what exists, not just what is shown.** Turning it on for a workspace that was importing broadly means cards stop arriving; turning it off means a flood. Neither should happen silently on upgrade, and the transition needs a count ("this will import 412 issues") before it runs.
- **Removing a filter label does not unimport a card.** The plan file and row already exist. So the label controls *entry*, and departure is the board's own deletion path — worth stating, because operators will expect symmetry and there isn't any.
- **The queue switch needs edge-triggered semantics.** A label that remains present is a standing `true`, and a poll that acts on presence enqueues repeatedly. Consume once and record that the label was acted on, exactly as the switch-table design requires of request rows.
- **Preset selectors are the part that touches prompts.** Enforcement must be a registry lookup with a hard refusal on miss — never a fuzzy match, never a fallback to using the label text. A near-miss that silently resolves to the wrong preset is worse than a refusal, and a fallback to text is the channel this plan exists to prevent.
- **Two providers, one vocabulary.** ClickUp tags and Linear labels differ in casing and character rules; the registry should match normalised names so `SB:Queue` and `sb:queue` are the same switch, without normalisation being loose enough to collide two distinct presets.

## Edge-Case & Dependency Audit

**Race conditions**
- A label added and removed between polls: the switch either fired or did not; record which so a re-add is a new request rather than a replay.
- Import filter applied while a delta pull is mid-flight.

**Security**
- The closed vocabulary is the control. Anyone who can label an issue can enqueue work or select a preset from the registry — which is the same authority as moving a card, and bounded by the same review gate. What they cannot do is supply new instructions, and that boundary must be enforced by lookup rather than convention.
- An unrecognised label must be inert. Interpreting the unknown is how a closed set becomes an open one.

**Side effects**
- `remote-control-dispatch-acknowledgment-writeback.md`'s receipt should name which switch fired, so a label-triggered enqueue is visible rather than mysterious.
- `sanitizeTags`' allowlist (`planMetadataUtils.ts:12`) drops unrecognised tags on import; `sb:` labels are switches rather than tags and must not land in the tags field at all.
- The `linear-api` and `clickup-api` protocols document label handling and need the registry listed.

**Migration**
- Additive and off by default. No install changes import scope until the filter is enabled, and the enable step reports what it will do first.

## Dependencies

- **Inherits the vocabulary boundary from** `the-remote-command-vocabulary-is-closed.md`; the registry is that plan's typed switch set expressed in a tracker's labels.
- **Independent of** `linear-oauth-actor-app-for-per-lead-attribution.md`.
- **Coordinate with** the tags mapping: labels that are switches must be excluded from tag import.

## Adversarial Synthesis

Key risks: a preset selector that falls back to label text is the free-text instruction channel the vocabulary plan refuses, reached by a different route; a fuzzy registry match silently selects the wrong preset, which is worse than refusing; the import filter changes what exists, so a silent default flip either starves or floods a board; and a present-and-unconsumed queue label enqueues on every poll. Mitigations: registry lookup with hard refusal and no text fallback; exact normalised matching only; opt-in and off by default with a pre-run count; and edge-triggered switches that record having fired.

## Proposed Changes

1. **A registry of recognised `sb:` labels** with their meanings, one place, provider-neutral.
2. **Import filter** (`sb:switchboard`, configurable, off by default): only labelled issues become candidates. Enabling reports the count it will import before running.
3. **Queue switch** (`sb:queue`): edge-triggered, consumed once, recorded as fired.
4. **Unrecognised `sb:` labels warn once** on the card and are otherwise inert.
5. **Switch labels never enter the tags field.**
6. **Preset selectors** (`sb:prompt:<name>`, `sb:skills:<name>`) — deferred to a second cut, resolved strictly by registry lookup, hard refusal on miss, never a text fallback.
7. **Document the registry** in the `linear-api` and `clickup-api` protocols.

### Migration

Additive, off by default, no import-scope change until enabled, and the enable step is preceded by a count.

## Verification Plan

- **Import filter:** with it on, assert only labelled issues import and the count reported before enabling matched what arrived. With it off, assert current behaviour exactly.
- **No silent flip:** upgrade an install with the filter unset; assert import scope is unchanged.
- **Unimport asymmetry:** remove the filter label from an imported issue; assert the card remains and the behaviour is documented rather than surprising.
- **Queue switch is edge-triggered:** leave `sb:queue` in place across several polls; assert exactly one enqueue. Remove and re-add; assert a second enqueue.
- **Unknown label:** add `sb:qeue`; assert one warning, no action, and no interpretation.
- **No text fallback:** add `sb:prompt:does-not-exist`; assert refusal, and specifically assert the label text never reaches a prompt — the test this plan exists for.
- **Case and provider parity:** `SB:Queue` in Linear and `sb:queue` in ClickUp resolve to the same switch; two distinct presets differing only in case do not collide.
- **Tags isolation:** assert no `sb:` label appears in a plan's tags field.
- **Vocabulary closure:** assert no label path can deliver free text into prompt input, matching the contract test in the vocabulary plan.

## Outstanding Questions

- Should the import filter support a negative form (`sb:ignore`) for workspaces that would rather opt out of a broad existing scope than re-label everything?
- Do preset selectors belong on the issue at all, or on the plan once imported — where the operator can see them beside the plan they affect?
- Is there a case for the queue switch carrying a target (`sb:queue:review`), and does that reintroduce the routing problem this plan retired?
