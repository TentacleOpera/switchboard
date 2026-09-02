# Team icons: the picker shipped, but every team outside kanban.html falls back to the same generic jet

## Goal

Give teams real, distinct art on every surface that draws them — starting with `/command`, which currently paints all four of this workspace's teams with one identical `nav-jet.svg`. Establish a file-based fallback chain that non-`kanban.html` documents can actually use, and seed the shipped team definitions with distinct art so a team looks like itself without the operator hunting through a 250-icon palette.

### Problem Analysis

**What already works — do not rebuild it.** The authoring half of team icons landed:

- `GET /terminals/icon-palette` lists the art in `icons/` (`LocalApiServer.ts:5344`), shared by both hosts.
- The TEAMS tab has a picker: `teamsTabIconValue()` (`kanban.html:5741`), wired into the save literal as `...(iconValue ? { icon: iconValue } : {})` (`:6041`), with the `prevGroup?.icon` carry-forward that stops an unrelated edit wiping the field.
- `icons/` holds 250 sci-fi flat PNGs plus `nav-jet.svg` and the brand SVGs, served at `/static/icons/` on both hosts with a traversal guard.
- `/command` already has a resolver that understands both storage forms: `resolveTeamIconUri` (`command.js:936-949`) maps `art:<name>` → `/static/icons/<name>.png` and `pack:<file>` → `/static/icons/<file>`.

So the earlier circular dependency between `team-icon-picker-in-teams-tab.md` and `agent-and-team-pixel-art-pipeline.md` — each naming the other as needing to land first — is **resolved**. Both halves exist. That is not where the gap is.

**Where the gap actually is — two things.**

1. **No team has an icon.** All four persisted teams in `terminals.agentGroups` carry `icon: undefined` — the operator's `group-coding-mswk2w8r` ("Coding") and the three `DEFAULT_TEAM_DEFINITIONS` seeds (`teamWiring.ts:529-548`), which are literal objects of `{id, name, headRole, members}` and have never had an `icon` key. The field is optional, defaults to empty, and nothing assigns one. A team therefore only has art if the operator went to the desktop TEAMS tab and picked one per team.

2. **The two surfaces have completely different fallbacks, and only one of them is any good.** With `icon` empty:
   - `kanban.html` falls back to `teamsTabPortraitId(role)` (`:4941`), resolving to inline `<symbol>` placeholder portraits — `#portrait-lead` and siblings at `:3262` — five role-distinct shapes.
   - `command.html` falls back to `|| '/static/icons/nav-jet.svg'` (`command.js:1027`) — **one shape for every team, every role**.

   The inline symbols cannot be shared, and the pixel-art plan already says why: *"`<use href="#portrait-lead">` resolves only within the current document. `kanban.html` holds the symbols; `terminals.html` and the shell rail are separate documents and cannot reference them."* `command.html` is a third such document, and the shell strip a fourth.

### Root Cause

**The art that distinguishes teams lives in a form only one document can read, and the file-based path that every document *can* read was never given a default.** `kanban.html` got role-distinct fallbacks because it happens to own the symbols; everyone else got a single hardcoded filename because a file fallback needs a *file per role*, and nobody created one.

Layering on top: the `icon` field is opt-in with no seeded value, so the well-built picker only pays off for an operator who visits it once per team. Four teams here, zero visits, so every surface is showing a fallback — and on the phone all four fallbacks are the same picture.

### Non-goals

- **No new picker, no new endpoint, no manifest.** All three exist. This plan is fallbacks and defaults.
- **Do not migrate `terminals.agentGroups` to stamp `icon` onto existing rows.** The seeds ship in released versions; a resolver default reaches every install without touching persisted data, and leaves the operator's own picks authoritative.
- Not converting `kanban.html`'s inline symbols to files in this plan. It may keep them; it must simply stop being the only surface with role-distinct art.

## Metadata

**Topic:** File-based per-role team art so every surface draws distinct icons
**Complexity:** 4
**Tags:** webview, ui, mobile, command-surface, teams, icons

## User Review Required

None. The art selection is specified below as a named set drawn from the existing `icons/` directory.

## Complexity Audit

### Routine
- Extending `resolveTeamIconUri` with a role arm.
- Adding `icon` values to the three `DEFAULT_TEAM_DEFINITIONS` literals.

### Complex / Risky
- **Choosing the per-role art.** `icons/` holds 250 numbered sci-fi PNGs with no semantic names (`25-1-100 Sci-Fi Flat icons-42.png`). Referencing them by number is unreadable and breaks if the pack is ever re-exported. Copy the chosen five to stable role-named files (`team-lead.png`, `team-coder.png`, `team-reviewer.png`, `team-planner.png`, `team-intern.png`) and reference those. The numbered originals stay for the picker's palette.
- **Filenames with spaces.** Existing pack files contain spaces and `copy` suffixes; `resolveTeamIconUri` already `encodeURIComponent`s the `pack:` arm, but the new role files must avoid the problem entirely by being named without spaces.
- **Adding `icon` to `DEFAULT_TEAM_DEFINITIONS` changes an exact-value comparison.** `OLD_SEEDED_AGENT_GROUP` (`teamWiring.ts:563-568`) identifies an untouched old seed *by exact-value comparison* to neutralise its three unrequested coders. `SEEDED_AGENT_GROUP` is `DEFAULT_TEAM_DEFINITIONS[1]` (`:550`). Adding a field to that literal risks changing what compares equal. Verify the migration comparison is against `OLD_SEEDED_AGENT_GROUP` only and is unaffected — and if it is not, seed the default in the resolver instead of in the literal.

