# Remove the Pixel-Font Option From the Claudify Theme

## Goal

Remove the pixel-font feature from the Claudify theme entirely. Claudify markdown **H1** headings should render in the same body font (Hanken Grotesk) as **H2–H6**, and the user-facing "Pixel Font" toggle, its backing setting, its body class, its CSS overrides, and **all** of its message-handler / broadcast wiring should be deleted across every panel.

### Problem / background / root-cause analysis

The pixel-font option was added by plan `7227540d` (`feature_plan_20260630_claudify-pixel-font-and-afterburner-ultracode-toggles.md`) as an opt-out for users who disliked the `GeistPixel` H1 aesthetic. It is Claudify-only and defaults ON. The user has decided the pixel-font H1 look does not belong in Claudify, so the feature (not just the toggle) should be removed.

> **Superseded:** "The feature is spread across **seven** touchpoints, all verified against current source." (original enumeration: package.json setting; themeBodyClass body class; H1 CSS in three webviews; the `claudify-pixel-font-disabled` overrides; setup.html UI; SetupPanelProvider cases; TaskViewerProvider wiring.)
> **Reason:** A full-repo sweep (`grep -rIn "pixelFont\|pixel-font\|PixelFont"`) during this improve pass found the feature spread across **16 files**, not seven. The original list omitted (a) the live-update `affectsConfiguration('switchboard.theme.pixelFont')` listeners in **DesignPanelProvider** (×2) and **PlanningPanelProvider** (×3); (b) the inbound `case 'pixelFontSetting'` webview handlers in **five** webviews (`design.js`, `kanban.html`, `planning.js`, `project.js`, and a second one in `setup.html` at ~4962); and (c) the generated verb allowlist (`src/generated/verbAllowlist.ts`) plus its source `protocol-catalog.json`. If a coder deletes only the original seven, the plan's own Verification Plan step 2 ("confirm zero remaining references") **fails**, and the feature is left half-excised (dangling broadcasts + dead `case` handlers).
> **Replaced with:** The complete 16-file removal checklist in **## Proposed Changes** below. Every reference is enumerated; the grep-sweep in Verification is now actually achievable.

**The complete surface (all verified against current source, 2026-07-16):**

1. **Setting** — `switchboard.theme.pixelFont` (boolean, default `true`) declared in `package.json:753–758`.
2. **First-paint body class** — `src/services/themeBodyClass.ts:57–61` appends ` claudify-pixel-font-disabled` to the Claudify body when the setting is false.
3. **H1 pixel-font CSS rules** (the actual `GeistPixel` rendering) in three webviews:
   - `src/webview/planning.html:2368–2375` — `#markdown-preview h1, #markdown-preview-tickets h1`
   - `src/webview/design.html:2308–2316` — `#markdown-preview-briefs h1, #markdown-preview-design h1`
   - `src/webview/project.html:681–687` — 6 selectors (`#kanban-preview-content h1` … `#projects-preview-content h1`)
4. **`claudify-pixel-font-disabled` override CSS** (the "OFF" fallback) immediately follows each H1 rule:
   - `planning.html:2377–2382`, `design.html:2318–2323`, `project.html:687–691`
5. **Setup UI** — `src/webview/setup.html`:
   - The `#theme-pixel-font-settings` block (lines 1345–1357): subsection header + `#pixel-font-toggle` checkbox + `#pixel-font-status`.
   - `updateAnimationSectionVisibility()` (lines 1980–1983) shows/hides that section for Claudify.
   - The `'theme'` tab-load callback posts `getPixelFontSetting` (line 2078).
   - The `#pixel-font-toggle` change handler (lines 4232–4240) posts `setPixelFontSetting` and toggles the body class.
   - **[Added]** The inbound `case 'pixelFontSetting'` message handler (lines 4962–4970) that syncs the checkbox and toggles the body class.
6. **Message-case handlers** — `src/services/SetupPanelProvider.ts:880–890` (`getPixelFontSetting` / `setPixelFontSetting` cases routing to the TaskViewerProvider handlers).
7. **TaskViewerProvider wiring** — `src/services/TaskViewerProvider.ts`:
   - `affectsConfiguration('switchboard.theme.pixelFont')` listener (lines 629–634) broadcasting `pixelFontSetting` to all webviews.
   - `handleGetPixelFontSetting()` (lines 5155–5157) and `handleSetPixelFontSetting()` (lines 5159–5163).
   - `postSetupPanelState()` broadcast (lines 5585–5588).
