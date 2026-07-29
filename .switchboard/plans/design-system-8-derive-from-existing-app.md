# Plan: Design System #8 — Derive a Design System from an Existing App

## Goal
Add a second entry path into #7's template-and-interview loop: point the builder at an **app that already exists** — its stylesheets and markup, and/or screenshots of it — and have the agent derive the design system that app is already implicitly using, then confirm it with the user. This covers bootstrapping a design system for something already built, where the visual language exists in the code but was never written down.

### Problem Context
#7 handles the true 0→1 case. But the adjacent and equally common case is a project that has been built without a design system: colours, spacing and type choices are scattered across stylesheets and components, consistent-ish but undocumented. Asking that user to answer #7's interview from scratch is wrong — the answers are already in their repo. They should be extracted and confirmed, not re-elicited.

Without this path, the only way to get a design system for an existing app is to hand-answer an interview about decisions already made, which is both tedious and likely to produce a system that disagrees with the shipped UI.

### Root Cause Analysis
- **Only the greenfield case was considered.** The 0→1 framing is correct for new projects but leaves existing projects — which have the most material to work from — with the least support.
- **Existing style information is never read.** The design-docs walker already accepts `.css`, `.scss`, `.less`, `.sass` (`LocalFolderService.ts:1193`), so stylesheets are visible to the panel; nothing does anything with them.

## Metadata
- **Tags:** frontend, backend, ux, feature
- **Complexity:** 6

## User Review Required
- **None.** Settled: support **both** input kinds — repo/stylesheet code and screenshots. Derived values are always presented as **suggestions the user confirms**, never written silently as final.

## Dependencies
- **Depends on #7** (the starter template shape and the `design-system-builder` skill are what this writes into and extends) and therefore transitively on **#1** and **#4**.
- **Requires #3's `extractTokensFromCss` core API** (the CSS-text-level entry point) for the existing-custom-properties fast path — the HTML-only wrapper cannot read raw stylesheets. This contract is recorded in #3's Proposed Changes.
- Independently shippable after #7: it adds a starting point, changing nothing about the from-scratch path.

## Complexity Audit

### Routine
- Add a "derive from existing app" starting-point branch to the `design-system-builder` skill's opening question.
- Reuse #7's template as the output artifact so both paths converge on one format.

### Complex / Risky
- **Derivation is agent work, not a parser.** Resist building a CSS-analysis engine in the extension. The agent reads the stylesheets and markup and proposes tokens; this is exactly what agents are good at, and it degrades gracefully on messy input where a parser would fail. Any inference implemented in TypeScript here is scope creep.
- **Confidence and confirmation.** Derived palettes are frequently near-duplicates (six greys that should be three). The skill must cluster obvious near-duplicates, present its proposal with reasoning, and require confirmation before writing. Silent acceptance is the failure mode that produces a design system nobody trusts.
- **Screenshot input.** Images are a genuinely different modality: the agent samples colours and infers type scale and spacing rhythm visually, with lower precision than reading CSS. Screenshot-derived values must be flagged as approximate, and code should be preferred when both are available.
- **Scale.** A large app's stylesheets exceed what fits in one prompt. The skill needs a bounded strategy — prioritise global/theme/token stylesheets and root-level custom properties over per-component files — rather than attempting to read everything.
- **Existing custom properties are the jackpot.** If the app already declares `--*` variables, those *are* the tokens; #3's `extractTokensFromCss` core can read them directly from raw stylesheet text and derivation reduces to naming and organising. Check for this first before inferring anything from raw declarations.

## Edge-Case & Dependency Audit

- **Race Conditions:** None new — the skill drives a conversational flow; file writes go through #7's non-clobbering template write.
- **Security:** The agent reads repo stylesheets/markup the user pointed it at, and screenshots the user supplied — user-initiated, same trust boundary as any repo-reading agent session. No extension-side ingestion of arbitrary paths is added.
- **Side Effects:** Skill file grows a branch; the extension gains only an entry-point option on #7's Create flow (the kickoff prompt names the inputs). No config, DB, or prompt-builder changes.
- **Dependencies & Conflicts:** Edits the same `design-system-builder/SKILL.md` #7 creates — strictly after #7, never in parallel. Consumes #3's CSS-text core (contract recorded there). Converges on #7's template so #3 extraction and #4 binding work identically for derived systems; no other subtask touches the derivation path.

## Adversarial Synthesis
Key risks: (1) drifting into building a CSS-inference engine in TypeScript — held off by the explicit decision that derivation is agent work and the only code reuse is #3's existing extractor core; (2) silent acceptance of poor derivations producing an untrusted design system — held off by mandatory confirmation and confidence flagging; (3) large-repo input exceeding prompt limits — held off by the prioritised-stylesheet strategy; (4) screenshot inference treated as authoritative — held off by explicit approximate flagging and preferring code when both exist.

## Proposed Changes

### `.agents/skills/design-system-builder/SKILL.md`
1. Extend the opening question to offer: from scratch (#7), **from an existing app**, with the input being a repo path, specific stylesheets, and/or screenshots.
2. Derivation protocol: check for existing `--*` custom properties first (via #3's `extractTokensFromCss` over the stylesheet text); otherwise read prioritised stylesheets; cluster near-duplicate colours and spacing values; propose a token set with reasoning.
3. Present the proposal for confirmation before writing, flagging low-confidence and screenshot-derived values explicitly.
4. On confirmation, write #7's template populated with the confirmed tokens, then continue the normal interview for anything the app did not answer (dark mode is commonly absent).

### `src/webview/design.{html,js}` + `src/services/DesignPanelProvider.ts`
1. On the Create Design System entry point, allow choosing the "from existing app" starting point so the copied kickoff prompt names the repo/stylesheet/screenshot inputs.

## Verification Plan

### Automated Tests
- `npm run compile`.
- Existing-custom-properties path: an app stylesheet declaring `--*` variables is read by #3's `extractTokensFromCss` (raw CSS text, no HTML wrapper) and yields the expected token declarations (asserts the reuse rather than a second implementation).

### Manual Verification
1. Point the builder at a real repo with no custom properties; confirm it proposes a token set with reasoning and **waits for confirmation** before writing.
2. Point it at a repo that already declares custom properties; confirm it recognises and reuses them rather than re-deriving.
3. Supply screenshots only; confirm derived values are flagged approximate.
4. Confirm near-duplicate colours are clustered rather than emitted as six near-identical greys.
5. Confirm the output is the same template shape as #7, extracts via #3, and binds via #4.
6. Confirm the from-scratch path (#7) is unchanged.

## Risk Assessment
- **Medium.** Risks: (1) drifting into building a CSS-inference engine in TypeScript — mitigated by the explicit decision that derivation is agent work and the only code reuse is #3's existing extractor; (2) silent acceptance of poor derivations producing an untrusted design system — mitigated by mandatory confirmation and confidence flagging; (3) large-repo input exceeding prompt limits — mitigated by the prioritised-stylesheet strategy; (4) screenshot inference being treated as authoritative — mitigated by explicit approximate flagging and preferring code when both exist.
- No migration concern: additive second entry point into an additive feature.

**Recommendation:** Send to Coder
