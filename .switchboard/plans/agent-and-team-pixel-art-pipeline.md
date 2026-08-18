# Agent & Team Pixel Art: Drop PNGs in `icons/`, Render Them Everywhere

## Goal
Make an externally-generated pixel-art PNG usable by dropping it into `icons/` under a name convention. One shared resolver and one CSS treatment so a piece renders identically on every surface, integer display sizes so raster art is not blurred, and a fallback to today's placeholders so a half-populated set still looks finished.

### The problem, and the root cause
Agent art today is inline SVG in one document. `kanban.html:3227` calls it *"Placeholder art"*, and what follows is five `<symbol>` elements on a 24×24 viewBox (`kanban.html:3240`–`3286`), mapped from `headRole` by `teamsTabPortraitId` (`kanban.html:4736`). Two things about that wiring block dropping real art in:

1. **`<use href="#portrait-lead">` resolves only within the current document.** `kanban.html` holds the symbols; `terminals.html` and the shell rail are separate documents and cannot reference them. That is exactly why the rail already draws image *files* from `/static/icons/` while the TEAMS tab draws inline symbols — two art paths that cannot share a piece. Anything added inline stays invisible to the rail, the cockpit and the sidebar.
2. **Display sizes are not integer multiples of the grid.** `TEAMS_TAB_CELL = 28` (`kanban.html:4745`) renders a 24-unit viewBox at 28px — 1.1667×. Vector rects tolerate that; **raster pixel art at a fractional scale is visibly blurred or unevenly stepped.** This must be fixed before any PNG is rendered, and 28 is not a useful multiple.

Per-agent portraits also have no file slot at all. Team icons get one from the icon-picker plan; a generated portrait PNG currently has nowhere to go.

### What does not need building
`icons/` is already served at `/static/icons/` in both hosts (`TaskViewerProvider.ts:3522`, `bootstrap.ts:672`), with traversal-guarded relative paths (`LocalApiServer.ts:906`). A PNG dropped in there is fetchable immediately. **No new route, no new directory, no manifest file.** An earlier draft of this plan specified a `manifest.json` with ids, labels and versions; it was cut. Its only advantage over a naming convention was renaming assets without breaking stored references, which is not a real workflow here — regenerating art overwrites the same filename and every reference keeps working. The list the picker needs comes from a directory read.

## Metadata
- **Complexity:** 4
- **Tags:** frontend, ui, ux, refactor

## Non-goals
- Authoring, drawing, or art-direction guidance. Art comes from an external generator; the app's only interest is the file's dimensions.
- Populating the full set. This plan wires the mechanism and one piece.
- Deleting the inline symbols — they stay as the fallback until every role has art.

## Approach

### 1. Naming convention, in the existing folder
`icons/` already uses prefixes: `brand-claude.svg`, `nav-board.svg`, `icon-close.svg`. Extend that pattern:
```
icons/agent-<role>.png      # agent-lead.png, agent-coder.png, agent-planner.png, …
icons/team-<slug>.png       # operator-facing team art
```
The filename **is** the id. `agent-lead.png` is found by role `lead`, lowercased and non-alphanumerics collapsed to `-`. No registry, no config, no indirection: to add art for a role, name the file after the role.

