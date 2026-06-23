# Planner Add-on: "Advise Research If Unsure"

## Goal (Problem analysis + Root Cause with cited file:line)

The planner prompt builder (Kanban → Prompts tab → **Add-ons**) lets the user toggle planner-specific directives that get appended to the generated planner prompt. There is currently **no** add-on that tells the planner what to do when it is **not 100% sure** about an assumption or claim.

The request: add an add-on **"Advise Research If Unsure"**. When enabled, it appends a directive instructing the planner to (1) identify assumptions/statements it is not fully confident about, (2) emit a ready-to-run **research prompt** covering exactly those uncertainties — reusing the same research-prompt structure the Planning panel already uses in its Research tab — and (3) advise the user to run that prompt through Google AI Studio (search-grounded), Claude, or the user's research agent of choice.

### Root cause

This is a missing feature, not a bug. The add-on plumbing is well-established and the research-prompt template already exists; we just wire a new toggle into it.

- **Add-on toggles (UI):** `src/webview/kanban.html:2810-2869` — the `.checkbox-group` of `plannerAddon*` checkboxes (e.g. `plannerAddonSkipTests` at 2866).
- **Toggle → roleConfig listener:** `src/webview/kanban.html:3963-3982` — the `forEach` over the addon-id array maps each checkbox to `roleConfigs.planner.addons[<key>]` and calls `saveRoleConfig('planner')` + `refreshPreview()`.
- **roleConfig → PromptBuilderOptions:** `src/services/KanbanProvider.ts` — planner-only addons are read in `_getPromptsConfig()` (e.g. `aggressivePairProgramming` at 2914) and applied to `resolvedOptions` in the planner branch (`KanbanProvider.ts:2786`).
- **Directive assembly:** `src/services/agentPromptBuilder.ts` — option flags are destructured near 421-432, directive constants defined near 283-300, and the planner prompt is assembled in the `role === 'planner'` block (484-573).
- **Existing research-prompt template (to reuse):** `src/webview/planning.js:5032-5070` — `generateResearchPrompt()`. **This is plain JavaScript, not a Claude "skill".** It is a *meta-prompt*: it instructs an IDE agent to draft a research prompt for Google AI Studio with a specific structure (ROLE, CONTEXT, CENTRAL QUESTION, 4-6 SUB-QUESTIONS, SOURCE GUIDANCE, SCOPE, OUTPUT format, ≥50 sources). The new directive reuses **that same structure** so the planner's emitted research prompt is consistent with the Research tab.

## Metadata

**Complexity:** 3/10
**Tags:** feature, planner, prompt-builder, addon

## User Review Required

None. The behavior is fully specified by the request: a planner-only toggle that appends a fixed directive. The directive text mirrors the existing `generateResearchPrompt()` structure (`planning.js:5032-5070`) so there is no ambiguity about what "research prompt" means here. Default state: **off** (opt-in, like other non-default add-ons).

## Complexity Audit

### Routine
- One new checkbox in `kanban.html`.
- One new entry in the addon-id listener array.
- One new `roleConfigs.planner.addons` key read in `KanbanProvider.ts`.
- One new `PromptBuilderOptions` field + one directive constant + one append in `agentPromptBuilder.ts`.

### Complex / Risky
- **None.** This is purely additive prompt text gated behind an opt-in flag. No state schema change that needs migration (the addon is stored inside the existing `roleConfig_planner.addons` object, which already tolerates arbitrary keys — `KanbanProvider.ts:2914`-style reads use `?? false`). Absent key → directive off → identical to today.

## Edge-Case & Dependency Audit

1. **Default off, back-compat.** Existing installs have no `adviseResearch` key in `roleConfig_planner.addons`. The read uses `?? false`, so the directive is absent — byte-identical planner prompts for users who don't enable it. No migration required (key lives in an already-extensible object).
2. **Single source of truth for the template.** `generateResearchPrompt()` lives in the webview (`planning.js`), but the planner directive is assembled in the extension (`agentPromptBuilder.ts`) — the two cannot share a function across the webview/extension boundary without a build change. Resolution: define a new directive constant `ADVISE_RESEARCH_DIRECTIVE` in `agentPromptBuilder.ts` whose embedded research-prompt structure **mirrors** the `generateResearchPrompt()` field list (ROLE/CONTEXT/CENTRAL QUESTION/SUB-QUESTIONS/SOURCE GUIDANCE/SCOPE/OUTPUT/≥50 sources). Add a one-line comment in both places pointing at the other so they stay in sync. (Do NOT attempt a runtime import of webview JS into the extension — the VSIX has no node_modules and webpack bundles only the extension entry.)
3. **Combines with other add-ons.** The directive is appended via the same `plannerBase += '\n\n' + ...` pattern used by `SKIP_COMPILATION_DIRECTIVE`/`SKIP_TESTS_DIRECTIVE` (`agentPromptBuilder.ts:522-527`), so ordering and spacing are consistent and it composes cleanly with Caveman Output, Git Prohibition, etc.
4. **Planner-only.** This add-on is meaningful only for the planner role; wire it exactly like `aggressivePairProgramming` (planner-branch `resolvedOptions` assignment at `KanbanProvider.ts:2786`), not via the by-role maps (skipCompilationByRole etc.). It must not appear for or affect other roles.
5. **Preview refresh.** The listener calls `refreshPreview()` (`kanban.html:3978`), so the Prompts-tab live preview reflects the toggle immediately — no extra wiring needed.
6. **No confirm dialogs** involved.

### Race Conditions
- None. Toggle write → `saveRoleConfig('planner')` → preview refresh is the same sequential path every existing add-on uses.

