# One Colour In The Rail: Theme-Accent Team Icons, No Status Palette

## Goal

Collapse the rail's five competing colour signals into one. Team icons are painted in
the theme accent and read as living things; every other rail icon is a monochrome label
glyph. Selection is expressed as a shape, not a hue, so it stops fighting the accent.
The green completion ring, the violet queue badge, the grayscale exited treatment and the
cyan Mission Control lights all go.

### The problem, and the root cause

The rail accreted one colour per feature, each independently defensible, and nobody ever
looked at them together:

| Signal | Colour | Source |
| :--- | :--- | :--- |
| Panel selected | `--accent` text + `--accent-dim` border | `shell.html:100` |
| Completion notification | hardcoded `#22c55e` ring | `shell.html:344` |
| Queue depth badge | `--accent-violet` (`#c586c0`) on `--panel-bg` | `shell.html:415` |
| Terminal/team exited | `grayscale(1) brightness(1.7)` | `shell.html:341`, `:401` |
| Mission Control active | animated `#00e5ff` lights | `shell.js:376` |
| Mission Control inactive | `opacity .35` + `grayscale(.8)` | `shell.html:267` |

Six treatments, five hues, in a 48px column. The UFO's cyan leaves with the button
itself (rail restructure plan), so this plan is left with four to remove. The root cause is that `--accent` was
claimed early as the *panel-selection* colour — `shell.html:348` states it outright and
uses it to justify hardcoding the completion ring green — which left every subsequent
state signal to invent its own hue rather than reuse the theme. The rail now advertises
selection more loudly than it advertises the fleet.

The consequence the operator actually feels: **team icons do not read as different in
kind from nav icons.** A team is a live thing with a state; Artifacts is a label. Both
are a 36px square with a masked monochrome glyph, distinguished only by whether a
transient ring happens to be playing.

## Metadata
- **Complexity:** 5
- **Tags:** frontend, ui, ux, refactor

## No migration

Clean break. Pure presentation, no persisted state. Do not preserve any of the removed
signals behind a setting; CLAUDE.md's migration rule is waived for this release.

## Relationship to the interceptor plan

`placeholder-portraits-become-one-radar-interceptor.md` introduces a single interceptor
silhouette painted `var(--accent)` and its edge-case audit states: *"Do not extend accent
to the button's border or background"* — because accent border+background is the
selection cue. **This plan supersedes that constraint** by removing the conflict at its
source: selection stops being an accent colour. The interceptor plan's glyph-fill
approach is otherwise adopted unchanged, and this plan should land after it or alongside
it. If they land together, the interceptor plan's `fill="currentColor"` +
`color: var(--accent)` host-element mechanism is the one to use.

## Implementation

1. **Selection becomes a shape.** Replace `.strip-icon.is-active`'s accent text and
   accent-dim border with a left-edge indicator: a 2px `--text` bar inset on the button's
   leading edge, plus `background: var(--bg-elev)` (already there) and
   `color: var(--text)` for the glyph. Shape-first means it survives monochrome and
   deuteranopic viewing, and it frees the accent entirely.
2. **Team icons are accent, always.** `.strip-team-icon` gets the accent fill per the
   interceptor plan. This is now the rail's *only* use of the accent, which is what makes
   "this is a team" legible at a glance.
3. **Delete the completion ring.** Remove `@keyframes strip-term-done-pulse` and
   `-reduced` (`shell.html:364-375`), both `.is-pulsing` rules (`:377`, `:405`), the
   `pulsedDoneStamps` ledger and `DONE_PULSE_MS` (`shell.js:672-673`), and the pulse
   arithmetic in the team loop (`shell.js:1153-1163`). The durable completion record is
   unaffected: the Terminals panel keeps its sidebar DONE chip and pane badge, which
   `shell.html:359` already names as the record of truth.
   - **Delete the `clearTeamBadges` relay too** (`shell.js:1211` and its receiver at
     `terminals.js:1173`). The relay exists only because the rail rendered a completion
     state that had to be acknowledgeable *from the rail* — the comment at
     `terminals.js:1176` says so: *"the team button's click IS the acknowledgement for the
     whole team ... without this the aggregate 'done' light burns forever."* With no
     aggregate done light there is nothing to burn, so the shell has no business
     acknowledging on the panel's behalf.
     - The badge itself stays and stays useful. `terminalBadges`
       (`terminals.js:~222`) is an *unread* marker, set on `agentCompleted`
       (`terminals.js:10407`) and cleared when the operator actually looks: `focusTerminal`,
       `clearTerminalBadge`, `btn-team-ack` (`terminals.js:11971`), terminal exit, close
       and rename — seven delete sites, all panel-side, all unaffected. It cannot clear
       "when completion is listed", because being listed as complete is precisely what
       sets it; a badge that cleared on the same event would never be visible.
   - **Stop relaying `light` and `doneStamp` altogether.** Once the ring, the exited
     grayscale and the queue badge are gone, the rail consumes none of
     `postFleetStateToShell`'s completion state — the team-slots plan renders from
     `running`, and the dispatched-state plan renders from `dispatched`. Drop `light` and
     `doneStamp` from the relayed `teams` payload and delete the aggregate light
     computation (`terminals.js:1707-1730`) rather than leaving a computed field with no
     consumer. The panel's own sidebar and pane rendering do not go through this payload.
