# Unify Kanban Card Meta (Complexity + Timestamp) to Grey Across Themes

## Goal

On kanban cards, the "Complexity:" label and the relative timestamp text should be the **same grey** under both the afterburner and claudify themes. Currently they render **teal** under afterburner and **grey** under claudify. Make afterburner match claudify (grey).

### Problem Analysis & Root Cause

Both the complexity label and the timestamp live inside one `.card-meta` element (`kanban.html:5333`):

```html
<div class="card-meta">Complexity: <span class="complexity-indicator ...">${category}</span> · ${timeAgo}</div>
```

The base `.card-meta` rule colors the text with a teal-tinted mix, and **claudify overrides it to flat grey, but afterburner has no override** — so afterburner falls through to the teal base. There is no `cyber-theme-enabled .card-meta` rule anywhere (only two `.card-meta` rules exist in the entire `src/` tree: the base at line 949 and the claudify override at line 193).

- Base rule (`kanban.html:949-957`):
```css
.card-meta {
    font-family: var(--font-mono);
    font-size: 9px;
    color: color-mix(in srgb, var(--text-secondary) 50%, var(--accent-teal-dim));
    letter-spacing: 0.5px;
    ...
}
```
- Claudify override (`kanban.html:191-193`):
```css
/* Complexity label + timestamp: grey (the only labels asked to be grey). Literal grey
   because --text-secondary is warm again for everything else. */
body.theme-claudify .card-meta { color: #8a8a8a !important; }
```

Why it computes teal under afterburner: `--text-secondary` = `#8C8C8C` (`kanban.html:23`) mixed 50/50 with `--accent-teal-dim` = `color-mix(#00e5ff 40%, transparent)` (cyan; `kanban.html:25-27`) yields a cyan-tinted grey. Under claudify the same base would tint terracotta, but the `!important` override at line 193 forces flat `#8a8a8a`. Afterburner has no such override, hence teal.

Claudify does **not** override any CSS variables (`--text-secondary`, `--accent-teal-dim`, etc.) — it only uses direct property overrides with `body.theme-claudify` selectors. This means the base `.card-meta` color computes identically under both themes; the claudify `!important` override is the sole reason claudify shows grey.

The intended state is "grey across **both** themes", and the only other `.card-meta` consumer is the claudify override that already wants exactly `#8a8a8a` — so the cleanest fix is to make the base grey.

## Metadata

- **Tags:** `bugfix`, `ui`
- **Complexity:** 2/10
- **Primary files:** `src/webview/kanban.html`

## User Review Required

No review required. This is a pure visual CSS fix with no logic, state, or data changes. The fix makes afterburner match the already-shipped claudify behavior.

## Complexity Audit

