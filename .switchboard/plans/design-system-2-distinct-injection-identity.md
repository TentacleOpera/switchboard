# Plan: Design System #2 — Give the Design System Its Own Injection Identity (Distinct from the PRD)

## Goal
Stop injecting the active design-system doc into agent prompts under the label **"PROJECT PRD REFERENCE"**. Emit it instead as a clearly-labeled **DESIGN SYSTEM** block, framed as *how the UI must look and behave* (tokens, components, styling conventions) — explicitly complementary to, and separate from, the PRD's *what to build*. Once the design system and the PRD occupy distinct, honestly-labeled prompt slots, a project can carry both without them colliding, and every later plan in this set has a correctly-identified block to feed.

### Problem Context
A project needs **both** a PRD (product requirements — what to build) and a design system (visual/UI system — how it should look). The codebase currently conflates them: the active design-system doc is injected under the header `PROJECT PRD REFERENCE` with the text "The following project PRD provides the product requirements and design specifications" (`src/services/agentPromptBuilder.ts:1157` and `:1162` for the planner; `:1854`–`:1857` for the custom-agent addon block in `buildCustomAgentPrompt`). Meanwhile the *real* PRD is injected separately and correctly as `PROJECT REQUIREMENTS (PRD)` (`:611`–`:616`, emitted via `buildPrdReferenceBlockFromRefs` at `:607`). So the design system is presented to agents as a second, redundant PRD — which is why it fails to function as a design system, especially when an agent is asked to work on HTML/UI.

**Clarification (verified):** both mislabeled injections live in the two prompt builders — the planner branch of the canonical `buildKanbanBatchPrompt` (`:1155`–`:1162`) and the custom-agent path `buildCustomAgentPrompt` (`:1854`–`:1857`). `AgentSkillExporter` already labels its export honestly (`### Design System Document`, `AgentSkillExporter.ts:313`) and needs no change here.

### Root Cause Analysis
- **Mislabeling:** the design-system doc reuses the PRD framing string rather than a design-system-specific framing.
- **Slot collision:** because both are called "PRD", an agent receiving both a real PRD and a design system sees two "PRD" blocks with overlapping intent, diluting each.

## Metadata
- **Tags:** backend, refactor
- **Complexity:** 3

## User Review Required
- **None.** Block header and framing are approved as: header **`DESIGN SYSTEM`**, framing "The following is the project's design system — the visual and UI conventions (tokens, components, layout, interaction patterns) this work MUST conform to. It complements the PRD (which defines what to build); the design system defines how it must look and behave."

## Complexity Audit

### Routine
- Extract a `buildDesignSystemBlock({ link, content })` helper in `src/services/agentPromptBuilder.ts` that emits the new `DESIGN SYSTEM` framing (paralleling the existing `buildPrdReferenceBlockFromRefs` at `:607`).
- Replace the two planner injections (`:1155`–`:1162`) and the custom-agent addon injection (`:1854`–`:1857`) with calls to the new helper.

### Complex / Risky
- The addon field names (`designSystemDocLink`, `designSystemDocContent`) MUST stay unchanged — they are the carrier from config/UI (`agentConfig.ts:44`–`:45`, normalized at `:236`–`:240`; exported at `AgentSkillExporter.ts:123`–`:124`). Only the *emitted prompt text* changes. Do not rename the fields (that would ripple into `agentConfig.ts`, `DesignPanelProvider.ts`, `kanban.html` addon wiring, and `AgentSkillExporter`).
- Design the helper signature to accommodate what #3 and #5 need next: an optional `mode` (author vs. review framing) and an optional structured-token payload. Getting the shape right here avoids re-opening the helper twice.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — this is a pure string-builder change with no async paths, no persistence, and no message protocol.
- **Security:** Design-system content is injected verbatim into prompts — the same trust boundary already accepted for the constitution and PRD blocks (content originates from the user's own configured files). The relabel does not widen it.
- **Side Effects:** Any downstream consumer pattern-matching on the literal `PROJECT PRD REFERENCE` header over the design-system slot would break — none exists in-repo (verified: the string occurs only at the two injection sites). Prompt text changes are visible to users who diff copied prompts.
- **Dependencies & Conflicts:** #3 (tokens), #4 (per-project refs), #5 (mode/all-roles) and #6 (copy button) all build on `buildDesignSystemBlock` — its signature is this plan's contract with the rest of the set: `{ link?, content?, mode?: 'author' | 'review', tokens? }`, with `mode`/`tokens` accepted-but-unused here. No other subtask edits these two injection sites, so no merge-order contention.

## Dependencies
- **None** (foundation plan, parallel with #1). #1 makes the artifact viewable; this makes the prompt block honest. They touch disjoint files and can be built concurrently.
- Plans #3 (token extraction), #5 (inject into every prompt) and #6 (copy prompt button) all build on the `buildDesignSystemBlock` helper introduced here.
- Independently shippable: relabeling improves agent output on its own even if nothing else lands.

## Adversarial Synthesis
Key risks: (1) accidentally renaming the addon carrier fields and rippling into four other files — mitigated by the explicit fields-frozen constraint; (2) getting the helper signature wrong and re-opening it in #3/#5 — mitigated by reserving `mode` and `tokens` parameters now; (3) wording-only regressions (two PRD-labeled blocks surviving somewhere) — mitigated by asserting the header strings in tests. Pure prompt-text change; no config, schema, or persistence surface.

## Proposed Changes

### `src/services/agentPromptBuilder.ts`
1. Add `buildDesignSystemBlock(opts: { link?: string; content?: string; mode?: 'author' | 'review'; tokens?: unknown }): string` returning the `DESIGN SYSTEM` framing (content variant when pre-fetched, link variant otherwise). `mode` and `tokens` may be accepted-but-unused here; #3 and #5 populate them.
2. Planner path (`:1155`–`:1162`, inside `buildKanbanBatchPrompt`'s planner branch): replace the inline `PROJECT PRD REFERENCE` strings with `plannerPrompt += buildDesignSystemBlock({ link: designSystemDocLink, content: designSystemDocContent })`.
3. Custom-agent path (`buildCustomAgentPrompt`, `:1854`–`:1857`): replace the inline `PROJECT PRD REFERENCE` strings with the same helper.

## Verification Plan

### Automated Tests
- `npm run compile` — confirm the bundle builds.
- Assert the design-system block header is `DESIGN SYSTEM` and NOT `PROJECT PRD REFERENCE`, and that a real PRD block still emits `PROJECT REQUIREMENTS (PRD)`.
- Assert no remaining occurrence of the string `PROJECT PRD REFERENCE` is reachable from the design-system code path.

### Manual Verification
1. Configure an active design-system doc and dispatch a planner — inspect the generated prompt and confirm the `DESIGN SYSTEM` header (not `PRD`).
2. With BOTH a project PRD and a design-system doc configured, confirm the prompt contains two distinct, correctly-labeled blocks.
3. Dispatch a custom-column agent and confirm its prompt carries the `DESIGN SYSTEM` block with the new framing.

## Risk Assessment
- **Low.** Pure prompt-text/labeling change behind a new helper; no config, schema, or persistence changes. Risk is limited to wording; mitigated by keeping field names intact and asserting headers in tests.

**Recommendation:** Send to Intern

> **Superseded:** Recommendation: Send to Coder.
> **Reason:** Complexity is 3, and the routing rubric maps 1–3 to Intern. The work is a specified-signature helper extraction plus two call-site swaps in one file; the signature contract is already written down above.
> **Replaced with:** Send to Intern.
