# Feature Plan: Replace Pulsing Working Animation with Theme-Specific Static Highlight

## Goal

### Problem
The current "working" indicator on kanban cards is a pulsing amber glow ring (`box-shadow` + `@keyframes kanban-working-pulse` animating opacity 1 → 0.4 → 1 over 1.8s). The pulsing is too strong and annoying — it constantly draws the eye and is distracting when multiple cards are in a working state. The user wants it replaced with a **non-animated, theme-specific static highlight** border around each working card:
- **Afterburner theme** → cyan highlight
- **Claudify theme** → orange highlight

### Background
- The working indicator is defined at `src/webview/kanban.html` lines 963–979:
  ```css
  .kanban-card.is-working::after {
      content: "";
      position: absolute;
      inset: -2px;
      border-radius: 5px;
      pointer-events: none;
      z-index: 1;
      box-shadow: 0 0 0 2px #e0a800, 0 0 14px color-mix(in srgb, #e0a800 45%, transparent);
      animation: kanban-working-pulse 1.8s ease-in-out infinite;
  }
  @keyframes kanban-working-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
  }
  @media (prefers-reduced-motion: reduce) {
      .kanban-card.is-working::after { animation: none; }
  }
  ```
- The animation uses hardcoded `#e0a800` (amber) — not theme-aware.
- JS at line 5968 computes `workingClass = isWorking ? ' is-working' : ''` and applies it on the card element at line 5982 (`<div class="kanban-card${...}${workingClass}" ...>`). This is correct and needs no change.
- Theme system:
  - **Afterburner** (default): `:root` variables (lines 16–33), `--accent-primary: #00e5ff` (cyan). Applied via `cyber-theme-enabled` class on `body` — shipped as the default `<body class="cyber-theme-enabled">` at line 2577; the theme switcher (lines 6585–6615) adds `cyber-theme-enabled` when `msg.theme === 'afterburner'`.
  - **Claudify**: `body.theme-claudify` block (lines 34–43), `--accent-primary: #D97757` (terracotta/orange). Applied via `theme-claudify` class by the switcher (lines 6599–6600) when `msg.theme === 'claudify'`, which also removes `cyber-theme-enabled`.
  - Theme switching JS at lines 6585–6615 (the `switchboardThemeNameSetting` / `switchboardThemeChanged` handler). At any time exactly one of the two theme classes is active (afterburner → `cyber-theme-enabled`, claudify → `theme-claudify`); a future third theme that clears both would fall through to the bare default rule below.
- There are no theme-specific overrides for `.is-working` currently — the amber glow is identical in all themes.

### Root Cause
The working indicator was designed as a pulsing animation with a hardcoded amber color. The pulse is visually aggressive (40% opacity swing every 1.8s), and the color doesn't match either theme's accent palette. The fix is to remove the animation entirely and use a static, theme-colored border highlight.

## Metadata

- **Tags:** frontend, ui, ux
- **Complexity:** 2

## User Review Required

Yes — confirm before coding:
- (a) Afterburner uses the theme's own cyan accent `#00e5ff` (user confirmed — preferred over a distinct blue). Claudify orange `#D97757` reuses the theme's own `--accent-primary` (confirmed). Both working-ring colors now match their theme's accent palette.

## Complexity Audit

### Routine
- Removing the `@keyframes kanban-working-pulse` animation and the `animation` property from `.kanban-card.is-working::after`.
- Replacing the hardcoded `#e0a800` box-shadow with theme-specific rules.
- Adding a default (no-theme) fallback color for when neither theme class is active.

### Complex / Risky
- None. Pure CSS change, no JS or backend impact.

## Edge-Case & Dependency Audit

### Race Conditions
- None. CSS is static.

### Security
- None.

### Side Effects
- Working cards will show a solid colored border instead of a pulsing glow. This is calmer and less distracting — the intended outcome.
- The `prefers-reduced-motion` media query override becomes a no-op (animation is already removed) but should be left in place or removed cleanly.

### Dependencies & Conflicts
- The `::after` pseudo-element approach is retained — only the `box-shadow` color and `animation` property change.
- Must ensure the static highlight is visible against both themes' card backgrounds. Afterburner cards are very dark (`--panel-bg2: #0a0a0a`), so a cyan border will be visible. Claudify cards use `--panel-bg2` with a subtle gradient, so an orange border will be visible.

## Dependencies

- None — self-contained CSS change to `src/webview/kanban.html` (lines 963–979). No JS logic change, no backend, no data migration. Independent of the sibling accordion subtask (disjoint `kanban.html` regions — CSS ~960 vs HTML/JS ~3k–3.6k).

## Adversarial Synthesis

Key risks: stale line citations in the original draft (`workingClass` is at 5968/5982 and theme switching at 6585–6615 — not 5884/6512 as first written), and a "default amber fallback" that is **unreachable in practice** because the body always carries exactly one of `cyber-theme-enabled` / `theme-claudify` (shipped default at line 2577; switcher 6585–6615). Mitigations: line refs refreshed; keep the `body.<theme>` prefix so Afterburner/Claudify specificity ordering stays correct (the bare default rule only fires if a future third theme clears both classes — defensive, not a live state today); add an inline comment explaining the removed `prefers-reduced-motion` block so a reviewer does not flag it as an accessibility regression.

