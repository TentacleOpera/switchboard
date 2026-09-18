# Make the Memo Modal Header Respect the Active Theme (Remove Hardcoded Red)

## Goal

The Memo modal in `kanban.html` shows a "random red" header that ignores the current Switchboard theme. The modal title must use a theme-aware accent so it matches Afterburner / Claudify / future themes.

### Problem Analysis

The Memo modal title is an `<h3 class="modal-title">Memo</h3>` ([kanban.html:2999](src/webview/kanban.html#L2999)). The shared `.modal-title` rule hardcodes a fixed red:

```css
.modal-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--accent-red);   /* kanban.html:1352 */
    margin: 0;
}
```

`--accent-red` is defined once as a literal `#da3633` ([kanban.html:29](src/webview/kanban.html#L29)) and is **not** redeclared per theme. Per the Switchboard theme architecture, themes redeclare the accent var family (e.g. `--accent-primary`), so anything bound to `--accent-red` stays the same fixed red across all themes — hence the "random red header" that never changes with the theme. The themed accent is `--accent-primary` ([kanban.html:25](src/webview/kanban.html#L25), redeclared per theme at [kanban.html:35](src/webview/kanban.html#L35)).

### Root Cause

`.modal-title` is colored with the non-themed `--accent-red` literal instead of the theme-aware `--accent-primary`.

## Metadata

**Complexity:** 2
**Tags:** frontend, ui, bugfix

## User Review Required

No — this is a self-contained CSS variable swap with a fully enumerated blast radius. Proceed once the verification steps pass.

## Complexity Audit

### Routine
- Changing the shared `.modal-title` color from `var(--accent-red)` to `var(--accent-primary)` (single rule, [kanban.html:1349-1354](src/webview/kanban.html#L1349)).
- Confirming `--accent-primary` is redeclared by each theme class (Afterburner at `:root` line 25; Claudify at `body.theme-claudify` line 35).

### Complex / Risky
- `.modal-title` is shared by **seven** modals, not four. Changing the shared rule recolors all of them. Full list of affected modals (verified via grep):
  1. Report Testing Failure — `<h3 class="modal-title">` ([kanban.html:2833](src/webview/kanban.html#L2833))
  2. Routing Map — `<h3 class="modal-title">` ([kanban.html:2853](src/webview/kanban.html#L2853))
  3. Integration Settings — `<h3 class="modal-title">` ([kanban.html:2889](src/webview/kanban.html#L2889))
  4. Kanban Column — `<div class="modal-title">` ([kanban.html:2921](src/webview/kanban.html#L2921)) *(note: `<div>`, not `<h3>`; no `.modal-header` wrapper — layout differs but `color` inherits identically)*
  5. Create Epic — `<h3 class="modal-title">` ([kanban.html:2945](src/webview/kanban.html#L2945))
  6. Manage Epic — `<h3 class="modal-title">` ([kanban.html:2967](src/webview/kanban.html#L2967))
  7. Memo — `<h3 class="modal-title">` ([kanban.html:2999](src/webview/kanban.html#L2999)) *(the modal this plan targets)*
- Decide scope: fix only the memo modal (targeted, Option B) or all modal titles (consistent, Option A). Recommended: **Option A** — make the shared rule theme-aware, since a hardcoded red title is wrong for every modal under a non-red theme.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — static CSS, no JS state involved.
- **Security:** None.
- **Side Effects:** If the shared rule is changed (Option A), every `.modal-title` becomes theme-accent colored. Verified that none of the seven modals depend on red to signal danger in the *title* itself; red-as-warning belongs on destructive *buttons*:
  - Delete Epic button uses inline `color:var(--accent-red); border-color:var(--accent-red);` ([kanban.html:2990](src/webview/kanban.html#L2990)) — unaffected by the `.modal-title` rule change.
  - Error text spans (e.g. [kanban.html:2933](src/webview/kanban.html#L2933), [2586](src/webview/kanban.html#L2586), [2596](src/webview/kanban.html#L2596)) use inline `color:var(--accent-red)` — unaffected.
  - **Manage Epic contrast check:** under Claudify, the title becomes terracotta (`#D97757`) while the Delete Epic button stays red (`#da3633`). The two hues are distinguishable (terracotta vs. true red), so the danger button retains semantic contrast — but this must be eyeballed in verification, not assumed.
- **Dependencies & Conflicts:** Theme var resolution happens at `:root`/`body` scope; `--accent-primary` is redeclared by theme classes (`body.theme-claudify` at line 35), so binding to it makes the title follow the theme automatically. Only two themes ship today (Afterburner = root, Claudify); both define `--accent-primary`. Any future theme that forgets to redeclare it will fall back to the `:root` cyan — non-catastrophic, but worth noting for theme authors.

## Dependencies

None — this plan is self-contained and touches only the shared `.modal-title` CSS rule.

## Adversarial Synthesis

Key risks: (1) the shared rule recolors **seven** modals, not just Memo — two of which (Create Epic, Manage Epic) were missed in the original plan; (2) stale line-number citations could send a coder to the wrong rule; (3) under Claudify the Manage Epic title (terracotta) and Delete Epic button (red) coexist and must be visually confirmed as distinguishable. Mitigations: corrected line numbers, full modal enumeration in the verification steps, and an explicit contrast-check step for Manage Epic under Claudify.

## Proposed Changes

### Option A (recommended) — fix the shared rule

In `src/webview/kanban.html` change `.modal-title` ([kanban.html:1349-1354](src/webview/kanban.html#L1349)):
```css
.modal-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--accent-primary);   /* was var(--accent-red) — now theme-aware */
    margin: 0;
}
```

### Option B (targeted) — scope only the memo modal

Keep `.modal-title` as-is and add a specific override:
```css
#memo-modal .modal-title { color: var(--accent-primary); }
```

**Recommend Option A** for consistency (a hardcoded red title is wrong for every modal under a non-red theme); fall back to Option B only if any modal is found in verification to intentionally rely on the red title.

## Verification Plan

### Automated Tests

None — this is a pure CSS variable swap with no logic surface. The test suite (run separately by the user) is unaffected.

### Manual Verification

1. Open Kanban → Memo modal under **Afterburner** (default) → confirm the title uses the Afterburner accent (cyan/`#00e5ff`), not red.
2. Switch to **Claudify** → reopen Memo → confirm the title uses the Claudify accent (`#D97757`), not red.
3. **Option A blast-radius check** — open all six other affected modals under both themes and confirm their titles read as the theme accent (not red) and look correct:
   - Report Testing Failure ([2833](src/webview/kanban.html#L2833))
   - Routing Map ([2853](src/webview/kanban.html#L2853))
   - Integration Settings ([2889](src/webview/kanban.html#L2889))
   - Kanban Column ([2921](src/webview/kanban.html#L2921))
   - Create Epic ([2945](src/webview/kanban.html#L2945))
   - Manage Epic ([2967](src/webview/kanban.html#L2967))
4. **Manage Epic contrast check (Claudify)** — open Manage Epic under Claudify and confirm the title (terracotta `#D97757`) and the Delete Epic button (red `#da3633`, [line 2990](src/webview/kanban.html#L2990)) are visually distinguishable and the delete button still reads as danger.
5. Confirm destructive buttons and error text across all modals still render red (they use inline `var(--accent-red)`, unaffected by this change).

---

**Recommendation:** Complexity 2 → **Send to Intern**.

## Code Review Results (Reviewer-Executor Pass)

### Stage 1 — Adversarial Findings

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 1 | NIT | Plan doc line 42 said "shared by **six** modals" but enumerated seven items; line 50 said "seven." Actual grep count: 7 HTML elements with `class="modal-title"`. | Plan doc line 42 (fixed) |
| 2 | NIT | The auto-commit labeled with this plan's title (`86089f2`) does not touch `kanban.html`. The actual `var(--accent-red)` → `var(--accent-primary)` swap landed in commit `760c49c` ("Unify Epic Architecture & Fix Kanban Epic Display"), confirmed via `git blame` on line 1352. Code state is correct; this is a traceability/process note only. | git history |

**No CRITICAL findings. No MAJOR findings.** The implementation is a clean, correct execution of Option A.

### Stage 2 — Balanced Synthesis & Disposition

- **Code change (`kanban.html:1352`):** `color: var(--accent-primary)` — correct, theme-aware, matches Option A. **Keep. No code change needed.**
- **Theme var resolution:** `--accent-primary` declared at `:root` (line 25, `#00e5ff`) and redeclared at `body.theme-claudify` (line 35, `#D97757`). **Verified.**
- **Blast radius (7 modals):** All seven `.modal-title` HTML elements (lines 2833, 2853, 2889, 2921, 2945, 2967, 2999) now inherit the themed accent. **Verified via grep.**
- **Destructive/error elements unaffected:** All 27 `--accent-red` references audited — none flow through `.modal-title`. Delete Epic button (line 2990) and error spans (2586, 2596, 2933) use inline `var(--accent-red)`. **Verified.**
- **Doc fix applied:** Line 42 "six" → "seven" to resolve the internal contradiction. **Applied.**

### Code Fixes Applied

- **Plan doc only:** Corrected modal count on line 42 from "six" to "seven" (consistency with the 7-item enumeration and line 50).
- **No code fixes needed** — the implementation in `src/webview/kanban.html` is correct as-is.

### Verification Results

- **Compilation:** Skipped per session instructions.
- **Tests:** Skipped per session instructions (pure CSS variable swap, no logic surface).
- **Static verification performed:**
  - `git blame` on `kanban.html:1352` confirms the swap from `var(--accent-red)` → `var(--accent-primary)` is present in the current codebase (commit `760c49c`).
  - `grep -c 'class="modal-title"' kanban.html` → 7 HTML elements, matching the plan's enumeration.
  - `grep '--accent-primary'` → declared at `:root` line 25 and `body.theme-claudify` line 35; used at line 1352 (the `.modal-title` rule). Confirms theme-aware resolution.
  - `grep '--accent-red'` → 27 references audited; none are on `.modal-title`. Destructive buttons and error text remain red-themed and unaffected.
- **Manual visual verification (deferred to user):** Steps 1–5 in the Verification Plan above remain manual eyeball checks (theme switching, contrast confirmation under Claudify). These cannot be automated in this session.

### Remaining Risks

1. **Manual visual confirmation pending:** The Manage Epic contrast check under Claudify (terracotta title `#D97757` vs. red Delete button `#da3633`) has been statically verified as using distinct color values but not visually eyeballed in a running webview. Low risk — the hex values are clearly distinguishable.
2. **Future theme authors:** Any future theme that forgets to redeclare `--accent-primary` will fall back to the `:root` Afterburner cyan (`#00e5ff`). Non-catastrophic but worth documenting for theme authors.
3. **Commit traceability:** The plan's labeled auto-commit (`86089f2`) does not contain the `kanban.html` change. The actual change is in `760c49c`. This is a process note, not a code risk.
