# Plan: Design System #1 — Give the Design System Its Own Injection Identity (Distinct from the PRD)

## Goal
Stop injecting the active design-system doc into agent prompts under the label **"PROJECT PRD REFERENCE"**. Emit it instead as a clearly-labeled **DESIGN SYSTEM** block, framed as *how the UI must look and behave* (tokens, components, styling conventions) — explicitly complementary to, and separate from, the PRD's *what to build*. This is the foundation the rest of the design-system initiative builds on: once the design system and the PRD occupy distinct, honestly-labeled prompt slots, a project can carry both without them colliding.

### Problem Context
A project needs **both** a PRD (product requirements — what to build) and a design system (visual/UI system — how it should look). The codebase currently conflates them: the active design-system doc is injected under the header `PROJECT PRD REFERENCE` with the text "The following project PRD provides the product requirements and design specifications" (`src/services/agentPromptBuilder.ts:1157` and `:1162` for the planner; `:1854`–`:1857` for the coder addon block). Meanwhile the *real* PRD is injected separately and correctly as `PROJECT REQUIREMENTS (PRD)` (`:611`, `:1319`). So the design system is presented to agents as a second, redundant PRD — which is why it fails to function as a design system, especially when an agent is asked to work on HTML/UI.

### Root Cause Analysis
- **Mislabeling:** the design-system doc reuses the PRD framing string rather than a design-system-specific framing.
- **Slot collision:** because both are called "PRD", an agent receiving both a real PRD and a design system sees two "PRD" blocks with overlapping intent, diluting each.

## Metadata
- **Tags:** backend, agents, prompt, refactor
- **Complexity:** 3

## User Review Required
- Confirm the block header wording: **`DESIGN SYSTEM`** with framing "The following is the project's design system — the visual and UI conventions (tokens, components, layout, interaction patterns) this work MUST conform to. It complements the PRD (which defines what to build); the design system defines how it must look and behave."

## Dependencies
- **None** (foundation plan). Plans #2 (per-project), #3 (coding/review injection), and #4 (structured builder) all depend on this block existing with its correct identity. Independently shippable: relabeling improves agent output on its own even if #2–#4 never land.

## Complexity Audit

### Routine
- Extract a `buildDesignSystemBlock({ link, content })` helper in `src/services/agentPromptBuilder.ts` that emits the new `DESIGN SYSTEM` framing (paralleling the existing `buildPrdReferenceBlockFromRefs`).
- Replace the two planner injections (`:1155`–`:1162`) and the coder addon injection (`:1854`–`:1857`) with calls to the new helper.

### Complex / Risky
- The addon field names (`designSystemDocLink`, `designSystemDocContent`) MUST stay unchanged — they are the carrier from config/UI. Only the *emitted prompt text* changes. Do not rename the fields (that would ripple into `agentConfig.ts`, `DesignPanelProvider.ts`, `kanban.html` addon wiring, and `AgentSkillExporter`).

## Proposed Changes

### `src/services/agentPromptBuilder.ts`
1. Add `buildDesignSystemBlock(opts: { link?: string; content?: string }): string` returning the `DESIGN SYSTEM` framing (content variant when pre-fetched, link variant otherwise).
2. Planner path (`:1155`–`:1162`): replace the inline `PROJECT PRD REFERENCE` strings with `plannerPrompt += buildDesignSystemBlock({ link: designSystemDocLink, content: designSystemDocContent })`.
3. Coder addon path (`buildCustomAgentPrompt`, `:1854`–`:1857`): replace the inline `PROJECT PRD REFERENCE` strings with the same helper.

## Verification Plan

### Automated Tests
- `npm run compile` — confirm the bundle builds.
- If prompt-builder unit tests exist, add/adjust an assertion that the design-system block header is `DESIGN SYSTEM` and NOT `PROJECT PRD REFERENCE`, and that a real PRD block still emits `PROJECT REQUIREMENTS (PRD)`.

### Manual Verification
1. Configure an active design-system doc and dispatch a planner — inspect the generated prompt and confirm the `DESIGN SYSTEM` header (not `PRD`).
2. With BOTH a project PRD and a design-system doc configured, confirm the prompt contains two distinct, correctly-labeled blocks.
3. Dispatch a coder and confirm the coder prompt carries the `DESIGN SYSTEM` block with the new framing.

## Risk Assessment
- **Low.** Pure prompt-text/labeling change behind a new helper; no config, schema, or persistence changes. Risk is limited to wording; mitigated by keeping field names intact and asserting headers in tests.

**Recommendation:** Send to Coder
