# Team Icons: Choose or Customise an Icon per Team in the TEAMS Tab

## Goal
Give every team a visual identity the operator picks: an `icon` field on the team definition, edited in the TEAMS tab of `kanban.html`. This is the authoring half of team icons; the strip and the team cockpit consume it.

> **Scope note — the built-in palette is a placeholder, on purpose.** The long-term
> intent is custom pixel art for both teams and individual agents, specified in
> `agent-and-team-pixel-art-pipeline.md`. This plan ships the *field, the picker and
> the resolver* so the icon chain is unblocked immediately, using the icons already
> in the repo as stand-in art. Nothing here should assume that art is permanent, and
> nothing here may make swapping it a code change. When the pixel-art registry lands,
> real art simply lands in `icons/` under the `agent-`/`team-` prefixes and the
> stand-in pack is dropped from the palette — a change to which groups the picker
> shows, not a rework.

### The problem, and the root cause
Teams are currently identified by **name text plus a role-derived portrait**. `teamsTabGalleryCard` (`src/webview/kanban.html:4800`) renders an SVG `<use href="#portrait-<role>">` resolved by `teamsTabPortraitId` (`kanban.html:4736`), which maps `headRole` onto one of five hardcoded symbols — `portrait-planner`, `portrait-lead`, `portrait-coder`, `portrait-reviewer`, `portrait-agent` (defined at `kanban.html:3240`–`3286`).

So the portrait describes the **head's role**, not the team. Three teams led by a `lead` are three identical icons. There is no per-team visual identity to put anywhere, which is why the fleet strip falls back to per-terminal CLI brand marks — those at least differ from each other.

The delivery side is already solved and unused: `/static/icons/` maps to the repo's `icons/` directory (`src/services/TaskViewerProvider.ts:3522`, and `src/standalone/bootstrap.ts:672` for the npx host), and its path handling normalises a relative subpath (`LocalApiServer.ts:906`), so nested directories work without a new route. Static art is served with `Cache-Control: public, max-age=3600` (`LocalApiServer.ts:920`) — no new route, no new caching decision. The directory currently holds a 100-piece flat sci-fi set alongside the brand and nav SVGs; that set is the stand-in art referred to above.

### The trap this plan must not fall into
`teamsTabSaveAgentGroup` (`kanban.html:5290`) **rebuilds the group object from scratch** on every save and drops every field it does not explicitly name. The literal at `kanban.html:5344` already carries four hand-written rescues for exactly this reason — `prompt`, `headPrompt`, `startOnLoad`, `startWorktree` — each with a comment explaining that an edit-and-save would otherwise silently clear the operator's setting. An `icon` field added anywhere else and not added *here* will be silently wiped the first time the operator edits any unrelated field of that team. This is the highest-risk line in the plan.

## Metadata
- **Complexity:** 5
- **Tags:** frontend, ui, ux, feature
- **Project:** browser-switchboard
- **Feature:** 72bda17f-bb0c-4ad9-b9b9-55c19fc9cba7

## User Review Required
No user review required — the `icon` field design (prefix-discriminated forms, shared resolver, wipe-trap carry-forward) is fully specified.

## Complexity Audit

### Routine
- Adding an `icon?: string` field to the team definition and a carry-forward in the save literal.
- Writing the `teamIconSrc(group)` resolver — prefix parsing, URL construction, fallback to `null`.
- Rendering the chosen icon in the gallery card and flow head node (replacing the `<svg><use>` with an `<img>` when `icon` is set).

### Complex / Risky
- The `teamsTabSaveAgentGroup` wipe trap (`kanban.html:5344`) — the rebuild-from-scratch literal drops every field it does not explicitly name. The `icon` carry-forward is the highest-risk line in the plan.
- The `GET /terminals/icon-palette` endpoint dependency — this plan is its first consumer, but the endpoint is specified in `agent-and-team-pixel-art-pipeline.md`. If that plan has not landed, the picker opens an empty grid.
- The 64 KB data URI cap — `FileReader.readAsDataURL` reads the entire file into memory before the encoded size can be checked. A `file.size` check on the `<input>` change event is needed before reading to reject oversized files early.

