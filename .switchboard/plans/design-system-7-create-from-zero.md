# Plan: Design System #7 — Create a Design System from Zero (Starter Template + Agent Interview)

## Goal
Give a user with **nothing** a path to a real design system. Two halves working together:
1. **A starter HTML template** written into the design folder — a skeleton design-system page with the right sections (palette, typography, spacing, radius, elevation, components) and placeholder CSS custom properties, immediately viewable in the tab.
2. **An agent interview** — a `design-system-builder` skill, modeled on `constitution-builder`, that asks the user questions one at a time (brand feel, base hue, light/dark, type choices, density) and fills the template in as it goes.

The template gives the agent and the user something concrete to react to from the first second; the interview is what turns a skeleton into that project's actual visual language. Neither half works alone: a bare template is homework, and an interview with no artifact to write into is a chat that produces nothing.

### Problem Context
Switchboard exists to take a project from **0 to 1**, so the correct assumption is that the user has nothing. Today the Design System tab assumes the opposite — its only verb is "Set as Active" on a doc that must already exist. A user starting from zero gets no help whatsoever, and the evidence is direct: the design system that motivated this work, `/Users/patrickvuleta/Documents/GitHub/patrickwork/designs/viaapp-design-system.html`, had to be built from scratch by iterating with Claude in a chat. The tab contributed nothing to creating it and — until #1 lands — cannot even display the result.