4. **Delete the queue-depth badge.** Remove `.strip-team-queue-depth` (`shell.html:415`)
   and its construction (`shell.js:1198`). `refreshTeamQueueDepths`
   (`terminals.js:1642`) and the `queueDepth` field stay — the dispatched-state plan
   consumes them, and the queue list is still shown in the Terminals panel.
5. **Delete the exited grayscale.** Remove `.strip-term-btn.strip-term-exited` and
   `.strip-team-btn.strip-term-exited` (`shell.html:341`, `:401`). With fixed team slots
   (companion plan) an absent team is rendered by the dim-empty slot treatment, which is
   one mechanism instead of two.
6. **The UFO is deleted, not repainted** — by the rail restructure plan, which owns that
   change. Two consequences here. The rail's animated cyan disappears without this plan
   touching it, leaving the accent and the monochrome ramp as the only colours in the
   rail. And the UFO's *dimmed* treatment (`shell.html:267`) must be promoted to a
   panel-agnostic `.strip-icon.is-dormant` **before** the UFO's rules are deleted,
   because the team slots adopt it for dormant slots — dimmed-means-inactive-and-
   clickable-to-start is the shell's existing vocabulary and is worth keeping.

## Edge cases

- **`--accent-dim` under `theme-claudify` is a 40%-alpha terracotta, nearly invisible on
  `#060609`** (`shell.html:350`). It must not be reintroduced anywhere by this plan.
- **The accent must not also paint team icon borders or backgrounds.** Fill only. If both
  the glyph and the border are accent, selection and team-ness collide again — which is
  the entire problem being fixed.
- **Contrast.** Verify the accent glyph against `--bg` in both themes at 36px. The
  interceptor plan flags a `currentColor` resolution hazard (`:158`) — a missing
  host-element `color` silently falls back to default text colour and the icon looks
  broken rather than absent.
- **Reduced motion.** With the pulse gone the rail has no animation except the UFO
  lights, which already honour `prefers-reduced-motion`. Confirm no orphaned
  `@media (prefers-reduced-motion)` blocks remain referencing deleted keyframes.
- **Tests pin the deleted signals.** `shell-terminal-strip.test.js` and
  `terminal-replay-gap-contract.test.js:234` both assert on the done light. The replay-gap
  test's *intent* — a replay gap must never light the rail as done — is load-bearing and
  must be preserved against whatever the new state channel is, not deleted with the ring.

## Verification plan

1. `npm run compile` clean.
2. Screenshot the rail in both themes with three teams and a selected panel. Count
   distinct hues: expected exactly two — the accent (team icons) and the text/dim
   monochrome ramp — plus the UFO's cyan.
3. Selection: click each primary and cold panel; confirm the left-edge bar moves and no
   accent appears on any nav icon.
4. Complete an agent's work; confirm no ring plays on the rail, and confirm the Terminals
   panel sidebar DONE chip and pane badge still appear.
5. Complete work in a team member, then click that team slot: confirm the rail shows
   nothing, and confirm the member's DONE badge is still present in the Terminals panel
   until the operator opens that terminal or hits the team ack — i.e. the unread marker
   survives the relay's deletion.
6. Grep for `clearTeamBadges`, `doneStamp` and `DONE_PULSE_MS`; confirm zero live
   references in either host.
7. Simulate a replay gap; confirm the rail shows no completion state and that the gap
   also never marks a team dispatched — the invariant at
   `terminal-replay-gap-contract.test.js:244` must be re-pointed at the new state channel,
   not deleted with the ring it was written about.
8. Greyscale the screenshot and confirm selection and team-ness are both still readable.
9. Both hosts.
