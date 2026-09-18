# Fix: Afterburner Theme Tab-Navigation Background Is a Lighter Grey Than Other Themes

## Goal

In the **Afterburner** theme, the tab-navigation bar (the `.shared-tab-bar` across every webview) renders a **lighter grey** than in the other themes (**Claudify**, **Afterburner Professional**), whose tab bars are near-pure black. The user prefers the darker look and wants Afterburner's tab bar to match.

### Problem analysis & root cause

All webviews define the same base background tokens in `:root`:

- `--panel-bg: #000000;` (pure black) — e.g. `src/webview/kanban.html:18`.
- `--panel-bg2: #0a0a0a;` — `src/webview/kanban.html:19`.

The base `.shared-tab-bar` uses the fully-opaque token, so Claudify and Afterburner-Pro get pure black. **Afterburner alone** overrides the tab bar with a *semi-transparent* colour plus a backdrop blur:

```css
/* src/webview/kanban.html:2446-2450 */
.cyber-theme-enabled .shared-tab-bar {
  background: rgba(10, 10, 10, 0.65);   /* 65% opaque near-black */
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}
```

**Root cause:** `rgba(10, 10, 10, 0.65)` is only 65% opaque. The remaining 35% lets whatever sits behind the bar bleed through, so the bar composites to a **lighter grey** instead of the intended near-black. The other themes use the opaque `var(--panel-bg)` (`#000000`), which is why they look darker. This is a "glassmorphism" effect (the blur) that came at the cost of darkness. There is exactly one such rule per webview file — there are no other Afterburner background overrides on the tab bar.

This exact override is duplicated verbatim across **six** files — five webview HTML files with inline copies, plus the canonical shared CSS file:

| File | Line | Notes |
| :-- | :-- | :-- |
| `src/webview/kanban.html` | 2446-2450 | Inline copy |
| `src/webview/planning.html` | 3340-3343 | Inline copy |
| `src/webview/design.html` | 3596-3599 | Inline copy (plan previously said ~3588; actual is 3596) |
| `src/webview/project.html` | 659-662 | Inline copy |
| `src/webview/setup.html` | 481-484 | Inline copy |
| `src/webview/shared-tabs.css` | 59-63 | Canonical shared CSS — copied to `dist/webview/shared-tabs.css` by webpack CopyPlugin (`webpack.config.js:89-91`). Not currently loaded at runtime (the `{{SHARED_TABS_CSS_URI}}` placeholder in `PlanningPanelProvider.ts:387` is dead code — no source HTML file uses it), but must be updated for consistency and grep-audit correctness. |

**Fix:** make Afterburner's `.shared-tab-bar` fully opaque (pure black), matching the other themes, while keeping the blur (now a no-op visually over an opaque fill but harmless). Apply identically to all six files.

## Metadata

- **Tags:** `frontend`, `ui`, `bugfix`
- **Complexity:** 2
- **Affected components:** the `.cyber-theme-enabled .shared-tab-bar` rule in five webview HTML files plus `shared-tabs.css`.
- **Migration required:** No (CSS-only; no persisted state).

## User Review Required

No. This is a pure CSS colour-value change with no behavioral, schema, or state implications. The fix makes Afterburner's tab bar visually match the other themes. No user data or workflow is affected.

## Complexity Audit

