# Switchboard — agent rules

## NEVER add confirmation dialogs. NO EXCEPTIONS.

Delete buttons delete immediately. No `confirm()`, no `window.confirm()`, no modal `showWarningMessage`, no two-click patterns, no "Are you sure?". The user has demanded this repeatedly. Buttons are deliberately hard to misclick.

Also a hard technical reason: `window.confirm()` is a **silent no-op in VS Code webviews** (sandboxed iframe without `allow-modals` — it always returns `false`). Any confirm gate added to `src/webview/planning.js`, `src/webview/kanban.html`, etc. makes the button do *literally nothing*. This exact bug broke the kanban delete-plan button (fixed 2026-06-11).

If you find a confirm gate in this codebase, it is a bug — remove it. Multi-choice decision dialogs (e.g. 3-way conflict resolution) are allowed; plain confirm gates are not.

## Standalone and the extension MUST NOT diverge. NO EXCEPTIONS.

Switchboard ships **two hosts**: the VS Code extension (`src/extension.ts`) and
the standalone/npx host (`src/standalone/bootstrap.ts`). Every feature must land
in **both**. If you are planning a feature, the plan names both composition
roots and its verification covers both. If you are implementing one, the diff
touches both. "Extension first, standalone later" is not a plan — it is a
divergence, and no gate catches it.

**The trap is not verbs.** `bootstrap.ts`'s `default:` arm delegates every
unmatched verb to the provider, so verb-reachability audits always come back
green. The trap is **composition-root wiring**: service seams
(`engine.setX(...)`), options objects handed to shared services, and
`Promise<void>` callbacks where "never wired" and "working" are the same value.
Diff the two roots by hand. The seams each host *wires* are the audit — not the
verbs each host answers.

**Precedent (2026-08).** All four `PlanIngestionEngine` queue seams —
`setQueueHeadResolver`, `setQueuePacingResolver`, `setQueueTeamMembersResolver`,
`setQueueEscalationRecorder` — were wired in `extension.ts` only, a month after
standalone shipped. Consequently **no queue watch was ever armed in the
standalone host**: seat pacing was unreachable, dead seats were never re-staged,
and the queue stall backstop did not exist. Every gate stayed green, because
`npm run standalone-parity:check` is scoped to the browser read-back path, not
the composition root. The two roots had also drifted the *other* way — standalone
wires two seams the extension does not.

## Build

- `npm run compile` (webpack) builds to `dist/`, but **`dist/` is NOT used during development or testing**. All testing is done via an installed VSIX — nothing is served from the repo's `dist/` directory. Do NOT audit, check, or flag `dist/` staleness during reviews or verification. Treat `src/` as the source of truth. `npm run compile` is only needed when producing a VSIX for release.

## Users & migrations

- **Published extension, ~4,000 installs**, many on much older versions. The dividing line is whether the state **shipped in a released version**:
  - State/files/settings that exist in any released version MUST be migrated on change: import before deleting, archive legacy files as `*.migrated.bak` rather than unlinking, preserve unknown/legacy keys instead of dropping them, and never assume a prior migration "already ran" for the install base.
  - Features that have only ever existed in unreleased dev work can take clean breaks — no migrations, no compat shims.
- When unsure whether something shipped, assume it did and migrate — a no-op migration costs nothing; a missing one destroys user data.

<!-- switchboard:claude-protocol:start -->
- Plans reach the board on their own: a `.md` file written to a designated
  plans directory is imported automatically by a watcher. Committing is
  irrelevant — untracked files import too. Never import a plan yourself.
- Memo capture mode: while active, append each user message verbatim — do not
  analyse, plan, or write code. Begin every reply with `[MEMO CAPTURE ACTIVE]`.
- Kanban questions: use the `query-kanban` skill. Displayed column labels differ
  from the stored IDs, so hand-written SQL silently returns nothing.
<!-- switchboard:claude-protocol:end -->
