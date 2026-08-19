# Require a verbatim ## User Instructions section in every authored plan

## Goal

Every plan authored through any Switchboard surface must include a `## User Instructions` section containing the user's original request, all clarifying Q&A pairs, and (for memo-authored plans) the original memo entry text — all verbatim, not paraphrased. This preserves the decision context that shaped the plan so downstream agents (reviewers, coders) don't have to re-derive or guess at user intent.

### Problem Analysis (background + root cause)

**The incident:** A user asked for a "phone friend button." During planning, the agent asked a clarifying question: "Should the button send plans sequentially, or all in one batch?" The user answered "sequentially." The resulting plan contained no mention of this decision — the agent paraphrased it away. The reviewer then had to catch the omission and fix it, which is expensive (a reviewer pass costs a full agent dispatch).

**Root cause:** No authoring surface currently instructs the agent to preserve the user's verbatim input in the plan file. The existing "Plan Authoring & Problem Analysis Protocol" (AGENTS.md / CLAUDE.md) requires documenting "core problems, background context, and root cause analysis" inside `## Goal` — but this is the agent's *analysis*, not the user's *raw input*. The agent is free to synthesize, summarize, and drop the exact words the user said, which is exactly how "sequentially" vanished.

**Why verbatim matters:** A reviewer or coder reading the plan has no access to the planning conversation. If the plan says "send plans to the user" but the user actually said "send them sequentially, one at a time," the coder implements the wrong behavior and the reviewer has to catch it — if they even can, since the decision context is gone. Verbatim preservation is the cheapest possible fix: zero analysis cost at authoring time, and the reviewer/coder sees exactly what the user said without reconstruction.

**Why not just "document decisions":** "Document the decision" is what the agent already thinks it's doing when it writes "the button sends plans" — it *did* document a decision, just not the right one. The verbatim requirement is a stronger constraint: the raw user text must be present, not the agent's interpretation of it. The agent can still add its analysis below the verbatim block, but the verbatim block is the ground truth the reviewer checks against.

**Split-rule self-check:** This is **one plan** — a single coherent change (propagate one rule to all authoring surfaces, guard it with a sync test, update the plan schema). The parts are interdependent, not independently shippable (a surface edit without the sync test → future drift; improve-plan without the backfill variant → existing plans still lose context). Does not meet the 3-deliverables / 2-shippable-phases split threshold.

## Metadata

**Complexity:** 5
**Tags:** docs, reliability, test
**Project:** Browser Switchboard

## User Instructions

**Original request (from user):**
> plans that get written are losing important context. for example, i recently asked for a phone friend button. you (in an earlier session) asked me if the button should send plans sequentially, or all in one batch. i answered sequentially. but the plan contained NO mention of this, because you didn't put it in. now the reviewer is having to fix the omission, which is expensive. the plan authoring methods (memo and chat prompt) need to contain an explicit instruction to always include the user's instructions verbatim in a plan context section so this sort of drift is minimized

**Clarifying Q&A:**

**Q: What should the verbatim-context section be called and where should it sit in the plan schema?**
A: New `## User Instructions` — a dedicated section right after `## Goal`, before `## Metadata`.