### Security
- None. The directive is static text; no secrets, no network calls. It only instructs the planner to *advise* the user to run a research prompt externally — Switchboard itself makes no external request.

### Side Effects
- Enabling the add-on lengthens the planner prompt by the directive (a few hundred tokens). This is expected and opt-in.

### Dependencies & Conflicts
- No conflict with the Research tab — that feature (`planning.js:5032-5070`) is untouched; we only mirror its structure.
- No conflict with the existing constitution/design-doc add-ons — independent flag.

## Proposed Changes

### 1. `src/webview/kanban.html` — add the checkbox (after `plannerAddonSkipTests`, ≈2869)

```html
<label class="checkbox-item" title="Instruct the planner to emit a research prompt for anything it is not 100% sure about">
  <input type="checkbox" id="plannerAddonAdviseResearch">
  <span>Advise Research If Unsure</span>
  <span class="tooltip">Planner outputs a research prompt (for Google AI Studio / Claude / your research agent) covering its uncertain assumptions</span>
</label>
```

### 2. `src/webview/kanban.html` — register the listener (≈3964)

Add `'plannerAddonAdviseResearch'` to the addon-id array. The existing `forEach` then derives the storage key automatically: `plannerAddonAdviseResearch` → strip `plannerAddon` → `AdviseResearch` → camelCase → **`adviseResearch`** (no `addonIdMap` entry needed). It will be saved to `roleConfigs.planner.addons.adviseResearch` and trigger `saveRoleConfig('planner')` + `refreshPreview()`.

```js
['plannerAddonSwitchboardSafeguards', /* …existing… */ 'plannerAddonSkipTests', 'plannerAddonAdviseResearch'].forEach(id => {
```

### 3. `src/services/KanbanProvider.ts` — read the flag and apply to planner options

In `_getPromptsConfig()`, alongside `aggressivePairProgramming` (≈2914):
```ts
adviseResearchIfUnsure: plannerConfig?.addons?.adviseResearch ?? false,
```
In the planner branch where `aggressivePairProgramming` is assigned (≈2786):
```ts
resolvedOptions.adviseResearchIfUnsure = promptsConfig.adviseResearchIfUnsure;
```

### 4. `src/services/agentPromptBuilder.ts` — option, directive constant, append

**(a)** Add to `PromptBuilderOptions` (near the other planner flags, ≈146-150):
```ts
adviseResearchIfUnsure?: boolean;
```

**(b)** Add the directive constant (near `SKIP_TESTS_DIRECTIVE`, ≈300). Mirrors `generateResearchPrompt()` in `src/webview/planning.js:5032-5070` — keep in sync:
```ts
export const ADVISE_RESEARCH_DIRECTIVE = `RESEARCH WHEN UNSURE: As you plan, track every assumption, factual claim, API/behavior, or library detail you are NOT 100% certain about. If any exist, append a section titled "## Recommended Research" to your output containing a ready-to-run research prompt that covers ONLY those uncertainties. Structure that research prompt the same way the Switchboard research tool does:
- ROLE for the research analyst
- CONTEXT (domain + audience)
- CENTRAL QUESTION
- 4-6 targeted SUB-QUESTIONS derived from your specific uncertainties
- SOURCE GUIDANCE (authoritative sources, check dates, separate required/recommended/opinion)
- SCOPE boundaries
- OUTPUT format (short H1 title, an "Executive Summary" H2, then tiered findings, trade-offs, glossary, source list)
- CITATIONS: do NOT include inline source URLs or citations in the body; attach all references as a single consolidated list at the END only
- DEPTH with a target of at least 50 authoritative sources
Then advise the user to run that prompt through Google AI Studio (search grounding enabled), Claude, or their research agent of choice, and to feed the findings back before implementation. If you are confident about everything, state that no research is needed and omit the section.`;
```

**(c)** Destructure the flag with the other planner flags (≈432):
```ts
const adviseResearchIfUnsure = options?.adviseResearchIfUnsure ?? false;
```

**(d)** Append it in the planner block, alongside the skip directives (≈525-527):
```ts
if (adviseResearchIfUnsure) {
    plannerBase += '\n\n' + ADVISE_RESEARCH_DIRECTIVE;
}
```

## Verification Plan

### Automated Tests
No automated tests required for this session — the suite is run separately by the user. (Per session directive: skip compilation and automated tests.) `src/` is the source of truth; do not build/inspect `dist/`.

### Manual Verification
1. **Toggle present:** Open Kanban → Prompts → Add-ons. Confirm a new "Advise Research If Unsure" checkbox renders below "Do not run automated tests", default **unchecked**.
2. **Off = no change:** With it unchecked, confirm the planner prompt preview contains no "RESEARCH WHEN UNSURE" text (byte-identical to before).
3. **On = directive appears:** Check it. Confirm the live preview (`refreshPreview()`) now includes the `ADVISE_RESEARCH_DIRECTIVE` block, and that it composes correctly with other enabled add-ons (e.g. Caveman Output, Skip Tests) without spacing glitches.
4. **Persistence:** Reload the panel; confirm the toggle state survives (stored in `roleConfig_planner.addons.adviseResearch`).
5. **Planner-only:** Confirm no other role's prompt (coder/reviewer/etc.) gains the directive.
6. **Structure parity:** Eyeball the emitted research-prompt structure against `generateResearchPrompt()` (`planning.js:5032-5070`) — same field list (ROLE/CONTEXT/CENTRAL QUESTION/SUB-QUESTIONS/SOURCE GUIDANCE/SCOPE/OUTPUT/≥50 sources).

---

**Recommendation:** Complexity 3/10 → **Send to Intern.**
