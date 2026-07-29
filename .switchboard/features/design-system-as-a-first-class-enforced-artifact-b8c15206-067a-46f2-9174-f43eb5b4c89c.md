# Design System as a First-Class, Enforced Artifact

**Complexity:** 7

## Goal

Make a design system something Switchboard can help you **create from nothing, actually look at, and then hold agents to** — across both the dispatch loop and the iterative loop where design work is really done.

Three failures compound today. **The tab cannot see the artifact:** the design-docs walker whitelists `.css`, `.scss`, `.xml`, `.json` and images but excludes `.html`/`.htm` (`LocalFolderService.ts:1193`), so a real HTML design system never even appears in the tree — while two working HTML iframe renderers sit unused in the same webview (`design.js:1516`, `:1595`) and HTML-aware tree grouping exists as dead code (`getDocType` `:985`). **The prompt lies about what it is:** the doc is injected under the header `PROJECT PRD REFERENCE` (`agentPromptBuilder.ts:1157`, `:1854`), colliding with the real PRD block. **And nothing helps you make one:** the tab's only verb is "Set as Active" on a doc that must already exist, so a user starting from zero gets no help at all — the design system that motivated this work had to be built by hand-iterating with an agent in a chat, and the tab still cannot display the result.

Eight sequenced stages fix this: make HTML design systems visible and renderable, give the design system an honest `DESIGN SYSTEM` prompt identity, extract real token values from the artifact's own CSS custom properties, bind it per-project with **no design system by default**, inject it into every prompt in a design project, add a copy-prompt button for iterative work, and provide a starter template plus an agent interview that builds a design system from zero — or derives one from an app that already exists.

## How the Subtasks Achieve This

- **#1 — Render HTML in the Design tab**: Adds `.html`/`.htm` to `_isDesignOrImageFile` (`LocalFolderService.ts:1193`) and routes the tab's preview through the `injectBaseTag` + `srcdoc` iframe pattern already proven at `design.js:1516`, wiring the dead `getDocType`/`groupDocsByType` helpers that were written for exactly this. Root of the set — until the artifact is selectable, nothing downstream has anything to operate on.
- **#2 — Distinct injection identity**: Extracts `buildDesignSystemBlock` and replaces the `PROJECT PRD REFERENCE` framing with a `DESIGN SYSTEM` block framed as *how the UI must look and behave*, ending the slot collision with the real PRD. Addon field names stay unchanged — only emitted prompt text moves.
- **#3 — Extract real token values**: Parses CSS custom properties out of the bound HTML so the block carries actual names and values instead of a link. The reference artifact already declares a 14-token semantic vocabulary with full light **and** dark sets (56 declarations across four scopes) — no schema or wizard is needed to obtain structure that the artifact already expresses. Must be scope-aware: every token name is declared 4× across two light and two dark scopes, so a naive parse emits conflicting duplicates and even a scope-aware one must merge equivalent scopes into one scheme.
- **#4 — Per-project binding, defaulting to none**: Adds `designSystemReferences` and `_resolveDesignSystemReferences` mirroring the PRD's `_resolvePrdReferences` (`KanbanProvider.ts:4492`), with **no standing global fallback** — most projects have no design system and must emit no block at all. The legacy `planner.designSystemDocLink` is consumed by a one-time migration, then retired.
- **#5 — Inject into every prompt**: In a project with a binding, the block reaches planner, coder, lead, intern, reviewer, acceptance-tester and Copy Prompt paths alike — no role exclusions, no plan-type heuristics. The binding itself is the gate, which is why #4 must land first.
- **#6 — Copy Design System Prompt button**: The affordance for the iterative loop, currently absent (only orphaned `.kanban-plan-copy-prompt` CSS at `design.html:2362`). Built from the same `buildDesignSystemBlock` as dispatch so the two loops cannot drift.
- **#7 — Create from zero**: A starter HTML template written into the design folder plus a `design-system-builder` skill (modeled on `constitution-builder`) that interviews the user one question at a time and fills it in. Template and interview are inseparable: a bare template is homework, an interview with nothing to write into produces nothing.
- **#8 — Derive from an existing app**: A second entry path into #7's loop for projects already built — the agent reads stylesheets, markup and/or screenshots, clusters near-duplicates, and proposes a token set the user confirms. Derivation is agent work, not a CSS engine in TypeScript.

## Reconciled Interfaces (improve-feature pass, 2026-07-29)

Cross-plan contracts every coder implements to — the single end-state for each shared surface:

