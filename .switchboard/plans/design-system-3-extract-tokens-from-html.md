# Plan: Design System #3 — Extract Real Token Values from an HTML Design System

## Goal
Make the `DESIGN SYSTEM` prompt block carry **actual token names and values** rather than a link or a wall of prose. Parse CSS custom properties out of the bound HTML design system and emit a compact, labeled token table (plus the component/section inventory) into the block. This is what turns "there is a design system somewhere" into "an agent editing HTML knows that the accent colour is `#FF9F21` and the surface colour is `--card: #FFFFFF`".

### Problem Context
The design system this initiative serves is an HTML page, and **it already contains machine-extractable tokens.**

> **Superseded:** `/Users/patrickvuleta/Documents/GitHub/patrickwork/designs/viaapp-design-system.html` declares **56 CSS custom properties**, including a complete semantic palette and a full dark-mode counterpart … with the same names redeclared under a dark scope.
> **Reason:** Verified against the file: it declares **14 unique custom-property names** (`--ground --card --warm --raise --ink --body --muted --faint --rule --rule-hard --edge --accent --accent-text --shadow`), each declared **exactly 4 times** across **four scopes** — `:root` (light), `@media (prefers-color-scheme:dark){:root{…}}` (line 24), `:root[data-theme="dark"]` (line 31), and `:root[data-theme="light"]` (line 38) — for 56 total *declarations*. "56 properties" conflated declarations with names, and "a dark scope" undercounted the scopes by half.
> **Replaced with:** The file declares a 14-token semantic vocabulary, each token carrying light and dark values expressed through **four** scope declarations (base light, media-query dark, data-theme dark override, data-theme light override). This strengthens the scope-aware-parsing requirement: every single token name appears 4× in the file, and two of those scopes (`@media` dark and `[data-theme="dark"]`) carry the *same* dark values by different mechanisms — a naive parse emits four conflicting copies of every token; even a scope-aware parse must **merge equivalent scopes into one scheme** or it emits two identical "dark" groups.

Example values (light set): `--ground:#FDFDFD; --card:#FFFFFF; --warm:#FFFAF3; --raise:#F7F3EE; --ink:#222222; --body:#444444; --muted:#5A5A5A; --faint:#8B8B8B; --rule:#E9E1D7; --rule-hard:#D8CEC1; --edge:rgba(0,0,0,.14); --accent:#FF9F21; --accent-text:#A65E05; --shadow:…` — with dark counterparts (`--ground:#17130F; --ink:#F7F2EC; --accent-text:#FFB454;` …).

No schema, no validator, and no authoring wizard are needed to obtain these — they are already there, in the artifact the user actually produced, in a format CSS itself defines. Today none of it reaches the agent: the block emits a link or raw prose, so an agent asked to edit HTML has no concrete values to use and invents its own.

### Root Cause Analysis
- **The artifact's own structure was never read.** The design system was treated as an opaque document to point at, not a file with a parseable token vocabulary.
- **Structure was assumed to require new authoring.** The natural conclusion — "we need a JSON schema and a builder so tokens exist" — overlooks that a hand-built HTML design system already expresses its tokens as CSS custom properties. Extraction is the cheap path; re-authoring is the expensive one.

## Metadata
- **Tags:** backend, feature
- **Complexity:** 5

## User Review Required
- **None.** Decisions taken: emit **both** light and dark token sets, explicitly labeled by scheme (agents build dark UI too, and omitting the dark set would silently produce light-only work). Emit a **compact table**, not the raw CSS. Non-HTML or variable-less design systems fall back to the existing link/content form from #2.

## Complexity Audit

### Routine
- Emit the extracted tokens as a compact table inside `buildDesignSystemBlock` via the `tokens` parameter #2 reserved.
- Collect the section/heading inventory (`<h2>` text, 14 sections in the reference file) as the component list.

### Complex / Risky
- **Scope-aware extraction is mandatory, not optional.** In the reference file every token name is declared **four times** — base light, media-query dark, `[data-theme="dark"]`, `[data-theme="light"]`. A naive regex over the whole file emits duplicate token names with conflicting values, which is worse than no tokens at all: the agent picks arbitrarily. The parser MUST attribute each declaration to its selector/at-rule context and then **normalize scopes into scheme groups**: `:root` and `[data-theme="light"]` → `light`; `@media (prefers-color-scheme: dark)` and `[data-theme="dark"]` → `dark`; anything else → a named scope group. Within a scheme, deduplicate identical `(name, value)` pairs; on a genuine conflict within one scheme, keep the last declaration (CSS cascade order) and count it.
- **Parse without a CSS dependency.** The VSIX bundles everything via webpack and must not gain a heavyweight CSS parser for this. A targeted scan — locate `<style>` blocks, then walk selector-block boundaries tracking brace depth and current selector — is sufficient for custom-property declarations and avoids a new dependency.
- **Expose a CSS-text-level core, not just an HTML entry point.** #8 (derive from an existing app) reuses this extractor against raw stylesheets (`.css`/`.scss` files), which contain no `<style>` tags. Structure the module as `extractTokensFromCss(cssText)` (the scanner core) plus `extractDesignSystemTokens(html)` (locates `<style>` blocks, delegates to the core, adds the section inventory). Without this split, #8's "reuse #3's extractor" is impossible and it would grow a second parser.
- **Size bounding.** 14 tokens is comfortable; a large system could declare hundreds. Cap the emitted table (tokens per group, and total characters) and note the truncation in the block rather than silently dropping values.
- **Non-token noise.** Only `--*` declarations are tokens. Ordinary properties, keyframes and vendor prefixes must be ignored.

