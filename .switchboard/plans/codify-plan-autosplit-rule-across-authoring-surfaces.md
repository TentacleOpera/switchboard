# Codify the plan auto-split rule across ALL plan-authoring surfaces

## Goal

Make the **plan auto-split rule** (split into separate plans on 3+ distinct deliverables OR 2+ independently-shippable phases; offer to group 3+ plans into a feature) reach **every** agent that authors plans — not just the ones dispatched through the chat/workflow prompts. Add it to the always-on instruction files and the non-chat authoring skills, and extend the existing sync test to guard the new surfaces so it can't silently drift back out.

### Problem Analysis (background + root cause)

The rule already exists and is deliberately kept in sync across **5 surfaces**, guarded by `src/test/prompt-split-guidance-sync.test.js`:
1. `DEFAULT_CHAT_BASE_INSTRUCTIONS` (`src/services/agentPromptBuilder.ts:849-869`) — the chat planner persona ("Consultation & Planning Mode")
2. `.agents/workflows/switchboard-cloud.md`
3. `.agents/workflows/switchboard-memo.md`
4. `_buildMemoPlannerPrompt` (`src/services/TaskViewerProvider.ts`)
5. `.agents/workflows/switchboard-remote.md`

**Root cause of the gap:** all 5 are **dispatched-prompt** surfaces — an agent only receives them when it's launched through the board chat, a workflow, or the memo planner. An agent that authors plans by **any other path never sees the rule**:
- a CLI / headless agent writing plan files directly into `.switchboard/plans/` (this is what happened — a complexity-8, 7-phase Canvas feature was authored as a single mega-plan);
- the **`improve-plan`** and **`deep-planning`** skills, which author/strengthen plans but carry no split-scope guidance;
- any agent reading only the project's **CLAUDE.md / AGENTS.md**, whose *Plan Authoring & Problem Analysis Protocol* section (`AGENTS.md:126-131`) says nothing about sizing/splitting.

So the durable fix is to extend the same synced-surface pattern to the **always-on instruction files** (CLAUDE.md, AGENTS.md) and the **authoring skills** (improve-plan, deep-planning), then grow the sync test to cover them.

**Split-rule self-check (dogfooding):** this is **one plan** — a single coherent change (propagate one rule to the surfaces that miss it, guard it, reconcile copies). The parts are interdependent, not independently shippable (docs edit without the sync test → future drift; without reconcile → existing workspaces still miss it), so it does not meet the 3-deliverables / 2-shippable-phases split threshold.

## Metadata

**Tags:** docs, reliability, test
**Complexity:** 5

## User Review Required

YES — explicit user approval is required before implementation, on two independent gates:

1. **System-file edit gate (Rule 6).** Steps 1, 1b, and 2 edit `CLAUDE.md`, `AGENTS.md`, `.agents/skills/deep-planning/SKILL.md`, and `.agents/skills/improve-plan/SKILL.md` — all system/config files. The plan documents these edits; it does not perform them. The implementer must obtain the user's explicit permission before touching any of them.
2. **Behavioural-change gate (Step 1b).** Step 1b is **not** pure propagation — it changes the canonical rule text of the feature-creation gate from unconditional confirm to *conditional on who initiated grouping*. This edits `DEFAULT_CHAT_BASE_INSTRUCTIONS` step 5 (`src/services/agentPromptBuilder.ts:869`) and therefore ripples to all 5 existing synced surfaces. It must be approved **separately** from the propagation approval; a blanket "yes, codify the rule" does not cover it. If the user declines the behavioural change, drop Step 1b and keep the gate text as-is (the sync anchors for the existing surfaces stay unchanged).

## Complexity Audit

### Routine
- Copying the two canonical signal strings (`3+ distinct deliverables`, `2+ independently-shippable phases`), the single-plan carve-out, and the 3+-plans→offer-feature step into `CLAUDE.md` / `AGENTS.md`'s *Plan Authoring & Problem Analysis Protocol* section (`AGENTS.md:126-131`).
- Adding the full auto-split rule to `deep-planning/SKILL.md` (assess scope before drafting; write separate plan files; offer feature grouping).
- Adding the flag-and-recommend variant to `improve-plan/SKILL.md`'s `## Steps` body.
- Extending `prompt-split-guidance-sync.test.js` with new surface assertions — the test already has a per-surface block pattern to copy.