### Routine
- Single-property CSS color change in one file (`kanban.html` line 952)
- Removal of one now-redundant override rule + its comment (`kanban.html` lines 191-193)
- No JavaScript, no state, no data migration
- Reuses the exact grey value (`#8a8a8a`) already shipped under claudify

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. CSS is static; no runtime state involved.
- **Security:** None. No user input, no data handling.
- **Side Effects:**
  - The no-theme/default fallback path (`themeBodyClass.ts:55` returns `''` for any theme that isn't afterburner or claudify) will also render `.card-meta` grey after the fix, since it falls through to the base rule. This is a **benevolent side effect** — consistent with the goal of grey meta text — but represents a behavior change for the unset-theme case (previously teal-tinted, now grey).
  - Removing the claudify override (lines 191-193) eliminates a `!important` declaration. No other selector targets `.card-meta` color, so no specificity conflict arises.
- **Dependencies & Conflicts:**
  - **Do NOT touch `.complexity-indicator`** color rules (`kanban.html:959-970`). Those are an intentional fixed severity scale (very-high magenta, high red, etc.), identical across themes by design (comment at `963-964`). The bug concerns only the surrounding `.card-meta` text (the "Complexity:" label, the "·" separator, and the timestamp) — not the colored severity word.
  - **Leave `--accent-teal-dim` alone** — it is used for borders elsewhere (e.g. lines `298, 451, 461, 468`). Only the `.card-meta` color changes.
  - **Single file:** `.card-meta` does not appear in `project.html`/`design.html` or any external CSS file (styles are inline in `kanban.html`), so no cross-file sync is needed.
  - **No migration:** purely visual CSS.

## Dependencies

None. This plan is self-contained.

## Adversarial Synthesis

Key risks: (1) the claudify override has an explanatory comment (lines 191-192) that must be removed alongside the CSS rule — leaving a stale comment referencing a deleted rule is a maintenance hazard; (2) the no-theme fallback path will change from teal-tinted to grey, a benevolent but undocumented side effect. Mitigations: explicitly remove the comment block with the rule; document the fallback behavior in the Edge-Case audit above.

## Proposed Changes

### `src/webview/kanban.html`

**1. Make the base `.card-meta` color grey** (line `952`):

```css
/* before */
color: color-mix(in srgb, var(--text-secondary) 50%, var(--accent-teal-dim));
/* after */
color: #8a8a8a;
```

This changes the base rule from a teal-tinted `color-mix` to the literal grey already used by claudify. Both afterburner (`cyber-theme-enabled`) and claudify (`theme-claudify`) will now render `.card-meta` text as `#8a8a8a` without needing a per-theme override. The no-theme fallback also benefits.

**2. Remove the now-redundant claudify override AND its comment** (`kanban.html:191-193`):

Remove these three lines entirely:
```css
/* Complexity label + timestamp: grey (the only labels asked to be grey). Literal grey
   because --text-secondary is warm again for everything else. */
body.theme-claudify .card-meta { color: #8a8a8a !important; }
```

With the base set to `#8a8a8a`, both themes already match; deleting the override avoids a dangling `!important` and its now-stale explanatory comment. (Harmless to keep, but cleaner to remove — and leaving the comment without the rule would be misleading.)

**Edge Cases:**
- The `.complexity-indicator` severity colors (lines 959-970) are untouched — the colored severity word remains on its fixed scale.
- The `·` separator and timestamp text inherit the `.card-meta` color, so they turn grey too (desired).
- The no-theme/default case (no body class) also gets grey — consistent with the goal.

## Verification Plan

### Automated Tests

No automated tests required. This is a pure CSS visual change with no logic to test programmatically. The test suite will be run separately by the user.

### Manual Verification

1. Build/install the VSIX.
2. Select the **afterburner** theme, open the Kanban board. Confirm the "Complexity:" label, the "·" separator, and the timestamp render grey (`#8a8a8a`) — not teal.
3. Confirm the colored complexity severity word (e.g. "Very High"/"High") is **unchanged** (still uses the severity scale).
4. Switch to the **claudify** theme. Confirm the same meta text is the identical grey (regression guard — it must not have changed).
5. Inspect a card in devtools under both themes and confirm the computed `.card-meta` color is `rgb(138, 138, 138)` in both.

## Recommendation

Complexity is 2/10 → **Send to Intern**.

---

## Code Review Pass (Reviewer-Executor)

### Stage 1 — Grumpy Principal Engineer

> A CSS color change. One property. One rule deletion. How hard can this be? Let me see if you managed to not screw up the easiest plan in the entire epic.

> **`kanban.html:943`** — `color: #8a8a8a;` Replaced the `color-mix(in srgb, var(--text-secondary) 50%, var(--accent-teal-dim))` teal-tinted mess with the literal grey. Both afterburner and claudify now render `.card-meta` as `#8a8a8a` from the base rule alone. No per-theme override needed. Correct.

> **Claudify override removed** — The `body.theme-claudify .card-meta { color: #8a8a8a !important; }` rule AND its two-line explanatory comment are gone. I checked lines 188-197 — the area now goes straight from `.plan-title` to `.column-name` with no orphaned comment referencing a deleted rule. Clean.

> **`.complexity-indicator` severity scale** — Lines 956-961: all six severity levels (very-high magenta, high red, medium yellow, low green, very-low cyan, unknown grey) are untouched. The colored severity word still pops. The plan said don't touch these. You didn't. Good.

> **No cross-file conflicts** — Grep confirms `.card-meta` appears in exactly ONE place in the entire `src/` tree: `kanban.html:940`. No other file overrides it. The plan said this was self-contained. It is.

> ...That's it. Two changes, both correct, both complete. I'm almost disappointed there's nothing to yell about.

### Stage 2 — Balanced Synthesis

| Finding | Severity | Verdict |
|---------|----------|---------|
| `kanban.html:943` — base `.card-meta` color changed to `#8a8a8a` | — | Keep (correct, matches claudify's shipped grey) |
| Claudify override (was lines 191-193) — removed with comment | — | Keep (correct, no dangling `!important` or stale comment) |
| `.complexity-indicator` severity colors (lines 956-961) — untouched | — | Keep (regression guard passes) |
| No other `.card-meta` rules in `src/` — single source of truth | — | Keep (verified, no conflicts) |

### Fixes Applied

None. The implementation is complete and correct. No CRITICAL, MAJOR, or NIT findings.

### Validation Results

- **`kanban.html:943`** — base `.card-meta` color is `#8a8a8a` (was `color-mix(in srgb, var(--text-secondary) 50%, var(--accent-teal-dim))`) ✓
- **Claudify override removed** — grep for `.card-meta` in `kanban.html` returns only the base rule at line 940 + HTML usage at line 5341 (was 3 matches, now 2) ✓
- **No stale comment** — lines 188-197 show no orphaned comment referencing `.card-meta` ✓
- **`.complexity-indicator` severity scale intact** — all 6 levels (very-high/high/medium/low/very-low/unknown) unchanged at lines 956-961 ✓
- **Cross-file check** — grep for `.card-meta` in entire `src/` tree returns only `kanban.html:940` (1 match) ✓
- **Compilation/tests**: skipped per session directives.

### Remaining Risks

- None. The no-theme/default fallback path now also renders grey (benevolent side effect documented in the plan's Edge-Case audit). Both afterburner and claudify render identical `#8a8a8a` from the base rule. No `!important` declarations remain on `.card-meta`.