- **`buildDesignSystemBlock({ link?, content?, mode?: 'author' | 'review', tokens? })`** (`agentPromptBuilder.ts`) — created by #2 (with `mode`/`tokens` accepted-but-unused); #3 populates `tokens`; #5 populates `mode`; #6 calls it server-side from `DesignPanelProvider`. One framing, four consumers — never reimplement it.
- **`buildDesignSystemReferencesBlock(refs: [{ projectName, designSystemLink }])`** — created by #4 (mirrors `buildPrdReferenceBlockFromRefs:607`); emitted by #5 in the built-in role branches of `buildKanbanBatchPrompt` and in `buildCustomAgentPrompt`, where it **replaces** the legacy single-doc addon block (`:1854`–`:1857`) rather than stacking on it. Empty refs ⇒ no block, no placeholder.
- **Token extractor** (`designSystemTokens.ts`, #3) — two-level API: `extractTokensFromCss(cssText)` (scanner core; **#8's reuse path for raw stylesheets**) and `extractDesignSystemTokens(html)` (locates `<style>` blocks, normalizes the four scopes into `light`/`dark` scheme groups, dedupes, caps). Corrected fact: the reference file is 14 unique tokens × 4 scope declarations = 56 declarations, two of the scopes being equivalent dark mechanisms that must merge.
- **Binding store** (#4) — pointer file `.switchboard/projects/<slug>/design-system.json` (mirrors the PRD's directory convention, since `_resolvePrdReferences` derives paths and no project-record field exists); unbound = file absent. Legacy state is **two** VS Code keys at both scopes (`planner.designSystemDocEnabled` + `planner.designSystemDocLink`); one-time migration reads them as `_resolveDesignSystemDoc:4465` does, writes pointer files, stamps in the DB `config` table, retires the resolver. Both KanbanProvider population sites (`:4543` mergedAddons, `:4665` resolvedOptions) switch to `_resolveDesignSystemReferences`.
- **Injection surface** (#5) — role branches inside `buildKanbanBatchPrompt` (reviewer `:1168`, tester `:1275`, lead `:1344`, coder `:1391`, intern `:1494`) + `buildCustomAgentPrompt`. Copy Prompt needs no separate wiring — it flows through the canonical builder by contract (`:930`–`:934`); guard with a parity test.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Plan: Design System #1 — Make the Design System Tab See and Render HTML](../plans/design-system-1-render-html-in-design-tab.md) — **LEAD CODED**
- [ ] [Plan: Design System #2 — Give the Design System Its Own Injection Identity (Distinct from the PRD)](../plans/design-system-2-distinct-injection-identity.md) — **LEAD CODED**
- [ ] [Plan: Design System #3 — Extract Real Token Values from an HTML Design System](../plans/design-system-3-extract-tokens-from-html.md) — **LEAD CODED**
- [ ] [Plan: Design System #4 — Per-Project Design System Binding, Defaulting to None](../plans/design-system-4-per-project-binding.md) — **LEAD CODED**
- [ ] [Plan: Design System #5 — Inject the Design System into Every Prompt in a Design Project](../plans/design-system-5-inject-into-every-prompt.md) — **LEAD CODED**
- [ ] [Plan: Design System #6 — "Copy Design System Prompt" Button for the Iterative Design Loop](../plans/design-system-6-copy-design-system-prompt.md) — **LEAD CODED**
- [ ] [Plan: Design System #7 — Create a Design System from Zero (Starter Template + Agent Interview)](../plans/design-system-7-create-from-zero.md) — **LEAD CODED**
- [ ] [Plan: Design System #8 — Derive a Design System from an Existing App](../plans/design-system-8-derive-from-existing-app.md) — **LEAD CODED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**#1 and #2 are independent roots and can be built in parallel** — they touch disjoint files (`LocalFolderService`/`design.{html,js}` vs. `agentPromptBuilder`). Everything else forms a chain behind them:

- **#3 depends on #1 + #2** — it needs an HTML artifact to be bindable and the block's `tokens` parameter to exist.
- **#4 depends on #2**; benefits from #1 (so an HTML doc can be picked when binding) and #3 (so the bound artifact's tokens are what gets injected).
- **#5 depends on #4** — it gates on "is a design system bound to this plan's project", which only becomes answerable there. Consumes #3's token table.
- **#6 depends on #2 + #3**, and uses #4's binding when present. Without #4 it can copy the selected doc instead.
- **#7 depends on #1 + #4** — the interview is blind without HTML rendering, and its output needs somewhere to bind.
- **#8 depends on #7** — it adds a second entry path into the same template and skill.

Recommended execution order is **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8**, with 1 and 2 concurrent. Each stage is independently shippable once its predecessors land: #1 alone makes existing HTML design systems usable; #2 alone improves agent output through honest labeling. #7 is the largest scope (complexity 7) and highest risk.

**Do not start with #2 alone and treat the set as done.** Relabeling the block is the cheapest stage and the least valuable in isolation — the user-visible failures are that the tab cannot show an HTML design system (#1) and cannot help create one (#7).

**Migration note:** #4 is the only stage touching released state. `planner.designSystemDocLink` shipped as a global setting, so it must be honoured — but via a **one-time migration** that binds it to the projects existing at that moment and then retires the key, **not** as a standing fallback. A standing fallback would hand a design system to every project created from then on, which is the behaviour this design explicitly rejects: most projects have no design system and must emit no block at all. Leave the key's stored value in place (unread after migration) so a downgrade loses nothing and the migration stays idempotent.

**Open decision:** #5 carries the set's only unresolved product call — whether a reviewer treats design-system divergence as a **blocking finding** or an **advisory note**. Default if unanswered: advisory. Every other plan's `User Review Required` is "None".