## Edge-Case & Dependency Audit
- **Race Conditions:** `teamsTabSaveAgentGroup` rebuilds the group object from scratch on every save. A concurrent save (e.g. from a different code path that does not mount the picker form) could overwrite the `icon` field. The carry-forward from `prevGroup?.icon` mitigates this for code paths that save without the form.
- **Security:** The `icon` field is stored in `terminals.agentGroups`, a DB config blob. A `data:` URI with a 64 KB cap bounds the bloat. Server-side validation in the `saveAgentGroup` handler must reject unrecognised prefixes and enforce the size cap — the webview is not the only writer of this key.
- **Side Effects:** A `data:` URI in the config blob increases every board-load read size. The 64 KB cap bounds this; a dozen custom icons stays well under a megabyte.
- **Dependencies & Conflicts:** Hard dependency on `GET /terminals/icon-palette` (specified in `agent-and-team-pixel-art-pipeline.md`). The `teamIconSrc` resolver created here is the seam the pixel-art plan extends — it must be the only place a stored `icon` value becomes a URL.

## Dependencies
- **Agent & Team Pixel Art Pipeline** — supplies the `GET /terminals/icon-palette` endpoint that populates the picker grid. Without it, the picker has no art to show. The pixel-art plan's endpoint must land before or alongside this plan.
- **Team identity foundation** — not a hard dependency for the picker itself (the picker edits definitions, not live groups), but the `teamIconSrc` resolver is consumed by the shell strip and cockpit, which do depend on identity.

## Adversarial Synthesis
Key risks: (1) the `teamsTabSaveAgentGroup` wipe trap could silently clear the `icon` field on any unrelated edit — the carry-forward at the save literal is the mitigation and must be tested explicitly; (2) the picker depends on an endpoint from a sibling plan — if that plan hasn't landed, the picker is empty; (3) `FileReader.readAsDataURL` reads the full file before the size cap can be checked — a `file.size` pre-check is needed. Mitigations: explicit wipe-regression test (set icon, edit name, save, confirm icon survives); add the endpoint dependency to the Dependencies section; check `file.size` before reading.

## Proposed Changes

### `src/webview/kanban.html`
- **Context:** The TEAMS tab editor form (`#agent-groups-name` / `#agent-groups-head-role`, line 5265) has no icon field. The save literal at line 5344 rebuilds the group from scratch and drops unnamed fields.
- **Logic:** Add an icon picker UI (preview button, inline grid from `GET /terminals/icon-palette`, custom file input, reset entry). Add `...(iconValue ? { icon: iconValue } : {})` to the save literal at line 5344, with a comment matching the existing carry-forwards. Add `teamIconSrc(group)` helper. Render the chosen icon in `teamsTabGalleryCard` (line 4800) and `teamsTabRenderFlow` head node (line 4924).
- **Edge Cases:** Check `file.size` on the `<input>` change event before `FileReader.readAsDataURL` — reject files whose raw size exceeds ~48 KB (encodes to ~64 KB base64). Give every art `<img>` an `onerror` that swaps in the role portrait — note this fires after a network round-trip, so a brief broken-image flash may appear on slow connections.

### `src/services/LocalApiServer.ts` (or the `saveAgentGroup` handler)
- **Context:** The webview is not the only writer of `terminals.agentGroups`.
- **Logic:** Validate `icon` server-side: accept only `art:`, `pack:`, and `data:` prefixes; reject anything else; enforce the 64 KB cap on `data:` URIs.
- **Edge Cases:** A `pack:` filename with spaces must be URL-encoded at the resolver, not at storage time — store the raw filename.

### 1. The `icon` field
Add `icon?: string` to the team definition stored at `terminals.agentGroups`. Three accepted forms, discriminated by prefix so no separate `iconKind` field is needed:
- `art:<name>` — **the form that matters long term.** A prefixed art filename without its extension (`team-atlas`), resolved to `/static/icons/team-atlas.png`. Regenerating a piece overwrites the same filename, so a team's saved icon keeps working when the art underneath it is replaced — which is the normal case with externally-generated art.
- `pack:<filename>` — a direct file under `icons/`, for the stand-in period only. **Encoding is mandatory**: the stand-in filenames contain spaces (`25-1-100 Sci-Fi Flat icons-01.png`), so raw interpolation yields a broken URL. Do not spend effort renaming the stand-in pack — it is leaving. Encode at the resolver and move on.
- `data:image/...;base64,...` — a custom icon the operator supplied inline.

Prefer `art:` for everything the picker offers. `pack:` exists so a stand-in choice is representable, and is the form that disappears with the stand-ins.

Absent/empty `icon` → fall back to the existing role portrait. The fallback is load-bearing: every already-defined team has no icon, and none of them may render blank.