Team icons store `art:team-<slug>` (the icon-picker plan's `art:` form), which resolves to `/static/icons/team-<slug>.png`.

### 2. Size contract: 32×32
The only requirement the app places on a generated asset: **32×32 pixels, RGBA, transparent background, hard edges** — no anti-aliased or semi-transparent boundary pixels, which read as blur once scaled.

If the generator emits 32×32 directly, nothing else is needed. If it emits a large anti-aliased image — common, since many tools produce a big smooth PNG that merely *depicts* pixel art — resize it to 32×32 in any image editor before committing, using a box/average filter rather than nearest-neighbour. That is a one-time manual step per asset, not a build step. Do **not** commit the large original and rely on the browser to shrink it: browsers do not honour `image-rendering: pixelated` usefully when downscaling by a large factor, so apparent-pixel boundaries land inconsistently and the art shimmers between sizes. It looks like a rendering bug while each asset looks fine when opened, which is why the size check in step 5 exists.

### 3. Integer display sizes
- **32px** — shell rail, flow nodes, cockpit sidebar rows.
- **64px** — TEAMS gallery cards, cockpit header.
- Nothing renders at a fractional scale. Set explicit `width`/`height` **and** `flex: none`; a flex parent that stretches the `<img>` to a fractional box silently reintroduces the blur.
- **`TEAMS_TAB_CELL` 28 → 32.** A real layout change to the TEAMS gallery — verify the card grid does not reflow badly. The constant's comment says it is fixed *"so better art cannot shift layout"*; preserve that intent at the new value.

### 4. One resolver, one CSS class, five surfaces
- `resolveArt(value)` → URL or `null`, handling `art:<name>` → `/static/icons/<name>.png`, plus the `pack:` and `data:` forms the icon-picker plan defines. The icon-picker plan names `teamIconSrc` as this seam — extend that function, do not add a second.
- Append the file's mtime as a query param so a regenerated asset is not served stale: static art is cached `public, max-age=3600` (`LocalApiServer.ts:920`), and art will be re-rolled repeatedly. Get mtime from the same listing endpoint the picker uses; no per-asset bookkeeping.
- One CSS class, defined once per webview stylesheet (separate documents, no shared sheet):
  ```css
  .pixel-art { image-rendering: pixelated; -ms-interpolation-mode: nearest-neighbor; }
  ```
- Render with `<img>`, not the CSS-mask/`currentColor` path used for nav icons. The reasoning is at `shell.js:542`: multi-hue art whose baked-in fill *is* the identity; masking flattens it to one colour.
- Apply at: TEAMS gallery card (`kanban.html:4800`), TEAMS flow head node (`kanban.html:4924`), shell rail button, team cockpit header, cockpit sidebar rows.

### 5. Listing endpoint, and a size guard
`GET /terminals/icon-palette` reads `icons/`, returns `[{ name, src, mtime, kind }]` where `kind` comes from the filename prefix (`agent-` / `team-` / other). This is the picker's source in the icon-picker plan, replacing the manifest that plan originally referenced.

While listing, flag any `agent-*` / `team-*` PNG that is **not** 32×32, and surface it in the picker as a warning on that entry. This is the one guard worth building: committing an unresized generator output is the likeliest mistake and it presents as a rendering bug rather than a bad file.

### 6. Per-agent art, replacing `teamsTabPortraitId`
Resolve a role: `agent-<role>.png` if present, else the inline `<symbol>`, else `portrait-agent`. Keep `teamsTabPortraitId` as the fallback arm rather than deleting it — a half-populated set must not leave blank cards, and roles are operator-authored free text (`members[].role`, `kanban.html:5315`), so an unknown role is normal, not an error.

### 7. Rollout
1. Resolver, CSS, `TEAMS_TAB_CELL` → 32, listing endpoint, size guard, fallback chain. **No art required** — every surface renders as today, because each piece falls back to its inline symbol.
2. Generate one piece, resize to 32×32, commit as `icons/agent-lead.png`. It appears at 32px in the rail and 64px on the card, hard-edged, while the other four roles still show placeholders. End-to-end proof, and a sensible end to this week's work.
3. Everything after that is asset production. Each committed PNG lights up everywhere at once, no code change.

## Edge cases
- **Unresized generator output committed.** Caught by the size guard in step 5, named in the picker. Without that guard it renders as shimmer and reads as a bug in the app.
- **File missing but referenced** (team stored `art:team-foo`, PNG deleted). `<img>` 404s — give every art `<img>` an `onerror` that falls through the chain, so it degrades to a placeholder rather than a broken-image glyph.
- **Non-integer rendered box.** Add a dev-mode assertion logging when a rendered art element's computed box is not 32 or 64. Subtle, and easy to reintroduce during unrelated CSS work.
- **High-DPI.** `pixelated` at 2× maps each art pixel to an even number of device pixels — correct. Do **not** ship `@2x` variants; one asset serves every ratio. Verify on Retina.
- **Light theme.** Art will be generated against one background in practice. Check each piece on both themes; where one disappears, regenerate or put a container chip behind it — not a per-theme asset pair.
- **Role name with spaces or punctuation** (roles are free text). Slugify consistently — lowercase, non-alphanumerics to `-`, collapse repeats — and use the same slugifier for lookup and for the filename shown in the picker, so an operator can tell what to name a file for `Senior Reviewer`.
- **Name collision with the existing stand-in pack.** The sci-fi files are `25-1-100 Sci-Fi Flat icons-NN.png`; the `agent-`/`team-` prefixes cannot collide. Flat namespace is safe.
- **Custom `data:` team icon.** Bypasses the convention and the size guard entirely. Render with `pixelated` anyway (harmless at 1×) and note 32×32 is expected in the picker. Do not detect or reject.
- **Inline symbols orphaned.** Once every role has art the `<symbol>` block is dead weight in `kanban.html`. Remove it in a separate change together with the fallback arm, not as a drive-by deletion.

## Verification Plan
1. `npm run compile` — clean.
2. Unit: role → filename slugification (`lead` → `agent-lead.png`; `Senior Reviewer` → `agent-senior-reviewer.png`); lookup and display use the same slugifier.
3. Unit: `resolveArt` — `art:<name>` resolves to the static URL with an mtime param; a missing file returns `null`; `pack:` and `data:` forms still resolve (icon-picker cases must not regress).
4. Unit: role → art resolution walks file → inline symbol → `portrait-agent`; an unknown operator-authored role lands on `portrait-agent` without throwing.
5. Unit: the listing endpoint classifies by prefix and flags a non-32×32 `agent-*`/`team-*` PNG.
6. Unit/DOM: every art element's **computed** box is exactly 32 or 64 CSS px in all five surfaces.
7. Manual, installed VSIX, **no art present**: TEAMS gallery, flow diagram, rail, cockpit header and sidebar unchanged from today apart from the 28→32 portrait size; card grid does not reflow badly.
8. Manual: commit `icons/agent-lead.png` (32×32), reload. Appears in all five surfaces. Zoom to 400% — hard pixel edges, no interpolation. Other four roles still show placeholders.
9. Manual: regenerate the same filename, reload — new art appears immediately, not after the 1-hour cache window (pins the mtime param).
10. Manual: drop in a deliberately unresized 512×512 file — the picker flags it rather than silently rendering shimmer.
11. Manual: delete a referenced PNG — every surface falls back, no broken images, no console spew.
12. Manual: one piece on Retina at 32 and 64, on both themes.
