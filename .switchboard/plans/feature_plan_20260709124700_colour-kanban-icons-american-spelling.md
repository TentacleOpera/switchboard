# "Colour Kanban Board Icons" Label & Description Should Use American "Color"

## Goal

Change the user-facing **title** and **description** of the Claudify theme option currently labelled "Colour kanban board icons" to use the American spelling **"Color"** everywhere it is shown to the user (the Setup → Theme tab and the VS Code Settings UI). This aligns the option with the American spelling used across the rest of the product's user-facing copy.

### Problem analysis

The option is presented with British spelling in its title and description in two user-facing places:

1. **Setup panel → Theme tab** (`src/webview/setup.html:1314-1315`):
   - Title: `Colour kanban board icons`
   - Description: `Show kanban toolbar icons in colour at rest (terracotta for Claudify) instead of grey with a colour click-flash.`
2. **VS Code Settings UI** (`package.json:724-728`), the `description` string for `switchboard.theme.colourKanbanIcons`:
   - `Render kanban board icons in full colour at rest (terracotta for Claudify) instead of flat grey with a colour click-flash. Only affects the Claudify theme.`

The request is explicitly scoped to the **title and description** — the human-readable copy — not the setting's identifier.

### Root cause

Simply a copy choice: the strings were authored with British "colour". No logic is involved.

### Critical constraint — do NOT rename the setting key

The configuration key is `switchboard.theme.colourKanbanIcons` (British "colour"). This is a **shipped setting** in a published extension (~4,000 installs, many on older versions). Renaming the key to `colorKanbanIcons` would silently orphan every user who has explicitly set the current key, requiring a config migration — needless risk for a cosmetic label change. The key, all message types (`getColourKanbanIconsSetting`, `setColourKanbanIconsSetting`, `colourKanbanIconsSetting`, `colourKanbanIconsChanged`), the body class (`kanban-icons-colour`), the function `getEffectiveColourKanbanIcons`, and DOM ids (`colour-kanban-icons-toggle`) **stay exactly as they are**. Only the displayed English words "Colour"/"colour" in the title and description change to "Color"/"color".

## Metadata

- **Tags:** copy, i18n-spelling, theme, settings-ui, low-risk
- **Complexity:** 1 / 10
- **Area:** `src/webview/setup.html`, `package.json`

## Complexity Audit

**Routine.** Pure user-facing string edits in two files. No behaviour, no logic, no state, no message-protocol, no CSS, no migration. The only thing that requires care is *not* touching the config key or any identifier — which is a "leave it alone" instruction, not added work.

## Edge-Case & Dependency Audit

- **Config key untouched:** `switchboard.theme.colourKanbanIcons` stays British → no migration, no orphaned user settings. The `package.json` `"description"` value changes; the property **name** (line 724) does not.
- **Message types / DOM ids / body class untouched:** e.g. `colourKanbanIconsChanged`, `colour-kanban-icons-toggle`, `kanban-icons-colour`, `getEffectiveColourKanbanIcons`. These are internal identifiers, never shown to the user, and are matched by exact string across webview↔backend — changing any of them would break the wiring. Do **not** touch them.
- **Scope of "colour" → "color":** only the English words inside the two user-facing copy strings. In the `setup.html` description there are **two** occurrences of "colour" ("in colour at rest" and "colour click-flash"); in the `package.json` description there are also **two** ("in full colour at rest" and "a colour click-flash"). Replace each with "color".
- **Code comments are not user-facing:** the CSS comment at `src/webview/kanban.html:101` ("Colour kanban icons opt-in …") and the section comment are developer-only. Out of scope per the request (title + description). May be left as-is; optionally aligned for tidiness, but not required.
- **The subsection header "Kanban Icons"** (`setup.html:1308-1310`) contains no "colour" spelling — no change.
- **No other user-facing occurrences:** a search for user-visible "colour"/"Colour" strings tied to this feature returns only `setup.html:1314-1315` (the CSS comment and the code-side identifiers are not user-facing). `package.json:727` is the third and final user-facing string.

## Proposed Changes

### 1. `src/webview/setup.html` — Theme tab option (lines 1314-1315)

**Title (line 1314):**

```html
<span style="font-size: 11px; color: var(--text-primary); font-weight: 600;">Color kanban board icons</span>
```

**Description (line 1315):**

```html
<span style="font-size: 10px; color: var(--text-secondary); line-height: 1.4;">Show kanban toolbar icons in color at rest (terracotta for Claudify) instead of grey with a color click-flash.</span>
```

(Both "colour" → "color". Note the surrounding `color: var(--text-primary)` CSS attributes are unrelated and stay.)

### 2. `package.json` — settings description (line 727)

Change **only** the `"description"` string value; leave the property name `switchboard.theme.colourKanbanIcons` (line 724) unchanged.

```json
"switchboard.theme.colourKanbanIcons": {
  "type": "boolean",
  "default": false,
  "description": "Render kanban board icons in full color at rest (terracotta for Claudify) instead of flat grey with a color click-flash. Only affects the Claudify theme.",
  "scope": "window"
}
```

*No other files change.*

## Verification Plan

1. `grep -n "colour" src/webview/setup.html` → the two occurrences at lines 1314-1315 are gone (any remaining hits are unrelated CSS `color:` — note `color` has no "u").
2. `grep -rn "colour" package.json` → only the **key** `switchboard.theme.colourKanbanIcons` remains; the description no longer contains "colour".
3. Confirm the config key `switchboard.theme.colourKanbanIcons` is unchanged (`grep -n "colourKanbanIcons" package.json` still shows the property name).
4. Rebuild/reinstall the VSIX; open Setup → Theme tab → the option reads "Color kanban board icons" with the "…in color…" description.
5. Open VS Code Settings, search "colour kanban" and "color kanban" → the setting is found and its description reads "…in full color at rest…". Toggling it still works (proves the key and wiring are intact).
6. Regression: toggling the option still colours/greys the Claudify icons (behaviour unchanged — only copy changed).