### Complex / Risky
- **Sync-test scoping.** The test must assert the signals appear in the **executable body** of each skill (improve-plan `## Steps`; deep-planning `Phase 0`/`Phase 4`), not just anywhere in the file — otherwise a green test can coexist with a rule the agent never reaches. This is a new assertion shape, not a copy of the existing `file.includes(...)` pattern.
- **Step 1b behavioural change** to the canonical gate text — ripples to all 5 existing surfaces and changes agent UX (see User Review Required gate 2).
- **Verifying the propagation path actually delivers the new text** to existing workspaces on next activation — depends on `ensureProtocolFile` and the content-hash refresh loops behaving as read in `extension.ts:3289-3414` and `extension.ts:340-410`.

## Edge-Case & Dependency Audit

- **Race Conditions** — none. All edits are to static text files; no concurrent runtime state.
- **Security** — none. No secrets, no auth surfaces.
- **Side Effects**
  - Agents dispatched through the 5 existing surfaces will now *also* read `CLAUDE.md`'s copy of the rule (always-on file). Duplicate guidance is harmless (same rule, same wording), but `CLAUDE.md`'s phrasing must stay tight so it reads as protocol, not a repeated prompt — otherwise the agent sees the rule twice in the same dispatch and may treat one as redundant noise.
  - Step 1b changes the gate UX for *every* dispatched planner, not just the new surfaces — a user who has internalised "I will be asked to confirm feature creation" now gets auto-creation when they previously asked for grouping. Behavioural regression risk on the original 5 surfaces.
