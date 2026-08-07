# Standalone Board Hardcodes the Afterburner Theme

## Metadata

**Complexity:** 2
**Tags:** bug, backend, standalone, parity, ui
**Project:** Browser Switchboard

## Goal

The standalone/browser host announces `theme: 'afterburner'` on every state push regardless of the user's configured theme, so the theme setting has no effect in the browser. Send the live theme name.

### Problem analysis and root cause

Both standalone state builders emit a literal:

- `pushFullState` — `src/standalone/bootstrap.ts:343`
- `getFullState` — `src/standalone/bootstrap.ts:372`

```typescript
{ type: 'switchboardThemeNameSetting', theme: 'afterburner', surface: SURFACES.common }
```

The extension posts the resolved value (`src/services/KanbanProvider.ts:7365`):

```typescript
this.postMessage({ type: 'switchboardThemeNameSetting', theme: currentTheme });
```

Note the `surface: SURFACES.common` tag on the standalone entries — this message is not board-scoped, so the hardcoded value reaches **every** panel served by the standalone host, not just the kanban board. A user who has selected a different theme sees Afterburner everywhere in the browser.

**Why this looked wired.** The theme is a setting, and setting reads/writes route through the provider via the `default:` arm's delegation (`bootstrap.ts:1062-1087`), so `getSetting` / `saveSetting` behave correctly and return real values. Only the *announcement* is fabricated. Any audit that checked "can standalone read the theme setting?" would pass.

One instance of the hardcoded-payload class described in `standalone-push-parity-guard.md`, and the only one that is cross-panel rather than board-only.

## User Review Required

None.

## Complexity Audit

### Routine
- Replacing two literals with a settings read.

### Complex / Risky
- **Cross-surface blast radius.** Because the entry is tagged `SURFACES.common`, getting this wrong misthemes every standalone panel rather than one. Conversely, fixing it changes the appearance of every panel for any user whose theme is not Afterburner — a visible change worth a release note.
- **Fallback must remain Afterburner.** If the setting is unset or unreadable, resolve to `'afterburner'` deliberately rather than emitting `undefined` — the board's theme handling should not receive a missing value. Make the default explicit and commented so it is not mistaken for a reinstated hardcode by a future reader (or by the parity guard).
- **Both builders must change.**

## Edge-Case & Dependency Audit

**Race Conditions** — none.

**Security** — none.

**Side Effects**
- Every standalone panel re-themes for users with a non-default theme. Intended.

**Dependencies & Conflicts**
- Adjacent lines to the backlog, routing-config and CLI-triggers plans; expect merge conflicts if developed in parallel.

## Dependencies

- None (hard). Sequencing: after `standalone-push-parity-guard.md`.

## Implementation

**File:** `src/standalone/bootstrap.ts`

- Replace `theme: 'afterburner'` at `:343` and `:372` with the resolved theme setting for the served workspace, defaulting explicitly to `'afterburner'` with an inline comment naming it as the intended fallback.

**File:** `src/services/KanbanProvider.ts`

- Expose the resolution used at `:7365` if it is not already reachable, so both hosts read one source.

## Proposed Changes

### `src/standalone/bootstrap.ts`
- **Logic:** Live theme in both builders, with an explicit documented default.
- **Edge Cases:** `SURFACES.common` means this affects all panels; unset setting must fall back deliberately.

## Verification Plan

### Automated
- Test: `getFullState()`'s theme entry reflects a configured non-default theme.
- Test: with the setting absent, the entry resolves to `'afterburner'` rather than `undefined`.
- Guard: `standalone-parity:check` hardcoded-field baseline drops by one.

### Manual (standalone host)
1. Set a non-Afterburner theme in the editor; reload the browser — the board renders in that theme.
2. Confirm the theme applies to the other standalone panels too, not just the board (`SURFACES.common`).
3. Clear the setting — the browser falls back to Afterburner with no console error.
4. Extension unaffected.

## Recommendation

Complexity 2 → **Send to Coder.** Trivial change; the only care needed is the deliberate fallback and awareness that this message is cross-panel.