### Routine
- Pure CSS value change to one rule, replicated across six files. No JS, no state, no schema.
- The only diligence required is consistency: the rule is copy-pasted per file (as the in-file comment at `src/webview/kanban.html:2452-2453` notes — "kanban.html has its own inline copy of these tab styles"), so all six must be updated or the themes will diverge between panels.
- All six files define `--panel-bg` in `:root` (or, for `shared-tabs.css`, rely on the host HTML's `:root`), so `var(--panel-bg)` resolves everywhere.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **All six files must change together.** Missing one leaves that panel's Afterburner tab bar lighter than the rest (for HTML files), or leaves the canonical shared CSS inconsistent (for `shared-tabs.css`). Producing an inconsistent look across kanban/planning/design/project/setup.
- **Keep vs drop the blur.** `backdrop-filter: blur(10px)` over a fully opaque background has no visible effect (nothing shows through to blur). Keeping it is harmless and minimizes the diff; dropping it is also fine. Recommendation: **keep** the blur lines to minimize churn and preserve intent if the design later reintroduces translucency — only the colour needs to change.
- **Do not touch the active-tab glow.** `.cyber-theme-enabled .shared-tab-btn.active` (`src/webview/kanban.html:2443-2445`) supplies the cyan glow accent — leave it untouched; it is unrelated to the bar darkness.
- **Token vs literal.** Use `var(--panel-bg)` rather than a hard-coded `#000000` so the bar tracks the theme's base background token (already `#000000` in `:root`) and stays consistent if that token is ever retuned. All five HTML files define `--panel-bg` in `:root`; `shared-tabs.css` uses `var(--panel-bg)` in its base `.shared-tab-bar` rule (line 6) and relies on the host HTML's `:root`, so the variable resolves there too.
- **No regression to other themes.** The change is scoped under the `.cyber-theme-enabled` selector, so Claudify (`body.theme-claudify`) and Afterburner-Pro (`body.theme-afterburner-pro`) — which already use the opaque base rule — are unaffected.
- **Out-of-scope related issue (do NOT fix here):** The same `rgba(10, 10, 10, 0.65)` translucent value is also used on `.cyber-theme-enabled .controls-strip` in `project.html:735`, `design.html:2224`, and `planning.html:2205`. These controls strips have the same "lighter grey in Afterburner" problem but are outside this plan's scope (tab bar only). Noted here so the grep audit can be scoped correctly and so a future plan can address them if desired.

## Dependencies

None. This is a self-contained CSS change with no prerequisite plans or sessions.

## Adversarial Synthesis

Key risks: (1) missing `shared-tabs.css` would leave the canonical source inconsistent and break the grep audit; (2) the grep audit as originally written was too broad — it would catch out-of-scope `.controls-strip` occurrences and report false failures. Mitigations: update all six files; scope the grep audit to the tab-bar rule only (`grep -rn "cyber-theme-enabled .shared-tab-bar" src/webview` and verify each match has `var(--panel-bg)`, not `rgba`).

## Proposed Changes

In **each** of the six files, change the Afterburner tab-bar rule from the translucent fill to the opaque token. Example for `src/webview/kanban.html:2446-2450`:

```css
.cyber-theme-enabled .shared-tab-bar {
  background: var(--panel-bg);          /* was: rgba(10, 10, 10, 0.65) — opaque pure black to match other themes */
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}
```

Apply the identical one-line change (`background: rgba(10, 10, 10, 0.65);` → `background: var(--panel-bg);`) to the matching rule in:

- `src/webview/planning.html` (line 3341)
- `src/webview/design.html` (line 3597)
- `src/webview/project.html` (line 660)
- `src/webview/setup.html` (line 482)
- `src/webview/shared-tabs.css` (line 60)

> During implementation, re-grep each file for `cyber-theme-enabled .shared-tab-bar` to confirm the exact line (line numbers drift) and that each contains the same `rgba(10, 10, 10, 0.65)` value before editing.

## Verification Plan

### Automated Tests

No automated tests apply (pure CSS visual change). Verification is manual + grep audit.

1. **Visual A/B across themes:** Open the kanban panel. Switch theme to **Claudify**, then **Afterburner Professional**, noting the near-black tab bar. Switch to **Afterburner** — the tab bar must now be visually identical in darkness (pure black), not lighter grey.
2. **All five panels:** Repeat the Afterburner check in the planning, design, project, and setup webviews. The tab bar must be uniformly dark in every panel.
3. **Active-tab accent intact:** Confirm the active tab still shows the cyan glow (`.shared-tab-btn.active`) in Afterburner — only the bar background changed.
4. **Other themes unchanged:** Confirm Claudify and Afterburner-Pro tab bars look exactly as before (no visible diff).
5. **Grep audit (scoped):** Run `grep -rn "cyber-theme-enabled .shared-tab-bar" src/webview` and verify every match is immediately followed by `background: var(--panel-bg);` (not `rgba(10, 10, 10, 0.65)`). This confirms all six copies were updated without false-positive matches from the out-of-scope `.controls-strip` rules.
6. **Broad grep audit (informational):** `grep -rn "rgba(10, 10, 10, 0.65)" src/webview` should now return only the 3 `.controls-strip` matches (project.html:735, design.html:2224, planning.html:2205) — these are out of scope and expected to remain. If any `shared-tab-bar` match appears, the fix is incomplete.

> **Recommendation:** Send to Intern (complexity 2 — routine single-line CSS change replicated across files).

## Reviewer Pass (2026-06-25)

### Stage 1 — Grumpy Principal Engineer

*Theatrical mode ON. Squinting at the diff like it owes me money.*

Oh, a **one-line CSS change** across six files. The kind of task that's *so* simple it's *exactly* the sort of thing someone botches by updating five files and forgetting the sixth. Let me poke at every corner.

1. **[NIT] The blur is now a no-op.** `backdrop-filter: blur(10px)` over a fully opaque `var(--panel-bg)` (#000000) blurs *nothing* — there's no translucency for the backdrop to show through. You kept it "to minimize churn," which is a defensible call, but let's be honest: it's dead CSS wearing a tuxedo. Not worth fixing now (churn vs. payoff), but a future cleanup plan could strip it. **Keep as-is.**

2. **[NIT] Token vs. literal — actually verified.** I checked: `--panel-bg` is defined *exactly once* per file in `:root` (`#000000`) and is **never** re-declared under `.cyber-theme-enabled` or any other theme selector. So `var(--panel-bg)` cannot drift to a lighter value in Afterburner context. The token choice is sound, not just cosmetic. Good.

3. **[NIT] `implementation.html` was excluded — correctly.** I went looking for a seventh file to yell about. `implementation.html` defines `--panel-bg: #000000` but has **no** `.cyber-theme-enabled .shared-tab-bar` rule (grep confirms only 6 matches total). It references `cyber-theme-enabled` solely in JS theme-switching logic. So it either uses the base opaque rule or doesn't render a shared tab bar. Either way it's correctly out of scope. No gap here. *Disappointed, honestly — I wanted to find a miss.*

4. **[NIT] The fix landed in an unrelated commit.** `git log -S` shows the `rgba → var(--panel-bg)` swap was bundled into commit `aa73349` ("Replace the Constitution Enter Relative Path Gear Menu..."). Sloppy commit hygiene — a CSS colour fix riding inside a modal-UI commit — but that's a process nit, not a code defect. The working tree is correct, which is what this review judges.

5. **[CRITICAL] — just kidding, there are none.** All six files match the plan's prescribed diff *exactly*: `background: var(--panel-bg);` on the line immediately following `.cyber-theme-enabled .shared-tab-bar {`, blur lines preserved, active-tab glow rule (`box-shadow: ...color-mix...accent-teal...`) untouched in all six files. The grep audit returns exactly the 3 expected out-of-scope `.controls-strip` matches and zero stray `shared-tab-bar` matches.

*Theatrical mode OFF.* This is a clean, complete, low-risk implementation. Nothing to fix.

### Stage 2 — Balanced Synthesis

| Finding | Severity | Disposition |
| :-- | :-- | :-- |
| Blur lines now visually inert over opaque fill | NIT | **Keep** — minimizes diff, preserves intent for future translucent redesign. Defer cleanup. |
| Token resolves correctly (no theme override of `--panel-bg`) | NIT | **Verified, no action** — confirms the fix is robust, not just visually correct. |
| `implementation.html` correctly excluded | NIT | **No action** — confirmed no `.shared-tab-bar` override exists there. |
| Fix committed inside an unrelated commit | NIT | **No action** (process note only) — working tree is correct; commit hygiene is out of scope for a code review. |
| All 6 files updated identically; active-tab glow intact | — | **Verified passing.** |

**Verdict:** No CRITICAL or MAJOR findings. No code fixes required. The implementation satisfies every requirement in the Proposed Changes, Edge-Case Audit, and Verification Plan.

### Code Fixes Applied

None. The implementation was already correct.

### Verification Results

Per the Verification Plan (compilation and automated tests skipped per session instructions — this is a pure CSS change with no applicable test suite anyway):

1. **Scoped grep audit** — `grep -rn "cyber-theme-enabled .shared-tab-bar" src/webview`:
   - 6 matches (kanban.html:2446, planning.html:3340, design.html:3596, project.html:659, setup.html:481, shared-tabs.css:59).
   - **Every** match is immediately followed by `background: var(--panel-bg);`. **PASS.**

2. **Broad grep audit** — `grep -rn "rgba(10, 10, 10, 0.65)" src/webview`:
   - 3 matches remain: `project.html:735`, `design.html:2224`, `planning.html:2205` — all on `.cyber-theme-enabled .controls-strip` (out of scope, explicitly noted in the plan). **PASS.**

3. **Token resolution check** — `--panel-bg` defined once per file in `:root` as `#000000`; no theme-scoped override exists. `var(--panel-bg)` resolves to pure black in Afterburner. **PASS.**

4. **Active-tab glow intact** — `.cyber-theme-enabled .shared-tab-btn.active` rule present and unchanged in all 6 files (kanban.html:2443, planning.html:3337, design.html:3593, project.html:656, setup.html:478, shared-tabs.css:55). **PASS.**

5. **`implementation.html` scope check** — no `.cyber-theme-enabled .shared-tab-bar` rule present; correctly excluded from the fix set. **PASS.**

6. **Visual A/B + all-panels + other-themes-unchanged** (manual checks #1–4) — not executable in this headless review session; deferred to the user. The code state guarantees these will pass given the opaque-token resolution confirmed above.

### Files Changed (confirmed in working tree)

- `src/webview/kanban.html:2447` — `background: var(--panel-bg);`
- `src/webview/planning.html:3341` — `background: var(--panel-bg);`
- `src/webview/design.html:3597` — `background: var(--panel-bg);`
- `src/webview/project.html:660` — `background: var(--panel-bg);`
- `src/webview/setup.html:482` — `background: var(--panel-bg);`
- `src/webview/shared-tabs.css:60` — `background: var(--panel-bg);`

### Remaining Risks

- **None material.** The only residual items are NITs: the now-inert `backdrop-filter` lines (harmless, kept deliberately) and the out-of-scope `.controls-strip` translucent fills (project.html:735, design.html:2224, planning.html:2205) which exhibit the *same* lighter-grey-in-Afterburner symptom but are explicitly deferred to a future plan per the Edge-Case Audit.
- **Manual visual confirmation** (Verification steps 1–4) still pending user execution; code state makes failure highly unlikely.
