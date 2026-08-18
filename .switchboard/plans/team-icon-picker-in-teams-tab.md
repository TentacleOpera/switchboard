# Team Icons: Choose or Customise an Icon per Team in the TEAMS Tab

## Goal
Give every team a visual identity the operator picks: an `icon` field on the team definition, chosen from a built-in palette or supplied as a custom file, edited in the TEAMS tab of `kanban.html`. This is the authoring half of team icons; the strip and the team cockpit consume it.

### The problem, and the root cause
Teams are currently identified by **name text plus a role-derived portrait**. `teamsTabGalleryCard` (`src/webview/kanban.html:4800`) renders an SVG `<use href="#portrait-<role>">` resolved by `teamsTabPortraitId` (`kanban.html:4736`), which maps `headRole` onto one of five hardcoded symbols — `portrait-planner`, `portrait-lead`, `portrait-coder`, `portrait-reviewer`, `portrait-agent` (defined at `kanban.html:3240`–`3286`).

So the portrait describes the **head's role**, not the team. Three teams led by a `lead` are three identical icons. There is no per-team visual identity to put anywhere, which is why the fleet strip falls back to per-terminal CLI brand marks — those at least differ from each other.

The asset side is already solved and unused: `/static/icons/` maps to the repo's `icons/` directory (`src/services/TaskViewerProvider.ts:3522`, and `src/standalone/bootstrap.ts:672` for the npx host), which contains a 100-piece flat sci-fi icon set alongside the brand and nav SVGs. Static art is served with `Cache-Control: public, max-age=3600` (`LocalApiServer.ts:920`) — no new route, no new caching decision.

### The trap this plan must not fall into
`teamsTabSaveAgentGroup` (`kanban.html:5290`) **rebuilds the group object from scratch** on every save and drops every field it does not explicitly name. The literal at `kanban.html:5344` already carries four hand-written rescues for exactly this reason — `prompt`, `headPrompt`, `startOnLoad`, `startWorktree` — each with a comment explaining that an edit-and-save would otherwise silently clear the operator's setting. An `icon` field added anywhere else and not added *here* will be silently wiped the first time the operator edits any unrelated field of that team. This is the highest-risk line in the plan.

## Metadata
- **Complexity:** 5
- **Tags:** frontend, ui, ux, feature

## Approach

### 1. The `icon` field
Add `icon?: string` to the team definition stored at `terminals.agentGroups`. Two accepted forms, discriminated by prefix so no separate `iconKind` field is needed:
- `pack:<filename>` — a file from the served `icons/` directory, resolved to `/static/icons/<encodeURIComponent(filename)>`. **Encoding is mandatory**: the pack filenames contain spaces (`25-1-100 Sci-Fi Flat icons-01.png`), so a raw interpolation yields a broken URL. Consider normalising the pack on disk to hyphenated names in this plan's implementation and referencing the normalised names — a one-time rename is cheaper than every consumer remembering to encode. If renamed, keep the originals in place (do not delete) so nothing else that may reference them breaks.
- `data:image/...;base64,...` — a custom icon the operator supplied.

Absent/empty `icon` → fall back to the existing role portrait. The fallback is load-bearing: every already-defined team has no icon, and none of them may render blank.

### 2. Picker UI in the TEAMS tab editor
In the team form (alongside `#agent-groups-name` / `#agent-groups-head-role`, `kanban.html:5265`):
- A current-icon preview button showing the resolved icon (or the role portrait when unset).
- Clicking it opens an inline grid of the built-in palette. Populate the grid from a new `GET /terminals/icon-palette` returning the served filenames — do **not** hardcode 100 filenames into `kanban.html`, and do not glob client-side.
- A "custom…" affordance: a `<input type="file" accept="image/png,image/svg+xml,image/webp">`, read via `FileReader` to a data URI. Cap at **64 KB** after encoding and reject larger with an inline error. The value lands in `terminals.agentGroups`, which is a DB config blob read on every board load and relayed to panels — a megabyte of base64 per team would bloat every read.
- A "reset to role portrait" entry that clears the field back to the default.
- No confirmation dialogs anywhere in this flow, per CLAUDE.md. Reset and clear act immediately.