## Edge-Case & Dependency Audit

**Race conditions:** None. This is a synchronous render-path resolution.

**Security:** The role arm builds a path from `team.headRole`, which is persisted operator-controlled data. It must map through a fixed allow-list of known roles to fixed filenames — never interpolate the role into a path — or it becomes a traversal vector aimed straight at the static serve route. The existing guard at `LocalApiServer.ts:906` is the backstop, not the first line.

**Side effects:** New files in `icons/`, which is served wholesale. They will also appear in the picker's palette listing, which is harmless and arguably useful.

**Dependencies & conflicts:** Touches `renderTeamRow`, which the team-membership plan in this feature also edits. Land this one after it.

## Dependencies

- **`command-teams-view-resolves-membership-by-role.md`** — restructures `renderTeamRow` and adds member rows, which will also want art. Land that first so this plan's resolver reaches both the team row and the new seat rows in one pass.

## Adversarial Synthesis

Key risks: (1) rebuilding the picker or the palette endpoint on the assumption they were never coded — both exist and are cited above by file and line; the deadlock between the two prior plans is already broken; (2) interpolating `headRole` into a static path, turning a display default into a traversal vector — mitigation: a fixed role→filename map, no interpolation; (3) adding `icon` to `DEFAULT_TEAM_DEFINITIONS` and silently breaking the `OLD_SEEDED_AGENT_GROUP` exact-value migration that stops three unrequested coders spawning per lead — mitigation: verify that comparison explicitly, and fall back to seeding in the resolver if it is affected; (4) referencing the numbered pack files directly, so the art breaks on any re-export — mitigation: stable role-named copies.

## Proposed Changes

**1. Five role-named art files.**

Copy five visually distinct interceptor silhouettes from the existing pack to `icons/team-{lead,coder,reviewer,planner,intern}.png`. No spaces, no `copy` suffixes. The numbered originals stay untouched. Pick five that are clearly distinguishable at 22×22px (the `.team-icon-img` render size) — silhouettes that differ only in fine detail will look identical at icon scale.

**2. A real fallback chain in the shared resolver (`command.js:resolveTeamIconUri`).**

Extend to `resolveTeamArt(iconValue, role)`:
1. explicit `data:` / `art:` / `pack:` value → as today,
2. else `role` through a fixed map to `/static/icons/team-<role>.png`,
3. else `/static/icons/nav-jet.svg`.

The map is a literal object with five known keys; an unknown role falls to step 3 rather than building a path.

**3. Seed the shipped definitions (`teamWiring.ts:529-548`).**

Add `icon: 'art:team-planner'` / `'art:team-lead'` / `'art:team-reviewer'` to the three defaults — **only if** the `OLD_SEEDED_AGENT_GROUP` comparison is verified unaffected. If it is affected, omit this change entirely; step 2's role arm already delivers the same visible result for every team, seeded or not.

**4. Apply the chain to the member seat rows.**

The seat rows added by the membership plan resolve art by the seat's own role through the same function, so a coder row and an intern row are visually distinct from their lead.

## Verification Plan

1. With all four teams still carrying no `icon`, open `/command` → Teams. Coding (headRole `lead`) and any reviewer- or planner-headed team show **different** art. This is the core gate — today they are identical.
2. Expand Coding. Its coder seats and intern seat draw distinct role art from the lead's.
3. Pick a custom icon for Coding in the desktop TEAMS tab. The phone shows that pick, not the role default, on the next board push.
4. Clear that pick. The phone returns to the lead role default, not to `nav-jet.svg`.
5. Set a team's `headRole` to an unknown string directly in the config JSON. The row renders `nav-jet.svg` and no request is made for a path containing that string. Confirm in the network log.
6. Confirm no request 404s: every `/static/icons/team-*.png` referenced resolves.
7. **Migration gate:** on a workspace whose `terminals.agentGroups` holds the exact `OLD_SEEDED_AGENT_GROUP` value, confirm the neutralisation still fires and the group's members are still cleared — i.e. adding `icon` to the defaults did not break the exact-value comparison at `teamWiring.ts:563`.
8. Both hosts: run 1 and 3 against the VS Code extension and the standalone host.

### Goal Invariants

- Assert `resolveTeamArt` (or the extended `resolveTeamIconUri`) accepts a `role` parameter and resolves to `/static/icons/team-<role>.png` for the five known roles (lead, coder, reviewer, planner, intern).
- Assert an unknown role (not in the five-key map) falls through to `/static/icons/nav-jet.svg` — no path is constructed from the raw role string (traversal guard).
- Assert the five files `team-lead.png`, `team-coder.png`, `team-reviewer.png`, `team-planner.png`, `team-intern.png` exist in `icons/` and are served at `/static/icons/` without 404.
- Assert a team with no `icon` value and `headRole: 'lead'` renders a different image than a team with no `icon` value and `headRole: 'reviewer'` on `/command` (the core defect — today both render `nav-jet.svg`).