### 2. Picker UI in the TEAMS tab editor
In the team form (alongside `#agent-groups-name` / `#agent-groups-head-role`, `kanban.html:5265`):
- A current-icon preview button showing the resolved icon (or the role portrait when unset).
- Clicking it opens an inline grid of the available art. Populate it from `GET /terminals/icon-palette`, which reads the `icons/` directory server-side and returns `[{ name, src, mtime, kind }]` with `kind` derived from the filename prefix (`agent-` / `team-` / other). Do **not** hardcode filenames into `kanban.html`, and do not glob client-side.
  Grouping by `kind` lets the picker show `Agents`, `Teams` and `Stand-in` as separate sections, so the stand-in pack can be dropped from the palette as one group once real art lands. The endpoint is specified in `agent-and-team-pixel-art-pipeline.md`; this plan is its first consumer.
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

This resolver is the seam the pixel-art plan takes over. It must be the **only** place a stored `icon` value becomes a URL, so that adding `art:` resolution through the registry later is one function's worth of change across all five surfaces. Write it that way even though this plan has only two consumers.

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
3. Unit: `teamIconSrc` — `art:` form resolves to the static URL; `pack:` form URL-encodes correctly (test with a spaced filename); `data:` form passes through; empty/absent returns `null`; a malformed value returns `null` rather than throwing.
   Plus: an `art:<name>` still resolves after the underlying PNG is replaced on disk. This is the placeholder-swap guarantee; assert it now, while the art is still stand-in.
4. Unit/server: `saveAgentGroup` rejects an `icon` that is neither prefix, and rejects an oversized data URI.
5. Manual, installed VSIX: pick a pack icon for team A and a custom PNG for team B. Confirm both render on the gallery card and on the flow head node. Reload the board and confirm both persist.
6. Manual: delete the picked pack file from `icons/`, reload, confirm the card falls back to the role portrait rather than a broken image.
7. Manual: a team with no icon set renders exactly as it does today — same portrait, same layout, no shift.
8. Both themes: confirm every palette icon is legible on light and dark.

---

## Completion Report — Team icon picker subtask

Implemented the team icon picker UI in the TEAMS tab plus the carry-forward wipe-trap rescue and server-side validation. Added `teamIconSrc(group)` as a thin wrapper over the landed `resolveArt` (reads `group.icon`, hands to `resolveArt`, returns URL or null), and `teamsTabPortraitEl(group, size)` which renders an `<img>` (with `.pixel-art`, explicit width/height, `flex:none`, and an `onerror` that swaps in the role portrait SVG) when an icon is set, else the inline SVG `<use>` — used by both the gallery card and the flow head node (head only; members keep role portraits). The picker UI (preview button, inline grid populated from a new `getIconPalette` kanban verb, custom file input with a 48 KB raw / 64 KB encoded double-gate, and a reset entry) was added to the editor form between head-role and Members. The critical wipe-trap carry-forward `...(iconValue ? { icon: iconValue } : {})` was added to the save literal at the rebuild-from-scratch point, falling back to `prevGroup?.icon` when the picker was never mounted. Server-side `validateTeamIcon` (in the new shared `src/services/iconPalette.ts`) rejects unrecognised prefixes and oversized `data:` URIs in the `saveAgentGroup` handler. Because the kanban webview cannot fetch `GET /terminals/icon-palette` directly (VS Code CSP + no auth cookie), a `getIconPalette` verb was added to KanbanProvider (routed through the existing verb rail, added to `KANBAN_VERBS` + `protocol-catalog.json` via `catalog:generate`); both paths share `listIconPalette` so the browser cockpit and VS Code webview agree. Files changed: `src/webview/kanban.html`, `src/services/KanbanProvider.ts`, `src/services/LocalApiServer.ts` (refactored to use shared util), new `src/services/iconPalette.ts`, regenerated `protocol-catalog.json` + `src/generated/verbAllowlist.ts`. No issues encountered; `tsc --noEmit` clean for all touched files (5 pre-existing errors in untouched files), `catalog:check` green, webview JS syntax-checked.

## Review Findings

Reviewed picker persistence, URL resolution, host validation, and fallback rendering; changed `src/services/iconPalette.ts` and `src/webview/kanban.html`. Tightened server validation to base64 PNG/SVG/WebP data URIs and traversal-safe art/pack names, and loaded palette-backed agent art without speculative 404s. Compile, catalog, lint, and selected browser-panel checks passed, with only existing warnings. Remaining risk is manual validation of custom icon persistence and appearance in both themes. No confirmation dialogs per CLAUDE.md — reset and custom-clear act immediately.