## Edge-Case & Dependency Audit

- **Race Conditions:** None in the extractor (pure function). The bound file is read at prompt-build time, so an edit between binding and dispatch is picked up on the next build — read-at-dispatch is the intended semantic, not a race.
- **Security:** The scanner runs over user-supplied HTML; it must be linear-time (brace-depth walk, no backtracking-prone regex over the whole document) so a pathological file cannot hang prompt generation. Extracted values are injected into prompts — same trust boundary as the doc content itself.
- **Side Effects:** Prompt size grows by the token table wherever the block is emitted (planner today; every role after #5) — bounded by the caps. Fallback path leaves non-HTML design systems byte-identical to #2's output.
- **Dependencies & Conflicts:** Consumes #2's `tokens` parameter; #5, #6, #7 and #8 consume this extractor's output. #7's starter template must parse cleanly through this extractor (its acceptance test), and #8 requires the CSS-text core API above — both are contract obligations of this plan, not theirs.

## Dependencies
- **Depends on #1** (an HTML design system must be selectable/bindable before its tokens can be read) and **#2** (the `DESIGN SYSTEM` block and its `tokens` parameter must exist to receive them).
- **#5 and #6 consume this** — the token table is what makes injection and the copy-prompt button concrete. Both degrade gracefully to link/prose without it. **#8 additionally requires the `extractTokensFromCss` core** to run over raw stylesheets.
- Independently shippable once #1 and #2 land.

## Adversarial Synthesis
The dominant risk is the duplicate-token failure mode — it is not hypothetical, the reference file exhibits it on every token name (4 declarations each across 4 scopes, two of which are equivalent dark mechanisms), and it degrades agent output silently. It is directly mitigated by scope-aware parsing with scheme normalization and by the test written specifically to fail on a naive implementation. Secondary risks: prompt bloat on large systems (mitigated by caps + `truncated`), and hand-rolled parsing missing exotic CSS (acceptable — custom-property declarations are a narrow, regular syntax, and the fallback path covers total parse failure).

## Proposed Changes

### New: token extractor (e.g. `src/services/designSystemTokens.ts`)
1. `extractTokensFromCss(cssText: string): Array<{ scope: string; name: string; value: string }>` — the scanner core: walk selector-block boundaries tracking brace depth, at-rule context and current selector; collect `--name: value` declarations attributed to their scope. **This is the entry point #8 reuses for raw stylesheets.**
2. `extractDesignSystemTokens(html: string): { groups: Array<{ scheme: string; tokens: Array<{ name: string; value: string }> }>; sections: string[]; truncated: boolean }` — locate `<style>` blocks, delegate to the core, normalize scopes into scheme groups (`light` / `dark` / named), deduplicate identical `(name, value)` pairs within a scheme, resolve intra-scheme conflicts by cascade order.
3. Collect `<h2>` section titles as the component/section inventory.
4. Apply per-group and total size caps, setting `truncated` when they bite.

### `src/services/agentPromptBuilder.ts`
1. When the bound design system is HTML, call the extractor and pass the result as `buildDesignSystemBlock({ tokens })`.
2. Render tokens as a compact table grouped by scheme, followed by the section inventory. Fall back to the #2 link/content form when the artifact is not HTML or declares no custom properties.

## Verification Plan

### Automated Tests
- `npm run compile`.
- Extractor unit tests against a fixture derived from the real file: (a) all **56 declarations** are found and resolve to **14 unique names**, each present in both the light and dark groups; (b) light and dark `--ground` values are attributed to **different scheme groups** and never collapsed into one entry — and the two dark-mechanism scopes (`@media` and `[data-theme="dark"]`) merge into **one** dark group, not two; (c) ordinary CSS properties and keyframes are excluded; (d) a file with no `<style>` block returns empty groups without throwing; (e) the size cap sets `truncated` and does not exceed the character budget; (f) `extractTokensFromCss` run directly over a raw stylesheet (no HTML wrapper) yields the same declarations — the #8 reuse contract.
- Prompt-builder test: an HTML design system injects a token table; a markdown design system injects the link/prose form.

### Manual Verification
1. Bind `viaapp-design-system.html`, dispatch a coder, and confirm the prompt's `DESIGN SYSTEM` block lists real values (`--accent: #FF9F21`) grouped into light and dark — with no duplicated names carrying conflicting values.
2. Ask an agent to build a new component for that project; confirm the produced HTML uses the actual token names rather than invented hex values.
3. Bind a markdown design system and confirm graceful fallback.

## Risk Assessment
- **Medium.** The dominant risk is the duplicate-token failure mode above — directly mitigated by scope-aware parsing with scheme normalization and by test (b), which is written specifically to fail on a naive implementation. Secondary risks: prompt bloat on large systems (mitigated by caps + `truncated`), and hand-rolled parsing missing exotic CSS (acceptable — custom-property declarations are a narrow, regular syntax, and the fallback path covers total parse failure).
- No migration concern: additive, and unstructured design systems keep working via fallback.

**Recommendation:** Send to Coder