**Q: What exactly should be captured verbatim?**
A: Q&A pairs. (User later expanded: also the user's initial statement, and the memo instructions/entry text — not just Q&A pairs.)

**Q: Which surfaces should get this instruction?**
A: All surfaces, but it should not be a blocker. (User's exact words: "i only named memo and chat prompt because improve plan is often run unattended. i guess it should capture in all surfaces, but it should not be a blocker")

**Q: How should improve-plan interact with this section?**
A: Preserve + backfill if possible. If the plan lacks the section but the conversation provides user instructions, backfill them. If no conversation context (unattended), skip silently.

**Follow-up clarification from user:**
> also, capture scope is more than just q a pairs. it is also the memo instructions, and the initial statement from the user in the chat prompt

## User Review Required

YES — explicit user approval is required before implementation, on one gate:

1. **System-file edit gate (Rule 6).** This plan edits `CLAUDE.md`, `AGENTS.md`, `.agents/skills/deep-planning/SKILL.md`, `.agents/skills/improve-plan/SKILL.md`, `.agents/workflows/switchboard-cloud.md`, `.agents/workflows/switchboard-memo.md`, `.agents/workflows/switchboard-remote.md`, `src/services/agentPromptBuilder.ts`, and `src/services/TaskViewerProvider.ts` — all system/config files. The plan documents these edits; it does not perform them. The implementer must obtain the user's explicit permission before touching any of them.

## Complexity Audit

### Routine
- Adding the `## User Instructions` section requirement to the 9 authoring surfaces, using the same propagation pattern already proven by the autosplit rule (see `codify-plan-autosplit-rule-across-authoring-surfaces.md`).
- Updating the plan schema in `improve-plan/SKILL.md`'s required-sections list to include `## User Instructions` between `## Goal` and `## Metadata`.
- Updating the memo planner prompt's "Plan File Format" section in `TaskViewerProvider.ts` to list the new section.
- Creating a companion sync test (`prompt-user-instructions-sync.test.js`) following the exact pattern of `prompt-split-guidance-sync.test.js`.

### Complex / Risky
- **Schema shift.** Inserting `## User Instructions` between `## Goal` and `## Metadata` changes the section order every authoring surface describes. Existing plans won't have the section — the importer/parser must tolerate its absence (verified: the plan watcher reads metadata by key, not by positional order; missing sections are already the norm for older plans). But the *instruction text* in all 9 surfaces must agree on the placement, or agents will produce inconsistent section orders.
- **"Not a blocker" nuance.** The instruction to include the section is mandatory in every surface, but the absence of the section in a plan file must not invalidate the plan or block downstream workflow. The sync test must assert the *instruction is present in each surface*, not that every plan file has the section. improve-plan must backfill when conversation context is available but skip silently when unattended — this conditional behavior must be precisely worded to avoid the agent treating a missing section as an error.
- **Memo surface variant.** In memo mode, the "user instructions" are the memo entry text itself. The memo planner prompt already includes the issue text in the prompt body — but the instruction to carry it verbatim into the plan file's `## User Instructions` section is what's missing. The wording must be clear that the memo entry IS the user instruction, not something to synthesize from.
- **Remote surface variant.** In remote mode (Linear/Notion), the "user instructions" are the card text / issue body / comments. The remote workflow already reads the card body — needs instruction to preserve it verbatim in the plan's `## User Instructions` section.

## Edge-Case & Dependency Audit

- **Race Conditions** — none. All edits are to static text files; no concurrent runtime state.
- **Security** — none. No secrets, no auth surfaces.
- **Side Effects**
  - Agents dispatched through any surface will now produce plans with a new section. This adds length to plan files — the verbatim text can be long for complex planning conversations. This is acceptable: the cost of a longer plan file is negligible compared to the cost of a reviewer re-deriving lost context.
  - The `## User Instructions` section will appear in the plan file before `## Metadata`. The plan watcher / importer reads metadata by key (`**Complexity:**`, `**Tags:**`, `**Project:**`), not by section position, so the new section does not interfere with import. Verified: `agentPromptBuilder.ts` metadata parsing is key-based, not positional.
  - improve-plan's CONTENT PRESERVATION rule (two-tier: factual context never deleted, reasoning outputs corrected with audit marking) must be extended to cover `## User Instructions` as factual context — never delete, never paraphrase. The backfill path is additive only.
  - Duplicate guidance: agents dispatched through the chat prompt AND reading CLAUDE.md/AGENTS.md will see the rule twice. This is the same double-injection already accepted for the autosplit rule — harmless (same rule, same wording), but the protocol-file phrasing must stay tight to avoid noise.
- **Dependencies & Conflicts**
  - The sync-test anchor strings are literal substrings; all surfaces must use the exact section name `## User Instructions` and the word `verbatim`. Copy, don't paraphrase.
  - The existing `prompt-split-guidance-sync.test.js` is a separate concern (split sizing). The new test should be a companion file, not an extension of the existing one — conflating two rules in one test file makes failures ambiguous. Proposed: `src/test/prompt-user-instructions-sync.test.js`.
  - The improve-plan variant must assert the *preserve + backfill* framing, not the *always include* framing — improve-plan can't always backfill (unattended runs have no conversation context). The sync test must scope the improve-plan assertion to the `## Steps` body and check for both "preserve" and "backfill" language.
  - The memo planner prompt variant must assert the *memo entry text* framing, not the *Q&A pairs* framing — memo entries are raw text blocks, not conversations.

## Dependencies

None blocking. Independent of other active work. The propagation-verification sub-item depends on the existing `ensureProtocolFile` + content-hash refresh behaviour already in `extension.ts` — no new code dependency.

## Adversarial Synthesis

Key risks: (1) the "not a blocker" nuance is easy to get wrong — if the instruction is too weak ("try to include"), agents will skip it under output pressure; if too strong ("must include or the plan is invalid"), unattended improve-plan runs will fail on plans that never had the section. The wording must be: "always include when user-side input is available; skip silently when it is not" — and this conditional must be adapted to each surface's register (Hard Rule in chat/cloud, process step in improve-plan, format instruction in memo). (2) The schema shift (new section between Goal and Metadata) could confuse agents that have internalized the old order — but the section-scoped sync test catches this. (3) Verbatim text can be long — but this is a feature, not a bug: the whole point is that the reviewer sees the exact words. (4) The sync test guards the rule's *presence in surfaces*, not *agent compliance* — a green test means the rule is written down, not that plans actually contain the section; the manual end-to-end spot-check (Verification Plan step 5) is the mitigation. Mitigations: precise conditional wording adapted per-surface, companion sync test with five-pattern section-scoped assertions, manual spot-check for compliance, accept longer plan files as the cost of context preservation.

## Proposed Changes

### 1. `src/services/agentPromptBuilder.ts` — `DEFAULT_CHAT_BASE_INSTRUCTIONS`

- **Context:** `DEFAULT_CHAT_BASE_INSTRUCTIONS` begins at line 1425 (the `export const` declaration). The Hard Rules section spans lines 1427-1435 (rules 1-8), with rule 8 (Project Pinning) at line 1435. The Process section starts at line 1437. The sync comment ("must be kept in sync with .agents/workflows/switchboard-cloud.md") is at line 1422. Currently no instruction to preserve user input verbatim.

> **Superseded:** Lines 1397-1420 define the chat planner persona ("Consultation & Planning Mode"). The Process section (step 4: "Plan") is where the agent drafts the plan file.
> **Reason:** Lines 1394-1419 are `DEEP_RESEARCH_DIRECTIVE`, a completely different constant. `DEFAULT_CHAT_BASE_INSTRUCTIONS` starts at line 1425, not 1397. The original line references would send the implementer into the wrong constant.
> **Replaced with:** `DEFAULT_CHAT_BASE_INSTRUCTIONS` begins at line 1425. Hard Rules at lines 1427-1435 (rule 8 = Project Pinning at line 1435). Process section starts at line 1437. Sync comment at line 1422.

- **Logic:** Add a new Hard Rule (or a sub-step under Process step 4) requiring a `## User Instructions` section immediately after `## Goal` and before `## Metadata`, containing verbatim: (a) the user's original request/statement, (b) all clarifying Q&A pairs (agent questions + user answers), and (c) for memo-authored plans, the original memo entry text. State explicitly: "This is not a blocker — a plan is still valid if it lacks the section (e.g. no conversation context) — but it must be included whenever user-side input is available."
- **Implementation:** Insert as a new bullet in the Hard Rules section (after rule 8 at line 1435, as rule 9) OR as a sub-step under Process step 4. The Hard Rules placement is preferred — it's a binding constraint, not a process step. Wording:
  > 9. **Verbatim user instructions.** Every plan must include a `## User Instructions` section immediately after `## Goal` and before `## Metadata`, containing — verbatim, not paraphrased: (a) the user's original request or statement that initiated the plan, (b) all clarifying Q&A pairs (your questions and the user's answers), and (c) for memo-authored plans, the original memo entry text. This preserves the decision context so downstream agents don't re-derive user intent. The section is not a blocker — a plan is still valid without it when no user-side input is available — but it must be included whenever the input exists.
- **Edge Cases:** This is the canonical rule text — the same wording must be propagated (or adapted) to all other surfaces. The sync test anchors on `## User Instructions` and `verbatim`.

### 2. `.agents/workflows/switchboard-cloud.md`

- **Context:** Lines 10-18 define the cloud planner's Hard Rules (rules 1-8), mirroring the chat base instructions. Rule 8 (Project Pinning) is at line 18. Currently no verbatim-user-instructions rule.
- **Logic:** Add the same rule as a new Hard Rule (rule 9), adapted for the cloud context (same wording — the cloud planner has the same conversation access as the chat planner).
- **Implementation:** Insert after rule 8 (Project Pinning) at line 18. Copy the canonical wording from surface 1.
- **Edge Cases:** The cloud workflow is kept in sync with `DEFAULT_CHAT_BASE_INSTRUCTIONS` per the comment at `agentPromptBuilder.ts:1422`. Both must carry the same rule.

### 3. `.agents/workflows/switchboard-memo.md`

- **Context:** Step 4 (lines 53) creates one plan per memo entry. It lists the standard plan format sections but does not mention `## User Instructions`. In memo mode, the "user instructions" are the memo entry text itself.
- **Logic:** Add to step 4's plan-format instruction: "Each plan must include a `## User Instructions` section immediately after `## Goal` and before `## Metadata`, containing the original memo entry text verbatim — not paraphrased or summarized. This is the ground truth the reviewer checks against."
- **Implementation:** Insert into the step-4 paragraph, after the section list that currently names "Goal, Metadata, Complexity Audit, Edge-Case & Dependency Audit, Proposed Changes, Verification Plan." Add `## User Instructions` to that list in the correct position (after Goal, before Metadata).
- **Edge Cases:** The memo entry is raw text, not a Q&A conversation. The wording must say "the original memo entry text," not "clarifying Q&A pairs." The sync test must assert the memo-specific framing.

### 4. `src/services/TaskViewerProvider.ts` — `_buildMemoPlannerPrompt`

- **Context:** `_buildMemoPlannerPrompt` starts at line 6203. The "Plan File Format" section spans lines 6222-6234, listing the required sections (Title, Goal, Metadata, Complexity Audit, Edge-Case & Dependency Audit, Proposed Changes, Verification Plan). The "Instructions" section starts at line 6213 (steps 1-5 at lines 6215-6220). Currently no `## User Instructions` section.

> **Superseded:** Lines 6198-6242 build the memo planner prompt. The "Plan File Format" section (lines 6217-6229) lists the required sections.
> **Reason:** `_buildMemoPlannerPrompt` starts at line 6203, not 6198. The Plan File Format section is at lines 6222-6234, not 6217-6229. The original line references were off by ~5 lines.
> **Replaced with:** `_buildMemoPlannerPrompt` starts at line 6203. Plan File Format section at lines 6222-6234. Instructions section at line 6213 (steps at 6215-6220).

- **Logic:** Add `## User Instructions` to the Plan File Format list (after `## Goal` at line 6226, before `## Metadata` at line 6227), with the instruction: "containing the original issue text verbatim — not paraphrased or summarized." Also update the "Instructions" section (step 2, line 6217) to mention including the issue text verbatim in the new section.
- **Implementation:** Edit the section list at lines 6225-6234 to insert `- ## User Instructions (the original issue text, verbatim — not paraphrased)` between the `## Goal` and `## Metadata` bullets. Add to the Instructions section a step: "Include a `## User Instructions` section with the original issue text verbatim."
- **Edge Cases:** The memo planner prompt is a generated string literal — the sync test asserts on the source file content. The anchor strings must be present in the template literal.

### 5. `.agents/workflows/switchboard-remote.md`

- **Context:** Section 7 (lines 67-107) instructs the remote agent to ground plans in the synced project context. Section 8 (Notion steps) and the Linear equivalent describe writing the plan into the tracker. Currently no verbatim-user-instructions rule.
- **Logic:** Add a rule: "Every plan must include a `## User Instructions` section immediately after `## Goal` and before `## Metadata`, containing — verbatim: (a) the user's original request or statement (the card text, issue body, or comment that initiated the plan), and (b) any clarifying Q&A (comments exchanged during planning). This preserves the decision context for the local execution agent. The section is not a blocker — a plan is still valid without it when no user-side input is available."
- **Implementation:** Insert into the existing `## Plan Sizing & Feature Grouping` section (line 200) as a new paragraph after the Plan Sizing rule — this is where the autosplit rule already lives in the remote workflow, making it the natural sibling for the verbatim-user-instructions rule. The remote variant references "card text / issue body / comments" instead of "chat conversation" since the input channel is the tracker, not a chat.

> **Superseded:** Insert as a new subsection under section 7 or as a new top-level section after section 7.
> **Reason:** The remote workflow already has a `## Plan Sizing & Feature Grouping` section at line 200 — the natural home for plan-authoring rules. Placing the verbatim rule in section 7 (project context grounding) or as an orphan top-level section would separate it from its sibling rule and produce inconsistent placement across surfaces.
> **Replaced with:** Insert into `## Plan Sizing & Feature Grouping` (line 200) as a new paragraph after the Plan Sizing rule.
- **Edge Cases:** Remote plans are written to Linear/Notion, not local `.md` files. The section is still `## User Instructions` in the page body — the local poll reads the body and writes it to the plan file, so the section survives the round trip.

### 6. `AGENTS.md` (repo root, canonical source for the managed block)

- **Context:** Lines 128-137 hold the *Plan Authoring & Problem Analysis Protocol* section. It currently requires documenting "core problems, background context, and root cause analysis" inside `## Goal` — but says nothing about preserving the user's verbatim input.
- **Logic:** Append a **Verbatim User Instructions** rule to the protocol section. Wording (protocol register, tight):
  > **Verbatim User Instructions.** Every plan must include a `## User Instructions` section immediately after `## Goal` and before `## Metadata`, containing the user's original request, all clarifying Q&A pairs, and (for memo-authored plans) the memo entry text — all verbatim, not paraphrased. This preserves the decision context so downstream agents don't re-derive user intent. Not a blocker — a plan is still valid without it when no user-side input is available — but it must be included whenever the input exists.
- **Implementation:** Insert after the existing Plan Sizing rule (which was added by the autosplit plan). Keep phrasing tight — protocol register, not prompt register — to avoid double-injection noise.
- **Edge Cases:** `AGENTS.md` is the single source of truth for the `ensureProtocolFile` managed block. Editing it propagates to every workspace's `AGENTS.md` and `CLAUDE.md` on next activation.

### 7. `CLAUDE.md` (repo root)

- **Context:** `CLAUDE.md` is generated from `AGENTS.md` plus the Claude preamble via `ensureProtocolFile`. It is NOT hand-edited.
- **Logic:** No direct edit. The `AGENTS.md` edit above flows through `buildManagedInner` into `CLAUDE.md` automatically.
- **Implementation:** Verify after the `AGENTS.md` edit that the next `scaffoldProtocolLayers` pass produces a `CLAUDE.md` whose managed block contains `## User Instructions` and `verbatim`. Do NOT edit `CLAUDE.md` by hand.
- **Edge Cases:** If a workspace's `CLAUDE.md` has a malformed managed block, `ensureProtocolFile` returns `failed` and skips the update — check the scaffold log.

### 8. `.agents/skills/deep-planning/SKILL.md`

- **Context:** Phase 0 (lines 15-42) proposes the planning approach and asks clarifying questions. Phase 4 (lines 80-91) generates the plan. The Plan Sizing rule was added to Phase 0 by the autosplit plan. Currently no verbatim-user-instructions rule.
- **Logic:** Add to Phase 4 (Synthesis and Plan Generation) a requirement: "The plan must include a `## User Instructions` section immediately after `## Goal` and before `## Metadata`, containing — verbatim: (a) the user's original request, (b) all clarifying Q&A pairs from Phase 0, and (c) any follow-up answers. Not a blocker, but must be included when user-side input is available."
- **Implementation:** Insert as a new item in the Phase 4 "Plan structure" list (lines 83-91), or as a sub-step after the plan structure list. Use the exact section name and `verbatim` keyword.
- **Edge Cases:** The sync test must assert the signals appear inside Phase 4 (or Phase 0), not just file-wide — same scoping approach as the autosplit test.

### 9. `.agents/skills/improve-plan/SKILL.md`

- **Context:** The required-sections list (lines 35-74) defines the plan schema. CONTENT PRESERVATION (lines 7-14) governs what may be deleted/corrected. Step 2 (line 29) is the scope-assessment step. Currently no `## User Instructions` section in the schema, and no preserve/backfill rule.
- **Logic:** Three changes:
  1. **Add `## User Instructions` to the required-sections list** (between `## Goal` at position 1 and `## Metadata` at position 2). Mark it as: "Containing the user's original request, all clarifying Q&A pairs, and (for memo-authored plans) the memo entry text — verbatim. Required when user-side input is available; omit silently when no conversation context exists (e.g. unattended runs)."
  2. **Extend CONTENT PRESERVATION:** Add `## User Instructions` to the "Factual context — NEVER delete" tier. The verbatim user text is factual context — it must never be paraphrased, summarized, or removed. If the section is present, preserve it exactly.
  3. **Add a backfill step** to the `## Steps` body (between Step 1 "Load the plan" and Step 2 "Assess scope"): "If the plan lacks a `## User Instructions` section and the current conversation provides user-side input (original request, clarifying Q&A), backfill the section with that input verbatim. If no conversation context is available (unattended run), skip silently — do not block or flag."
- **Implementation:** Insert the section into the required-sections numbered list as item 2 (shifting Metadata to 3, etc.). Add the CONTENT PRESERVATION bullet. Add the backfill step between Steps 1 and 2.
- **Edge Cases:** The sync test must assert: (a) `## User Instructions` appears in the required-sections list, (b) "preserve" or "NEVER delete" language appears in the CONTENT PRESERVATION section, (c) "backfill" language appears in the `## Steps` body. All three assertions scoped to their respective sections.

### 10. `src/test/prompt-user-instructions-sync.test.js` (NEW FILE)

- **Context:** The existing `prompt-split-guidance-sync.test.js` guards the autosplit rule across 9 surfaces. A companion test file should guard the verbatim-user-instructions rule across the same 9 surfaces. Separate file — conflating two rules in one test makes failures ambiguous.
- **Logic:** Follow the exact pattern of `prompt-split-guidance-sync.test.js`. The existing test uses **five different extraction patterns** — the new test must replicate this approach with different anchor strings:
  1. **Template-literal body extraction** for `DEFAULT_CHAT_BASE_INSTRUCTIONS`: regex `/export const DEFAULT_CHAT_BASE_INSTRUCTIONS = \`([\s\S]*?)\`;\n/` to scope assertions to the prompt text, not the rest of `agentPromptBuilder.ts`.
  2. **Step-4 regex extraction** for `switchboard-memo.md`: regex `/^4\. \*\*Create one plan per entry\.\*\*([\s\S]*?)(?=\n5\. )/m` to scope to the plan-creation step.
  3. **Phase 0 regex extraction** for `deep-planning/SKILL.md`: regex `/### Phase 0: Planning Proposal([\s\S]*?)(?=### Phase 1)/` to scope to the executable Phase 0 body (or Phase 4 if the rule is placed there instead).
  4. **Steps-body regex extraction** for `improve-plan/SKILL.md`: regex `/## Steps([\s\S]*?)(?=\n## )/` for the backfill assertion. **Plus** separate extraction of the required-sections list and the CONTENT PRESERVATION section for the other two improve-plan assertions — three scoped assertions total, each using a section-scoped regex match, not file-wide `includes`.
  5. **File-wide `includes`** for `AGENTS.md` and `CLAUDE.md` (protocol files — no section scoping needed).
  - Surface-specific framing assertions (in addition to the anchor strings `## User Instructions` and `verbatim`):
    - Chat base / cloud / remote: assert "original request" and "clarifying Q&A" language.
    - Memo workflow / memo planner: assert "memo entry text" or "issue text" language (not "Q&A pairs").
    - improve-plan: assert "preserve" in CONTENT PRESERVATION section, "backfill" in Steps body, `## User Instructions` in required-sections list — three separate scoped assertions.
    - AGENTS.md / CLAUDE.md: file-wide `includes` for `## User Instructions` and `verbatim`.
  - Report the surface count in the final log line.
- **Implementation:** Copy the structure of `prompt-split-guidance-sync.test.js`, replace the anchor strings and assertions. The file paths and read logic are identical. The five extraction patterns above are the critical structural detail — "copy the structure" means replicate the scoping approach, not just the file-reading boilerplate.
- **Edge Cases:** The improve-plan assertions are the most complex — three separate scoped assertions (required-sections list, CONTENT PRESERVATION, Steps body). Each must use a section-scoped regex match, not file-wide `includes`.

### 11. Verification — propagation to existing workspaces

- **Context:** Same as the autosplit plan's Step 4. `ensureProtocolFile` compares the managed block's inner content and rewrites on diff. Skills/workflows get the same treatment via content-hash refresh loops.
- **Logic:** After edits land in the canonical repo files, activate the extension in an existing workspace and confirm:
  1. `scaffoldProtocolLayers` reports `updated` (not `skipped`) for `AGENTS.md` / `CLAUDE.md`.
  2. The content-hash loop refreshes the two skill files (`agentsChanged = true`).
  3. Grep the refreshed workspace's files for `## User Instructions` and `verbatim` — present in all 9 surfaces.
- **Implementation:** Run the new sync test: `node src/test/prompt-user-instructions-sync.test.js`. Then manually verify propagation in an existing workspace.
- **Edge Cases:** If any workspace reports `failed` (malformed managed block) or `skipped` despite a content diff, a targeted manual reconcile is warranted for that workspace only.

## Verification Plan

### Automated Tests
- `node src/test/prompt-user-instructions-sync.test.js` passes with all 9 surfaces in sync. Run manually post-implementation (no automated test runner per session directive).
- `node src/test/prompt-split-guidance-sync.test.js` still passes (the new changes must not break the existing sync test — the two rules are independent).

### Manual Verification
1. Grep each of the 9 surfaces for `## User Instructions` and `verbatim` — present in all.
2. Surface-specific framing checks:
   - Chat base / cloud / remote: contain "original request" and "clarifying Q&A".
   - Memo workflow / memo planner: contain "memo entry text" or "issue text".
   - improve-plan: contains "preserve" in CONTENT PRESERVATION, "backfill" in Steps body, `## User Instructions` in required-sections list.
   - deep-planning: contains the rule inside Phase 0 or Phase 4 (section-scoped).
3. Scaffold a fresh workspace → its `CLAUDE.md`/`AGENTS.md` carry the rule (created path).
4. Activate the extension in an existing workspace → `scaffoldProtocolLayers` reports `updated` for `AGENTS.md`/`CLAUDE.md`; grep confirms the signals landed.
5. **End-to-end spot-check:** Start a planning chat, ask for a feature with a clarifying question (e.g. "should it do X or Y?"), answer "Y". Verify the resulting plan file has a `## User Instructions` section containing the original request and the Q&A pair verbatim — including the "Y" answer.
6. **improve-plan spot-check:** Run improve-plan on a plan that lacks `## User Instructions` while conversation context is available → the section is backfilled. Run improve-plan unattended on a plan that lacks the section → no error, no flag, plan is still valid.
7. **Sync-test scoping spot-check:** Temporarily move the improve-plan signal strings out of `## Steps` into a comment → the scoped assertion fails (proves the test catches a buried rule). Restore.
