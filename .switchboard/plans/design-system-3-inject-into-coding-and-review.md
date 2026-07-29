# Plan: Design System #3 — Inject the Design System into Coding and Review Prompts (Not Just Planning)

## Goal
Ensure the `DESIGN SYSTEM` block reaches the agents that actually build and check UI — the **coder / lead / intern** coding roles and the **reviewer / acceptance-tester** roles — not just the planner. This is the change that directly serves the primary use case: *when the user asks an agent to work on HTML files, the agent must have the project's design system in front of it and conform to it.*

### Problem Context
Visual conformance matters most where UI is written (coding) and checked (review), yet the design system's strongest, most complete injection is on the planner path (`agentPromptBuilder.ts:1155`–`:1162`). The coding path only partially carries it via the addon block in `buildCustomAgentPrompt` (`:1854`–`:1857`), and there is no deliberate injection into the reviewer/acceptance path at all. So a coder asked to edit an HTML file may never see the design system, and a reviewer has no design-system baseline to check against.

### Root Cause Analysis
- **Planner-centric design:** the design system was wired as planning context, not implementation/verification context.
- **Incidental coder coverage:** the coder gets it only because the addon block happens to include it (and mislabeled, pre-#1); it was never a first-class, intentional injection for coding, and reviewers were omitted.

## Metadata
- **Tags:** backend, agents, prompt, review
- **Complexity:** 5

## User Review Required
- Confirm the design system should be injected into **all** coding roles (coder, lead, intern) and **both** verification roles (reviewer, acceptance-tester). If any role should be excluded (e.g. intern), name it.
- Confirm the reviewer framing: the design system is a **conformance baseline** the reviewer must check the implementation against (UI must match tokens/components/patterns), reported as findings when it diverges.

## Dependencies
- **Depends on Design System #1** (the `DESIGN SYSTEM` block/helper) and benefits from **#2** (per-project resolution) so each role gets the right project's system. Works with #1 alone (global design system injected into more roles); #2 makes it per-project-correct.
- Independently shippable once #1 lands.

## Complexity Audit

### Routine
- In `buildCustomAgentPrompt` (`agentPromptBuilder.ts:1738`), make the `DESIGN SYSTEM` injection first-class and unconditional-on-presence for all coding roles routed through it (coder/lead/intern/custom via `columnToPromptRole`).

### Complex / Risky
- Locate the reviewer and acceptance-tester prompt-building paths (distinct from `buildCustomAgentPrompt`) and add the `DESIGN SYSTEM` block with reviewer-appropriate framing ("check the implementation conforms to this design system; report divergences as findings"). Confirm which function builds each — the coder addon block living in `buildCustomAgentPrompt` does not imply the reviewer shares it.
- Avoid double-injection: if a role already receives the design system via the shared addon block, do not add a second copy. Audit each role's assembled prompt for exactly one `DESIGN SYSTEM` block.
- Prompt-size budget: injecting full design-system content into every role increases prompt size. Prefer link + concise token summary for coding/review where the full doc is large (ties into #4's structured tokens); keep full content for planner. Make the coding/review variant a summary-first block.

## Proposed Changes

### `src/services/agentPromptBuilder.ts`
1. Coding roles: in `buildCustomAgentPrompt`, emit the #1/#2 `DESIGN SYSTEM` block (per-project via `designSystemReferences` when available, else global) as a deliberate, labeled section — with framing "conform all UI you write to this design system."
2. Reviewer/acceptance roles: in their builder(s), add a `DESIGN SYSTEM` conformance block framed as a review baseline. Reuse #1's helper with a `mode: 'review'` framing variant.
3. Add a summary-first variant of the block for coding/review to bound prompt size when the design-system content is large.

### (If separate) reviewer/acceptance builder file
1. Wire the same block into the reviewer/acceptance prompt assembly, resolved for the plan's project.

## Verification Plan

### Automated Tests
- `npm run compile`.
- Unit assertions: coder prompt, lead prompt, intern prompt, reviewer prompt each contain exactly one `DESIGN SYSTEM` block when a design system is bound; zero when none is bound; no duplicate blocks.

### Manual Verification
1. Bind a design system, dispatch a coding plan that edits an HTML file, and confirm the coder prompt carries the `DESIGN SYSTEM` block with "conform to this" framing.
2. Move the plan to review and confirm the reviewer prompt carries the design system as a conformance baseline.
3. Confirm no role receives two copies of the block.
4. With a large design-system doc, confirm coding/review get the summary-first variant (bounded size) while the planner still gets full content.

## Risk Assessment
- **Medium.** Main risks: (1) double-injection if the shared addon block and the new explicit injection both fire — mitigated by the single-block audit and tests; (2) prompt bloat across every role — mitigated by the summary-first coding/review variant; (3) missing a reviewer/acceptance builder path — mitigated by explicitly locating and testing each role's prompt.

**Recommendation:** Send to Coder