8. **[Added] DesignPanelProvider wiring** — `src/services/DesignPanelProvider.ts`: two `affectsConfiguration('switchboard.theme.pixelFont')` listeners posting `pixelFontSetting` (lines 496–499 and 603–606).
9. **[Added] PlanningPanelProvider wiring** — `src/services/PlanningPanelProvider.ts`: three `affectsConfiguration('switchboard.theme.pixelFont')` listeners posting `pixelFontSetting` (lines 598–601 via `postMessageToProjectWebview`, 758–761 and 925–928 via `postMessageToWebview`).
10. **[Added] Inbound `case 'pixelFontSetting'` webview handlers** (each toggles `claudify-pixel-font-disabled` on `document.body`):
    - `src/webview/design.js:4146–4148`
    - `src/webview/kanban.html:6911–6913`
    - `src/webview/planning.js:4875–4877`
    - `src/webview/project.js:420–422`
    - (`setup.html`'s inbound handler is listed under item 5.)
11. **[Added] Generated verb allowlist** — `src/generated/verbAllowlist.ts:15` lists `getPixelFontSetting` and `setPixelFontSetting` in `SETUP_VERBS`. This file is **generated** from `protocol-catalog.json` by `scripts/generate-verb-allowlist.js`; `scripts/check-protocol-parity.js` is a CI drift guard. The verbs also appear throughout `protocol-catalog.json` (the catalog source). Removing the message cases alone will not update the generated file — it must be **regenerated**, and the catalog entries removed, or the CI parity check drifts.

**Root cause:** the feature is unwanted and must be fully excised. Because H2–H6 already resolve to Hanken + terracotta and, critically, the **base** markdown H1 rule already resolves to terracotta under Claudify (see the color-preservation note below), removing the H1 pixel override needs no replacement rule.

#### Color-preservation reasoning (non-obvious — document so a reviewer does not panic)

Deleting the Claudify H1 override does **not** strip H1's terracotta color, even though the H2–H6 Claudify rule targets only `h2…h6`. The chain is:
- Base rule `#markdown-preview h1…h6 { color: var(--doc-heading); }` (`planning.html:1063–1073`).
- `:root { --doc-heading: var(--accent-primary); }` (`planning.html:85`).
- `body.theme-claudify { --accent-primary: #D97757; }` (`planning.html:92`).

`var()` resolves at use-time, so under `body.theme-claudify` the base H1's `color: var(--doc-heading)` → `var(--accent-primary)` → **`#D97757`** (terracotta). Font-family: the base H1 sets no `font-family`, so under Claudify (non-cyber) it inherits `--font-family` = **Hanken Grotesk**. Net: after deletion, Claudify H1 = Hanken + terracotta, matching H2–H6 in *font and color*.

> **Superseded:** "H1 inherits the base markdown H1 styling and visually matches H2–H6 (terracotta, Hanken)."
> **Reason:** True for *font and color*, but overstated as a full visual match. The base H1 rule (`planning.html:1101–1113`, and equivalents in the other webviews) also applies `text-transform: uppercase`, a teal-dim `border-bottom` + `border-left`, and `font-size: 2.25rem` — treatments H2–H6 lack. The pixel override never removed these, so today's Claudify H1 already carries them; deletion leaves them in place.
> **Replaced with:** After deletion, Claudify H1 renders in **Hanken + terracotta** (the stated goal) while retaining its base structural heading treatment (uppercase + teal-dim borders + larger size), identical to the Afterburner/default H1. Removing the border/uppercase treatment is **out of scope** for this plan — the goal is specifically the *font* ("same body font as H2–H6"), not a pixel-perfect H1↔H2 match.

**Interpretation note (preserved):** "remove the pixel font option" is read as removing the pixel-font rendering *and* its toggle/setting/wiring together — keeping the toggle with nothing to toggle would be dead UI. If the intent was instead to keep GeistPixel always-on and only drop the checkbox, that is a smaller change; this plan assumes the pixel aesthetic itself is being dropped.

## Metadata

- **Tags:** frontend, ui, refactor, cleanup
- **Complexity:** 4

## User Review Required

- **None.** The interpretation ("excise the whole feature, not just the checkbox") is documented above and consistent with the user's stated decision that the pixel-font H1 look does not belong in Claudify. Removing the H1 border/uppercase treatment is explicitly out of scope.

## Complexity Audit

### Routine
- Delete one `package.json` setting entry.
- Delete three H1 CSS rule blocks + three `claudify-pixel-font-disabled` override blocks (straight deletion; no replacement rules needed — see color-preservation reasoning).
- Delete the `#theme-pixel-font-settings` HTML block, the visibility line, the tab-load post, the toggle change handler, and the inbound `case 'pixelFontSetting'` handler in `setup.html`.
- Delete the two `case` blocks in `SetupPanelProvider.ts`.
- Delete the listener, two handler methods, and the `postSetupPanelState` broadcast in `TaskViewerProvider.ts`.
- Delete the two listeners in `DesignPanelProvider.ts` and the three in `PlanningPanelProvider.ts`.
- Delete the four inbound `case 'pixelFontSetting'` handlers in `design.js`, `kanban.html`, `planning.js`, `project.js`.
- Remove the `pixelFont` read + class append in `themeBodyClass.ts`.

### Complex / Risky
- **Generated-file gotcha (the one non-obvious step):** `src/generated/verbAllowlist.ts` is generated from `protocol-catalog.json`. Removing the `getPixelFontSetting`/`setPixelFontSetting` verbs requires editing `protocol-catalog.json` **and** regenerating (`node scripts/generate-verb-allowlist.js --write`), otherwise `scripts/check-protocol-parity.js` reports drift. Do not hand-edit `verbAllowlist.ts`.
- Everything else is deletion of self-contained, additive feature code. No data migration is required — an orphaned `theme.pixelFont` value in a user's global config is silently ignored once the setting key is gone (VS Code tolerates unknown keys). This is unreleased-vs-shipped-neutral: removing a setting never destroys user data, only leaves an inert key.

## Edge-Case & Dependency Audit

- **Race Conditions:** none — synchronous deletion of config listeners and message handlers; no concurrent state.
- **Security:** none — local UI/setting cleanup only; no external surface, no input handling changed.
- **Side Effects:**
  - **Stale user setting:** users who previously toggled `switchboard.theme.pixelFont` keep a leftover global/workspace value. After removal the key is unknown to VS Code and silently ignored — no error, no migration needed.
  - **First-paint flash:** removing `claudify-pixel-font-disabled` from `getThemeBodyClass()` cannot cause a flash — the class only ever *suppressed* styling; with the H1 override gone there is nothing to suppress.
  - **Half-excision (the real risk):** if only the CSS/setting is removed but the broadcasts (DesignPanelProvider/PlanningPanelProvider/TaskViewerProvider) and inbound `case` handlers are left, they become harmless dead code — `classList.toggle('claudify-pixel-font-disabled', …)` toggles a class with no CSS, and broadcasts land on webviews that no longer handle them. Harmless functionally, but leaves the feature half-removed and fails the grep-sweep. The full checklist below prevents this.
- **Dependencies & Conflicts:**
  - **`--display-font` CSS var:** `--display-font: 'GeistPixel'` is declared on `:root` in the three webviews but consumed zero times. Dead and out of scope — leave untouched.
  - **`ultracodeAnimation` setting:** sibling feature added by the same original plan (`7227540d`). Untouched — only the pixel-font half is removed. The `ultracodeAnimation` listeners sit immediately after each `pixelFont` listener in all providers — delete only the `pixelFont` block, leave the `ultracodeAnimation` block intact.
  - **Shared file with the sibling subtask:** `feature_plan_20260716151402_devdocs-tab-sidebar-cards.md` also edits `src/webview/planning.js`, but in `renderDevDocsList()` (~line 12127+), far from this plan's `case 'pixelFontSetting'` deletion (~line 4875). No overlap; either order.

## Dependencies

- `sess_local_20260716 — improve-feature: Claudify & Planning Tab UI Polish` (this feature; sibling subtask = Dev Docs sidebar cards, independent)

## Adversarial Synthesis

Key risks: (1) **incomplete removal** — the original plan under-counted the feature by 9 sites, so following it literally leaves dangling broadcasts + dead `case` handlers and fails the plan's own grep-sweep; (2) **generated-file drift** — deleting the message cases without regenerating `verbAllowlist.ts` from `protocol-catalog.json` trips the CI parity check; (3) **false "color regression" alarm** — a reviewer may fear pure H1 deletion strips terracotta (it does not — `--doc-heading`→`--accent-primary`→`#D97757` under Claudify). Mitigations: the exhaustive 16-file checklist below, an explicit "regenerate + run parity check" verification step, and the documented color-preservation chain.

## Proposed Changes

### 1. `package.json` — remove the setting
Delete lines 753–758 (the `switchboard.theme.pixelFont` block), leaving `colourKanbanIcons` and `ultracodeAnimation` adjacent.

### 2. `src/services/themeBodyClass.ts` — drop the body class
In `getThemeBodyClass()` (lines 57–61), simplify the Claudify branch to:
```ts
if (theme === 'claudify') {
    return 'theme-claudify' + colourClass;
}
```
Remove the `pixelFontEnabled` / `pixelFontClass` locals.

### 3. `src/webview/planning.html` — delete H1 pixel + override rules
Delete lines 2368–2382 (the `/* Claudify: h1 — pixel font, terracotta */` rule and the `claudify-pixel-font-disabled` override). The H2–H6 rule below remains; the base H1 rule keeps H1 terracotta under Claudify.

### 4. `src/webview/design.html` — delete H1 pixel + override rules
Delete lines 2308–2323 (the `/* Claudify: h1 — pixel font, terracotta */` rule and its `claudify-pixel-font-disabled` override).

### 5. `src/webview/project.html` — delete H1 pixel + override rules
Delete the `/* Claudify: h1 — pixel font, terracotta */` rule (6 selectors, ~line 681–687) and the immediately following `claudify-pixel-font-disabled` override (~line 687–691). Note these are packed onto shared lines (`}body.theme-claudify…`), so delete precisely between the grid-block close and the `/* Claudify: h2-h6 … */` comment.

### 6. `src/webview/setup.html` — remove the UI **and the inbound handler**
- Delete the `#theme-pixel-font-settings` block (lines 1345–1357).
- In `updateAnimationSectionVisibility()` (lines 1980–1983), delete the `pixelFontSection` lookup + display toggle.
- In the `'theme'` tab-load callback (line 2078), delete the `getPixelFontSetting` post.
- Delete the `#pixel-font-toggle` change handler (lines 4232–4240).
- **Delete the inbound `case 'pixelFontSetting':` handler (lines 4962–4970)** that syncs the checkbox and toggles the body class.

### 7. `src/services/SetupPanelProvider.ts` — remove message cases
Delete the `case 'getPixelFontSetting':` and `case 'setPixelFontSetting':` blocks (lines 880–890).

### 8. `src/services/TaskViewerProvider.ts` — remove handler + listener + broadcast
- Delete the `affectsConfiguration('switchboard.theme.pixelFont')` block (lines 629–634) — keep the adjacent `ultracodeAnimation` block.
- Delete `handleGetPixelFontSetting()` (lines 5155–5157) and `handleSetPixelFontSetting()` (lines 5159–5163) in full.
- Delete the `pixelFontSetting` broadcast in `postSetupPanelState()` (lines 5585–5588).

### 9. `src/services/DesignPanelProvider.ts` — remove both listeners
Delete the two `affectsConfiguration('switchboard.theme.pixelFont')` blocks (lines 496–499 and 603–606). Keep the adjacent `theme.name` and `ultracodeAnimation` blocks.

### 10. `src/services/PlanningPanelProvider.ts` — remove all three listeners
Delete the three `affectsConfiguration('switchboard.theme.pixelFont')` blocks (lines 598–601, 758–761, 925–928). Keep the adjacent `ultracodeAnimation` blocks.

### 11. Inbound webview `case 'pixelFontSetting'` handlers — delete all four
- `src/webview/design.js:4146–4148`
- `src/webview/kanban.html:6911–6913`
- `src/webview/planning.js:4875–4877`
- `src/webview/project.js:420–422`

Each is a 2–3 line `case 'pixelFontSetting': document.body.classList.toggle('claudify-pixel-font-disabled', …); break;` — delete the whole case, leave the surrounding `ultracodeAnimationSetting` / `cyber*` cases.

### 12. Generated allowlist + catalog — remove verbs and regenerate
- Remove the `getPixelFontSetting` and `setPixelFontSetting` verb entries from `protocol-catalog.json` (multiple occurrences — the sweep found them at lines ~3099, ~3156, ~3548, ~3553, ~4879, ~6331, ~8377, ~10106, ~13761/13844/16003/18573 (`pixelFontSetting` message), ~25001, ~25815; also the `pixelFontSetting` message definition). Remove the two request verbs and the `pixelFontSetting` outbound message consistently.
- **Regenerate** the allowlist: `node scripts/generate-verb-allowlist.js --write`, which rewrites `src/generated/verbAllowlist.ts` (do NOT hand-edit it).
- Run `node scripts/check-protocol-parity.js` and confirm no drift.

## Verification Plan

> Per session directive: **no project compilation step** and **no automated tests** in this verification. Verification is grep-based + manual visual inspection in the installed VSIX (the repo's `dist/` is not used in dev/testing).

### Automated Tests
- **None** — per session directive. This is a UI/CSS + dead-code-removal change; no unit/integration tests are added or run.

### Manual / observational
1. **Grep sweep (authoritative completion gate):** `grep -rIn "pixelFont\|pixel-font\|claudify-pixel-font-disabled\|getPixelFontSetting\|setPixelFontSetting\|pixelFontSetting\|PixelFont" src/ package.json protocol-catalog.json` returns **zero** matches. (This is now achievable because the full 16-file surface is enumerated above.)
2. **Parity check:** `node scripts/check-protocol-parity.js` passes with no drift after regenerating `verbAllowlist.ts`.
3. **Setup panel:** open Setup → Theme, select Claudify, confirm there is no "Pixel Font" subsection (only Kanban Icons remains Claudify-scoped).
4. **Docs preview (planning):** open the Docs tab under Claudify, preview a markdown doc with an H1 — H1 renders in Hanken Grotesk, terracotta, matching H2–H6 in font/color (H1 keeps its uppercase + border treatment, expected).
5. **Design preview:** repeat in the Briefs/Design preview under Claudify.
6. **Project previews:** repeat across Kanban/Features/Constitution/System/Tuning/Projects previews under Claudify — all six H1 selectors now use Hanken.
7. **Live-update sanity:** with the extension running, changing the Claudify theme (or reloading a panel) shows no console errors from the removed `pixelFontSetting` broadcasts/handlers, and no transient GeistPixel flash on first paint.
8. **Afterburner regression:** switch to Afterburner and confirm H1 rendering is unchanged (no pixel-font rules ever applied to Afterburner).

## Recommendation

Complexity **4** → **Send to Coder.** Purely mechanical, but it spans 16 files and includes the non-obvious "edit `protocol-catalog.json` → regenerate `verbAllowlist.ts` → run parity check" step, which an Intern could miss. No open decisions for the user.

## Completion Report

Fully excised the pixel-font feature across all 16 files. Removed the `switchboard.theme.pixelFont` setting from `package.json`, the `claudify-pixel-font-disabled` body class from `themeBodyClass.ts`, H1 pixel CSS + override rules from `planning.html`/`design.html`/`project.html`, all Setup UI elements and handlers from `setup.html`, message-case handlers from `SetupPanelProvider.ts`, handler methods + listener + broadcast from `TaskViewerProvider.ts`, two listeners from `DesignPanelProvider.ts`, three listeners from `PlanningPanelProvider.ts`, four inbound webview `case 'pixelFontSetting'` handlers (`design.js`/`kanban.html`/`planning.js`/`project.js`), and all 14 verb entries from `protocol-catalog.json`. Regenerated `verbAllowlist.ts` and confirmed `check-protocol-parity.js` passes clean. Grep sweep returns zero matches (excluding out-of-scope `GeistPixel` font-face/URI injection). No issues encountered.