## Proposed Changes

---

### 1. `src/webview/kanban.html` — Replace pulsing animation with static theme-specific highlight

**Context**: Lines 963–979. Replace the entire block.

**Implementation**:
```css
/* BEFORE (lines 963-979):
.kanban-card.is-working::after {
    content: "";
    position: absolute;
    inset: -2px;
    border-radius: 5px;
    pointer-events: none;
    z-index: 1;
    box-shadow: 0 0 0 2px #e0a800, 0 0 14px color-mix(in srgb, #e0a800 45%, transparent);
    animation: kanban-working-pulse 1.8s ease-in-out infinite;
}
@keyframes kanban-working-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
}
@media (prefers-reduced-motion: reduce) {
    .kanban-card.is-working::after { animation: none; }
}
*/

/* AFTER: Static, non-animated, theme-specific highlight border */
.kanban-card.is-working::after {
    content: "";
    position: absolute;
    inset: -2px;
    border-radius: 5px;
    pointer-events: none;
    z-index: 1;
    /* Default fallback — only reachable if a future third theme clears both
       cyber-theme-enabled and theme-claudify. Not a live state today: the
       body ships with cyber-theme-enabled (line 2577) and the switcher
       (6585–6615) always sets exactly one of the two. Defensive only. */
    box-shadow: 0 0 0 2px #e0a800;
}

/* Afterburner theme: cyan highlight (theme accent) */
body.cyber-theme-enabled .kanban-card.is-working::after {
    box-shadow: 0 0 0 2px #00e5ff;
}

/* Claudify theme: orange highlight */
body.theme-claudify .kanban-card.is-working::after {
    box-shadow: 0 0 0 2px #D97757;
}
```

**Design notes**:
- The `inset: -2px` + `box-shadow: 0 0 0 2px <color>` creates a clean 2px border ring outside the card. No glow spread (`0 0 14px ...`) — just a solid ring.
- Afterburner uses `#00e5ff` — the theme's own cyan accent (`--accent-primary`), matching the theme palette (user confirmed).
- Claudify uses `#D97757` — the theme's own `--accent-primary` terracotta/orange, matching the theme palette.
- The default fallback keeps `#e0a800` (amber) for any state where neither theme class is active — but note this is **defensive only**: today the body always carries exactly one theme class, so the `body.<theme>` rules always win on specificity and the amber fallback is never rendered. It exists to keep a sane color if a future third theme clears both classes.
- The `@keyframes kanban-working-pulse` and `@media (prefers-reduced-motion)` block are removed entirely since there is no animation. This is safe (not an accessibility regression): with no animation declared, there is nothing for the reduced-motion media query to gate — add a one-line comment in the source noting this so a future reviewer does not reintroduce the media query expecting an animation.

---

### 2. `dist/webview/kanban.html` (release-only — NOT a dev step)

Per project rules, `dist/` is NOT used during development or testing — `src/` is the source of truth and the webview is served from source during dev. `dist/webview/kanban.html` is regenerated by `npm run compile` only when producing a release VSIX. Do NOT manually edit it, and do NOT run a build as part of dev verification (this session skips compilation).

## Verification Plan

### Manual Verification
- [ ] Dispatch a card to a coding column — verify a **static** (non-pulsing) colored border appears around the card
- [ ] Under Afterburner theme — verify the border is **cyan** (`#00e5ff`)
- [ ] Under Claudify theme — verify the border is **orange** (`#D97757`)
- [ ] Verify no pulsing/animation occurs (the border is completely static)
- [ ] Verify the border disappears when the card's working state clears (plan file edit)
- [ ] Verify multiple working cards each show the static border without visual chaos
- [ ] Verify non-working cards have no border highlight (no regression)
- [ ] Switch between themes — verify the border color updates to match the active theme
- [ ] Confirm the removed `@media (prefers-reduced-motion)` block left no orphan reference (no `kanban-working-pulse` usage remains)

### Automated Tests
- Skipped this session per directive (no `npm run compile`, no `npm test`). This is a pure CSS change with no JS or test surface, so no automated regression is expected.

## Files Changed

- `src/webview/kanban.html` — replace pulsing animation with static theme-specific highlight (lines 963–979); remove `@keyframes kanban-working-pulse` and the `prefers-reduced-motion` override
- `dist/webview/kanban.html` — regenerated at VSIX release time only (not a dev artefact)

## Review Findings

Reviewer pass (2026-07-09). A prior `restore-kanban-working-animation.md` commit (`e367991`) had re-added the pulse + glow after this plan first landed, but the user re-confirmed the plan's original intent (static highlight, no animation — the pulse read as too busy). Applied the plan as written: removed `animation: kanban-working-pulse`, the `@keyframes` block, the `prefers-reduced-motion` gate, and the `0 0 14px` glow spread; `.kanban-card.is-working::after` is now a static 2px ring, theme-colored — Afterburner cyan `#00e5ff` (`kanban.html:983`), Claudify orange `#D97757` (`kanban.html:988`), amber default fallback (`kanban.html:981`). Orphan check clean: no `kanban-working-pulse` refs remain; `.is-working` still applied by JS at `kanban.html:6010` so the ring renders. Compile/tests skipped per directive. Remaining risk: none.