- **Dependencies & Conflicts**
  - ~~`switchboard-split` is named in Step 2 as `improve-plan`'s escape hatch.~~ **Verified:** `switchboard-split` does **not exist** as a skill — it is listed at `extension.ts:3617` as a **retired workflow** being cleaned up, with no `SKILL.md` and no model-invocable registration. Step 2 must NOT name it. Use `create-feature-from-plans` (confirmed model-invocable) + manual split as the escape hatch.
  - The sync-test anchor strings are literal substrings; the new surfaces must use the exact casing/wording. Copy, don't paraphrase.
  - The improve-plan variant must not assert the *auto-split* framing in the test (improve-plan can't write new files mid-improve) — assert the *presence of the signals* plus the flag-and-recommend framing, scoped to the `## Steps` body.
  - **Step 1b vs memo invariant — verified safe.** The sync test's memo guards (`prompt-split-guidance-sync.test.js:111-141`) assert memo step-4 has the signals + "Before writing" + "no orphan plans", and step-5 does NOT mention "split". They do **not** assert gate wording. The chat-base step 5 and memo step 5 are separate files with separate step numbering (memo step 5.e has its own gate text at `switchboard-memo.md:59`). Rewriting chat-base step 5 to conditional-on-initiator does not touch the memo invariant or its sync-test assertions. The memo workflow's step 5.e *could* be updated for consistency but is not required by the sync test.

## Dependencies

None blocking. Independent of the Canvas and ClickUp work. The propagation-verification sub-item (Step 4) depends on the existing `ensureProtocolFile` + content-hash refresh behaviour already in `extension.ts` — no new code dependency.

## Adversarial Synthesis

Key risks: (1) the sync test asserts *presence* of signal strings, so a green test can coexist with a rule buried in a section the agent never executes — must scope assertions to the executable skill body; (2) Step 1b is a behavioural change to the canonical gate text masquerading as propagation, rippling to all 5 existing surfaces — needs its own approval gate; (3) the original Step 4 premise (propagation freeze / `overwrite:false`-only) was wrong — the freeze is already fixed by `ensureProtocolFile` content-equality refresh and the content-hash skill/workflow loops, so Step 4 must verify-not-reconcile. Mitigations: scoped sync assertions, separate approval gate for 1b, superseded Step 4 replaced with a verification step.

## Proposed Changes

### `AGENTS.md` (repo root, canonical source for the managed block)
- **Context:** `AGENTS.md:126-131` holds the *Plan Authoring & Problem Analysis Protocol* section. It currently documents problem-analysis requirements but no sizing/splitting rule. `AGENTS.md` is the single source of truth for the `ensureProtocolFile` managed block (`extension.ts:3295`) — editing it propagates to every workspace's `AGENTS.md` and `CLAUDE.md` on next activation.
- **Logic:** Append a **Plan Sizing** rule to the existing protocol section. Wording copied verbatim from `DEFAULT_CHAT_BASE_INSTRUCTIONS` step 3 (`agentPromptBuilder.ts:864-867`): the two signals (`3+ distinct deliverables`, `2+ independently-shippable phases`), the "write each as a separate plan file" instruction, the single-plan carve-out ("If the user explicitly asks for a single plan, respect that and write one."), and the 3+-plans→offer-feature step pointing to `create-feature-from-plans`.
- **Implementation:** Insert after `AGENTS.md:131` (the last bullet of the protocol section). Keep phrasing tight — protocol register, not prompt register — to avoid the double-injection noise called out in Edge-Case & Dependency Audit.
- **Edge Cases:** The managed-block scaffolder compares inner-block content and rewrites on diff (`extension.ts:3371-3389`), so this edit reaches existing workspaces on next activation without manual reconcile.

### `CLAUDE.md` (repo root)
- **Context:** `CLAUDE.md` is generated from `AGENTS.md` plus the Claude preamble via `ensureProtocolFile` with `preamble: CLAUDE_PREAMBLE` (`extension.ts:3430-3441`). It is **not** hand-edited — the managed block is the bundled `AGENTS.md` body.
- **Logic:** No direct edit. The `AGENTS.md` edit above flows through `buildManagedInner(sourceContent, preamble)` (`extension.ts:3308`) into `CLAUDE.md` automatically.
- **Implementation:** Verify after the `AGENTS.md` edit that the next `scaffoldProtocolLayers` pass produces a `CLAUDE.md` whose managed block contains both signal strings. Do **not** edit `CLAUDE.md` by hand — that would be overwritten by the scaffolder and is a Rule-6 violation.
- **Edge Cases:** If a workspace's `CLAUDE.md` has a malformed/partial managed block, `ensureProtocolFile` returns `failed` (`extension.ts:3352-3357`) and skips the update — the implementer must check the scaffold log for `failed` statuses on the target workspaces.

### `.agents/skills/deep-planning/SKILL.md`
- **Context:** `deep-planning/SKILL.md` authors plans from scratch (Phases 0–4, lines 15-87). It currently has no split-scope guidance. The skill file is seeded into workspaces via the content-hash refresh loop at `extension.ts:340-360`.
- **Logic:** Add the **full auto-split rule** as a sub-step of `Phase 0: Planning Proposal` (line 15) — assess scope *before* drafting; if 3+ deliverables or 2+ shippable phases, write separate plan files (each with its own Goal, Metadata, Verification Plan); if 3+ plans result, offer to group via `create-feature-from-plans`. Include the single-plan carve-out verbatim.
- **Implementation:** Insert the rule block immediately after the `Phase 0` heading body, before `Phase 1`. Use the exact signal strings.
- **Edge Cases:** The sync test must assert the signals appear inside the `Phase 0` (or `Phase 4: Synthesis and Plan Generation`) section, not just file-wide — see sync-test step.

### `.agents/skills/improve-plan/SKILL.md`
- **Context:** `improve-plan/SKILL.md` is single-plan and deliberately non-destructive (`## Critical Constraints`, lines 5-17; defers restructuring to `improve-feature`). It cannot retroactively split a plan mid-improve. The skill file is seeded via the same content-hash refresh loop.
- **Logic:** Add the **flag-and-recommend variant** to the `## Steps` body (lines 22+), *not* to comments or preamble: "If the plan being improved covers 3+ distinct deliverables or 2+ independently-shippable phases, surface that in chat and recommend splitting (write separate plan files for each deliverable/phase) or promoting to a feature via `create-feature-from-plans` — do not silently strengthen a mega-plan." This respects improve-plan's non-destructive contract while closing the gap. (Note: `switchboard-split` is a retired workflow, not a model-invocable skill — do not name it; the agent recommends a manual split or `create-feature-from-plans`.)
- **Implementation:** Insert as a new step between "Load the plan" (Step 1) and "Improve the plan" (Step 2), so the size check runs before strengthening. Use the exact signal strings.
- **Edge Cases:** The sync test must assert the signals appear inside the `## Steps` block, and must NOT assert the auto-split framing (improve-plan can't write new files mid-improve) — assert presence + flag-and-recommend framing only.

### `src/services/agentPromptBuilder.ts` (Step 1b — behavioural change, separate approval gate)
- **Context:** `DEFAULT_CHAT_BASE_INSTRUCTIONS` step 5 (line 869) is the canonical feature-creation gate. Current text: "Only create the feature if the user confirms." This is unconditional — a user who already asked "should this be a feature?" must confirm a second time after the split.
- **Logic:** Make the gate **conditional on who initiated grouping**:
  - **User already expressed feature/grouping intent (or explicitly asks)** → split AND create the feature as one action (invoke `create-feature-from-plans` without a second confirm — the original ask *is* the confirmation).
  - **Agent is proposing grouping the user did not request** → keep the offer-and-wait gate (creating board structure unprompted warrants a confirm).
- **Implementation:** Edit the step-5 text at `agentPromptBuilder.ts:869`. Because this is the canonical rule text, the same wording change must be applied to all 5 existing synced surfaces (cloud, memo, remote workflows, memo planner) and the sync-test anchors updated to match the new conditional wording.
- **Edge Cases:** This is a behavioural regression on the original 5 surfaces — gate 2 of User Review Required must be approved before this step runs. If declined, drop this step entirely and leave the gate text as-is.

### `src/test/prompt-split-guidance-sync.test.js`
- **Context:** The test (lines 1-199) currently asserts the 5 dispatched-prompt surfaces carry the signal strings. It uses `file.includes(...)` (file-wide) for most surfaces and section-scoped regex for the memo step-4/step-5 invariant (lines 111-141).
- **Logic:** Grow from 5 to ~9 surfaces. Add assertion blocks for `CLAUDE.md`, `AGENTS.md`, `.agents/skills/deep-planning/SKILL.md`, `.agents/skills/improve-plan/SKILL.md`. **Scope the skill assertions to the executable body** — for improve-plan, assert the signals appear inside the `## Steps` block (regex capture between `## Steps` and the next `## `); for deep-planning, assert they appear inside `Phase 0` or `Phase 4`. For `AGENTS.md`/`CLAUDE.md`, file-wide `includes` is sufficient (the managed block is the executable protocol). Update the final log line (line 191) to report the new surface count.
- **Implementation:** Add a new `===` section block per new surface following the existing pattern (lines 39-104). For the two skill files, use a section-scoped regex match analogous to the memo step-4 pattern (line 111). If Step 1b is approved, update the existing surface assertions to match the new conditional gate wording.
- **Edge Cases:** The improve-plan assertion must check for the *signals* + flag-and-recommend framing, NOT the auto-split framing — improve-plan's variant is deliberately different. A single `includes(DISTINCT_DELIVERABLES)` is necessary but not sufficient; add an assertion for the flag-and-recommend phrasing (e.g. `recommend splitting` or `do not silently strengthen`). The assertion must NOT reference `switchboard-split` (retired — does not exist as a skill).

### Step 4 — Verify propagation to existing workspaces (NOT a manual reconcile)

> **Superseded:** Step 4 as originally written: "Reconcile existing workspace copies (the propagation freeze) — CLAUDE.md/AGENTS.md/`.agents`/`.claude` are scaffolded into each workspace once, with `overwrite:false`, so editing the canonical repo files reaches new workspaces but not existing ones (the known freeze). Identify the scaffolding owner and apply the content-hash refresh fix, OR a one-time rsync reconcile."
>
> **Reason:** The premise is factually wrong against the current codebase. `ensureProtocolFile` (`extension.ts:3289-3414`) compares the existing managed block's inner content against the bundled source and **rewrites the block in place when content differs** (lines 3371-3389) — this is content-equality refresh, not `overwrite:false`-only. Skills and workflows get the same treatment via the content-hash refresh loops at `extension.ts:340-360` (skills) and `extension.ts:374-406` (workflows), which overwrite when `srcHash !== destHash`. The "known freeze" described in the original step was real before the hash-refresh landed but is already fixed. Proposing a "one-time rsync reconcile" would ship a no-op, and proposing "content-hash refresh as the real fix" describes code that already exists.
>
> **Replaced with:** A **verification-only** step:
> 1. After Steps 1–3 land in the canonical repo files, activate the extension in an existing workspace (e.g. the Gitlab copy) and confirm `scaffoldProtocolLayers` reports `updated` (not `skipped`) for `AGENTS.md` / `CLAUDE.md`, and the content-hash loop reports `agentsChanged = true` for the two skill files.
> 2. Grep the refreshed workspace's `CLAUDE.md`, `AGENTS.md`, `.agents/skills/deep-planning/SKILL.md`, `.agents/skills/improve-plan/SKILL.md` for both signal strings — present.
> 3. If any workspace reports `failed` (malformed managed block — `extension.ts:3352`) or `skipped` despite a content diff (hash mismatch / read error), **then** a targeted manual reconcile is warranted for that workspace only — not a blanket rsync. Document any such workspace as a follow-up.

## Verification Plan

### Automated Tests
- `node src/test/prompt-split-guidance-sync.test.js` passes with the expanded surface set (reports ~9 surfaces in sync). **Skip** — no automated tests run per session directive; the implementer runs this manually post-implementation.

### Manual Verification
1. Grep each new surface for both signal strings — present in `CLAUDE.md`, `AGENTS.md`, `deep-planning/SKILL.md` (in `Phase 0`/`Phase 4`), `improve-plan/SKILL.md` (in `## Steps`).
2. Scaffold a **fresh** workspace → its `CLAUDE.md`/`AGENTS.md` carry the rule (created path, `extension.ts:3324-3336`).
3. Activate the extension in an **existing** workspace (e.g. Gitlab) → `scaffoldProtocolLayers` reports `updated` for `AGENTS.md`/`CLAUDE.md` and the content-hash loop refreshes the two skill files; grep confirms the signals landed (proves the propagation path works, replacing the superseded reconcile step).
4. **Sync-test scoping spot-check**: temporarily move the improve-plan signal strings out of `## Steps` into a comment → the new scoped assertion fails (proves the test catches the goal-vs-appearance gap). Restore.
5. **Behavioural spot-check (Step 1b only, if approved)**: a fresh planning agent given a clearly multi-deliverable request, where the user's first message already says "group these into a feature," splits AND creates the feature without a second confirm; the same agent, given no grouping intent, still offers-and-waits.
6. **Behavioural spot-check (Step 1b declined)**: a fresh planning agent given a clearly multi-deliverable request proposes separate plans + offers a feature, without being told the rule inline; the offer-and-wait gate is unchanged.

## Definition of Done
- The auto-split rule (both signals + single-plan carve-out + 3+-plans→offer-feature) is present in `AGENTS.md` (and therefore `CLAUDE.md` via the managed-block scaffolder) and the `deep-planning` skill's `Phase 0`/`Phase 4`; `improve-plan` carries the flag-and-recommend variant in its `## Steps` body.
- `prompt-split-guidance-sync.test.js` guards all new surfaces with **section-scoped** assertions for the two skills and passes.
- Existing workspace copies are refreshed on next activation via the existing `ensureProtocolFile` + content-hash refresh paths (verified, not manually reconciled).
- No behavioural regression in the original 5 surfaces — *unless* Step 1b is explicitly approved, in which case the gate-behaviour change is the intended new behaviour and the 5 surfaces are updated to match.