That reference file is also the specification for what "good" looks like: 869 lines, 14 `<section>` blocks, a 14-token semantic vocabulary declared across complete light **and** dark scopes (56 declarations total — see #3's corrected count), rendered swatches and type specimens rather than prose descriptions. The template should produce that shape.

### Root Cause Analysis
- **The tab was built as a picker, not a creator.** Every affordance assumes the artifact already exists, so the 0→1 case — the product's core case — has no entry point.
- **Generation was never connected to the tab.** Agents are perfectly capable of producing a design system (that is how the reference file was made); nothing in the tab initiates or receives that work.

## Metadata
- **Tags:** frontend, backend, ux, feature
- **Complexity:** 7

## User Review Required
- **None.** Settled: template **and** interview together (template written first, agent then asks questions and iterates it). Artifact is HTML with CSS custom properties, matching the reference file's shape. Template sections for v1: **palette (light + dark), typography, spacing, radius, elevation/shadow, and a components section**; motion and iconography are out of scope for v1.

## Dependencies
- **Depends on #1** (the template and the evolving design system must be viewable in the tab, or the loop is blind) and **#4** (so the finished system can be bound to a project). Pairs with **#6** — the copy-prompt button is how the user keeps iterating after the interview ends.
- **#8 depends on this** — it adds a second entry path into the same template and skill.
- Not independently shippable ahead of #1: without HTML rendering the user cannot see what the interview is producing.

## Complexity Audit

### Routine
- Author the starter template as a self-contained HTML file with `:root` custom properties, a dark scope redeclaring the same names, and the six v1 sections, each rendering its tokens visually (swatch grids, type specimens, spacing scale).
- Add a **Create Design System** button to the Design System tab controls strip.

### Complex / Risky
- **The interview must be an agent skill, not a panel wizard.** Model it on `.agents/skills/constitution-builder/SKILL.md`: one question at a time, confirm, write, continue. A webview wizard would duplicate elicitation logic the agent does better, and would not work in the iterative chat loop the user actually uses. The tab provides the entry point and the live preview; the agent does the interviewing.
- **Skill discoverability is host-split.** A new skill directory is not automatically available in Claude Code — the mirror is generated from the hardcoded `MIRROR_MANIFEST` (`src/services/ClaudeCodeMirrorService.ts:47`), while Antigravity discovers `.agents/skills/<name>/SKILL.md` from the filesystem. The skill must be registered in the manifest source in the same change, or it silently fails to appear in one host.
- **Template placement and collision.** The template must land in a configured design folder (so the tab lists it) with a non-clobbering name if a design system already exists there. Never overwrite an existing file.
- **Handoff from button to agent.** The button writes the template and then needs the agent to pick up the interview. The reliable mechanism is the established copy-prompt path (#6): write the template, then copy a kickoff prompt naming the template path and instructing the agent to run the interview. Avoid inventing a new dispatch mechanism for this.
- **Keeping the preview live during iteration.** As the agent edits the file, the tab should reflect changes. The HTML Previews tab already has auto-refresh polling (`_isPolledTab`, `DesignPanelProvider.ts:4307`); the DS tab should reuse that behaviour for a file under active iteration rather than requiring manual reselection.

## Edge-Case & Dependency Audit

- **Race Conditions:** Template write vs. tree rescan — write the file, then trigger the same refresh path the folder watcher uses, then select it; do not race a manual tree insert against the scanner. Agent edits vs. preview poll — the polling idiom from the HTML Previews tab already tolerates mid-write reads (a torn read self-heals on the next tick); reuse it unchanged.
- **Security:** The template is a bundled static asset written verbatim into a user-chosen design folder — no interpolation of user input into the HTML at write time. The kickoff prompt names a path; it must be the resolved written path, not user-typed text.
- **Side Effects:** New skill directory + manifest entry regenerates the Claude Code mirror (ledger-tracked; additive). The Create button writes a file into the user's design folder — visible, intended, non-clobbering. No config or DB writes.
- **Dependencies & Conflicts:** Depends on #1 (rendering) and #4 (binding target); reuses #6's copy path for the kickoff handoff; #3 must parse the template (its acceptance test below). Shares `design.{html,js}`/`DesignPanelProvider.ts` with #4/#6 — disjoint handlers, shared controls strip. #8 extends this plan's skill file; land #7 first.

## Adversarial Synthesis
Highest-scope plan in the set. Key risks: (1) interview scope creep — bounded by the fixed six-section v1 vocabulary and explicit motion/iconography deferral; (2) the skill silently missing from one host — bounded by registering it in `MIRROR_MANIFEST` in the same change and asserting the mirror contains it; (3) a fragile button→agent handoff — bounded by reusing the established copy-prompt mechanism rather than a new dispatch path; (4) clobbering an existing design system — bounded by non-colliding writes and a test.

## Proposed Changes

### New: starter template asset
1. A self-contained `design-system-starter.html` shipped with the extension: `:root` light tokens, a dark scope redeclaring the same names, and the six v1 sections rendering their own tokens.
2. Placeholder values chosen to be obviously provisional (so the interview has something to replace) while still rendering as a coherent page.
3. Token vocabulary sized like the reference file (on the order of 14 semantic names covering surface, ink, rule, accent, shadow) — enough to be real, small enough to interview through.

### New: `.agents/skills/design-system-builder/SKILL.md`
1. Interview protocol modeled on `constitution-builder`: one question at a time — purpose/feel, base hue and accent, light/dark, typeface pairing, density/spacing scale, radius character, elevation style, component inventory.
2. After each answer, edit the template file in place and tell the user to look at the preview.
3. On completion, offer to bind the result to a project (#4).
4. Register the skill in `MIRROR_MANIFEST` (`ClaudeCodeMirrorService.ts:47`) in the same change.

### `src/webview/design.{html,js}` + `src/services/DesignPanelProvider.ts`
1. Add **Create Design System**: choose target design folder, write the template under a non-colliding name, select it in the tree, and copy the kickoff prompt.
2. Extend the DS tab's preview to auto-refresh a file under active iteration, reusing the polling behaviour the HTML Previews tab already has (`_isPolledTab`, `:4307`).

## Verification Plan

### Automated Tests
- `npm run compile`.
- Template asset: parses with #3's extractor, yielding the expected token groups (light and dark) — the starter must be machine-readable by the same path a finished system uses.
- Non-clobbering write: creating twice in a folder produces two files, never an overwrite.
- Manifest registration: the new skill appears in the generated Claude Code mirror.

### Manual Verification
1. From a workspace with no design system, click Create Design System; confirm the template file is written, appears in the tree, and renders as a page.
2. Paste the kickoff prompt into an agent; confirm it asks **one question at a time** rather than dumping a questionnaire, and that answers land in the file.
3. Confirm the preview reflects the agent's edits without manual reselection.
4. Complete the interview; confirm the result is a coherent design system whose tokens extract correctly (#3) and can be bound to a project (#4).
5. Confirm the skill is invocable in both hosts.

## Risk Assessment
- **High — the largest scope in the set.** Risks: (1) interview scope creep, mitigated by the fixed six-section v1 vocabulary and explicitly deferring motion/iconography; (2) the skill being invisible in one host, mitigated by registering it in the manifest source in the same change and asserting the mirror contains it; (3) the button→agent handoff being fragile, mitigated by reusing the established copy-prompt path rather than a new mechanism; (4) template overwrite destroying a user's existing design system, mitigated by non-colliding writes and a test.
- No migration concern: entirely additive, and users with existing design systems never invoke it.

**Recommendation:** Send to Lead Coder

> **Superseded:** Recommendation: Send to Coder.
> **Reason:** Complexity is 7, and the routing rubric maps 7–10 to Lead Coder. The plan spans a bundled asset, a new agent skill with host-split registration, webview UI, a provider handler, and polling reuse — the coordination burden is the point of the Lead tier.
> **Replaced with:** Send to Lead Coder.