### 3. Persist it — the carry-forward
- Add `...(iconValue ? { icon: iconValue } : {})` to the group literal at `kanban.html:5344`, in the same style and with the same kind of comment as the `startOnLoad` carry directly above it.
- Because the picker *is* an editor field (unlike `startOnLoad`), read it from the form rather than from `prevGroup` — but when the picker was never mounted for this edit (e.g. a code path that saves without the form), fall back to `prevGroup?.icon` so a save cannot blank it.
- Validate server-side in the `saveAgentGroup` handler: accept only the two prefixes above, reject anything else, and enforce the size cap there too. The webview is not the only writer of this key.

### 4. Show it where teams are already drawn
- `teamsTabGalleryCard` (`kanban.html:4800`) — render the chosen icon in place of the portrait `<svg><use>` when `icon` is set; keep the portrait path intact as the fallback branch.
- `teamsTabRenderFlow` head node (`kanban.html:4924`) — same treatment, so the flow diagram and the card agree.
- Use an `<img>` for both forms, not the CSS-mask/`currentColor` path used by nav icons. The reasoning is already recorded at `src/webview/shell.js:542`: these are multi-hue marks whose baked-in fill *is* the identity, and masking would flatten them to one colour.

### 5. One shared resolver
Add a small helper — `teamIconSrc(group)` → URL string or `null` — colocated with the other team helpers, and use it from every consumer (card, flow node, and later the strip and the team cockpit). Do not let each surface re-implement the prefix parsing; that is how the brand-icon table ended up duplicated before `postFleetStateToShell` centralised it (`terminals.js:1361`).

## Edge cases
- **Pack file removed from disk.** `/static/icons/...` 404s and the `<img>` renders a broken glyph. Give every `<img>` an `onerror` that swaps in the role portrait, so a missing asset degrades to the old behaviour rather than to a broken image.
- **Two teams pick the same icon.** Allowed. The icon is decoration plus recognition, not a key. Do not add a uniqueness constraint — the operator may legitimately want two similar squads to look alike.
- **Un-adopted shipped team types.** `SHIPPED_TEAM_TYPES` (`kanban.html:4646`) render as cards but have no stored definition to save an icon onto. Show their role portrait, and disable the picker until the type is adopted (forking a type into a real definition already happens at `kanban.html:5074` — the icon can be set from then on).
- **`unassigned` teams.** They still render a card, so they still need an icon. Nothing about the picker depends on assignment state.
- **Theme.** The icons are fixed-hue art on both light and dark backgrounds. Check the sci-fi pack against the light theme; if any icon disappears against light, the fix is a subtle container chip behind the mark, not per-theme icon variants.
- **Custom icon in the DB blob.** A data URI makes `terminals.agentGroups` larger on every read. The 64 KB cap bounds it; if an operator sets custom icons on a dozen teams the key stays well under a megabyte.

## Verification Plan
1. `npm run compile` — clean.
2. **The wipe regression, first and explicitly:** set a team's icon; then edit only that team's *name* and save; re-read `terminals.agentGroups` and confirm `icon` survived. Repeat for a member-row edit and for a prompt edit. This is the failure mode the plan exists to avoid — assert it, do not eyeball it.
3. Unit: `teamIconSrc` — `pack:` form URL-encodes correctly (test with a spaced filename); `data:` form passes through; empty/absent returns `null`; a malformed value returns `null` rather than throwing.
4. Unit/server: `saveAgentGroup` rejects an `icon` that is neither prefix, and rejects an oversized data URI.
5. Manual, installed VSIX: pick a pack icon for team A and a custom PNG for team B. Confirm both render on the gallery card and on the flow head node. Reload the board and confirm both persist.
6. Manual: delete the picked pack file from `icons/`, reload, confirm the card falls back to the role portrait rather than a broken image.
7. Manual: a team with no icon set renders exactly as it does today — same portrait, same layout, no shift.
8. Both themes: confirm every palette icon is legible on light and dark.
