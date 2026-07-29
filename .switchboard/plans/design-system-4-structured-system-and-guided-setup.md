# Plan: Design System #4 — Structured Design System + Guided Setup ("Help Me Build a Real Design System")

## Goal
Turn the Design System tab from a passive doc-picker into a surface that **guides the user through establishing a real, structured design system** — tokens (color, type, spacing, radius, elevation), components, and usage rules — that agents can concretely conform to when working on HTML/UI. Two halves:
1. **Structure:** a first-class `design-system.json` (with a human-readable `.md` companion) as the canonical design-system artifact, so agents reference *real token values*, not prose vibes.
2. **Guided setup:** an interactive **Design System Builder** (modeled on the existing `constitution-builder` skill) that walks the user from nothing — or from an existing site/CSS, or from a Stitch/Claude-generated system — to a bound, structured design system.

This is the change that answers "I want something that guides the user in how to set up a real design system that agents can use," and it is the payoff for the primary use case: asking an agent to work on HTML files against a design system that genuinely constrains the output.

### Problem Context
Today a "design system" in Switchboard is just a markdown doc the user happens to point at. There is no structure, no token vocabulary, and no path that helps a user *create* one — so most users never establish a usable design system, and the agent, when editing HTML, has nothing concrete to conform to. The tab already previews JSON/YAML (`#json-preview-container-design` in `design.html`) and already browses Stitch- and Claude-generated design systems (the `design-source-select` "Stitch Design Systems" / "Claude Design Systems" sources), but the only verb on any of them is "Set as Active." The generation and the structure exist in pieces; nothing ties them into a guided "build and bind a real design system" flow.

### Root Cause Analysis
- **No canonical structure:** there is no schema for what a Switchboard design system *is*, so it degrades to freeform prose.
- **No authoring guidance:** there is no builder analogous to `constitution-builder`; the user is left to hand-write a doc.
- **Open loop:** Stitch/Claude can *generate* design systems, but generate → structure → bind → enforce is never closed; generated systems are browsable but not turned into the project's enforced design system.

## Metadata
- **Tags:** frontend, backend, agents, ux, feature
- **Complexity:** 8

## User Review Required
- Confirm the canonical artifact: **`design-system.json`** (tokens + components + rules) as source of truth, with an auto-derived `design-system.md` for human/agent reading. Alternative: `.md`-primary with a tokens code-fence.
- Confirm the token vocabulary scope for v1: **color, typography, spacing, radius, elevation/shadow, breakpoints**, plus a `components` list with usage notes. Anything else in scope (motion, z-index, iconography)?
- Confirm the builder should support all three starting points — **from scratch**, **from an existing site/CSS** (infer tokens), and **from a Stitch/Claude-generated system** — or a subset for v1.

## Dependencies
- **Depends on Design System #1** (a `DESIGN SYSTEM` injection block to feed) and **#2** (per-project binding, so the built system attaches to a project). Delivers the most value with **#3** (the structured tokens are exactly what coding/review should receive).
- Largest plan in the set; land #1–#3 first. This plan's output (a structured, bound design system) is what makes #1–#3 worth having.

## Complexity Audit

### Routine
- Define the `design-system.json` schema (tokens/components/rules) and a validator.
- Add a "New Design System" / "Build" entry point in the Design System tab controls strip.

### Complex / Risky
- **Guided builder flow.** Author a `design-system-builder` skill (model: `.agents/skills/constitution-builder/SKILL.md`) that interactively elicits or infers tokens/components one step at a time and writes `design-system.json` + `.md`. Decide host: a skill invoked from the tab vs. an in-panel wizard. Recommend skill-driven authoring (reuses the constitution pattern and host-agnostic invocation) with the tab providing the entry point and preview.
- **Infer-from-existing.** "From an existing site/CSS" requires parsing CSS/computed styles into tokens — scope carefully; v1 can accept a pasted CSS/style file and extract color/type/spacing heuristically, flagging low-confidence values for user confirmation.
- **Close the Stitch/Claude loop.** Add a "Use as project design system" action on generated systems that normalizes them into the `design-system.json` schema and binds them via #2's per-project mechanism.
- **Concrete token injection.** Extend #1/#3's `DESIGN SYSTEM` block so that when the bound artifact is structured, the injected block surfaces the actual token table (names + values) and component list, not just a link — this is what makes an agent editing HTML use real values.

## Proposed Changes

### New: design-system schema + validator
- `design-system.json` schema: `{ tokens: { color, typography, spacing, radius, elevation, breakpoints }, components: [{ name, usage }], rules: string[] }`.
- Validator (used by the builder and the binder) with clear errors.
- Auto-derive `design-system.md` (readable token tables + component list + rules) from the JSON on save.

### New: `.agents/skills/design-system-builder/SKILL.md`
- Interactive, one-step-at-a-time authoring modeled on `constitution-builder`: pick a starting point (scratch / existing CSS / generated), elicit or infer each token group, confirm, write `design-system.json` + `.md`, then offer to bind to a project (#2).

### `src/webview/design.{html,js}` + `src/services/DesignPanelProvider.ts`
- Design System tab: add a "Build / New Design System" entry point and a structured preview (render the token table + swatches from `design-system.json`, reusing `#json-preview-container-design`).
- On generated systems (Stitch/Claude sources): add "Use as project design system" → normalize → validate → bind (#2).

### `src/services/agentPromptBuilder.ts`
- Extend the `DESIGN SYSTEM` block (from #1) so a structured artifact injects a compact token table + component list; fall back to link/prose for unstructured docs.

## Verification Plan

### Automated Tests
- `npm run compile`.
- Schema-validator unit tests: valid `design-system.json` passes; malformed token groups produce specific errors.
- Prompt-builder test: a bound structured system injects a token table into the `DESIGN SYSTEM` block; an unstructured doc injects the link/prose form.

### Manual Verification
1. Run the Design System Builder from scratch; confirm it walks token groups one at a time and writes valid `design-system.json` + a readable `.md`.
2. Build from a pasted CSS/style file; confirm inferred tokens appear with low-confidence values flagged for confirmation.
3. Take a Stitch/Claude-generated design system, "Use as project design system," and confirm it normalizes, validates, and binds to the chosen project (#2).
4. Dispatch a coder to edit an HTML file for that project; confirm the coder prompt's `DESIGN SYSTEM` block contains the actual token values and component list (#3), and that the produced HTML uses those tokens.
5. Confirm the structured preview (swatches + token table) renders in the tab.

## Risk Assessment
- **High (largest scope in the set).** Risks: (1) builder scope creep — mitigate by shipping v1 with the three starting points behind a fixed token vocabulary and deferring motion/iconography; (2) CSS-inference accuracy — mitigate by treating inference as suggestions the user confirms, never silent; (3) prompt bloat from full token injection — mitigate with #3's summary-first variant and a compact token-table format; (4) schema churn breaking bound systems — mitigate by versioning `design-system.json` (`schemaVersion`) and validating on load. No migration risk to existing installs: this is additive; unstructured design-system docs remain valid via the fallback path.

**Recommendation:** Send to Coder
