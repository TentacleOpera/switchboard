# Ask where the board lives on first run, and stop defaulting the database into the repo

## Goal

On first run, let the user choose where their board database lives — machine-global, in the repo, or a path
they name — and honour that choice everywhere without further configuration. Existing installs get a
one-shot, non-destructive migration to the location they choose. The in-repo default becomes one option
among three instead of the only answer.

### Why the current default is debt, not just a preference

`KanbanDatabase.defaultDbPath(root)` returns `<root>/.switchboard/kanban.db`, and that is the last fallback
in `forWorkspace` (`KanbanDatabase.ts:1303`). Concretely, with the board inside the working tree:

- `git clean -xdf` deletes the board. So does a fresh clone, so does deleting and re-cloning a repo, so
  does any ephemeral checkout — a cloud session, a CI job, a container.
- A read-only or mounted-in repo cannot host a writable board at all.
- Synced folders corrupt it. `_warnConflictCopies` and the external-modification reload path
  (`_reloadIfStale`, plus the "modified by another machine" notice in `_initialize`) exist because this
  already happens in the field.
- The multi-repo control plane already contradicts the default: it pushes the DB up to a parent directory
  and leaves a `db-pointer` behind, which is the shape this plan generalises.

The counter-argument for in-repo is real and worth keeping as an option: the board travels with the
checkout, nothing is orphaned when a repo is renamed or moved, and two checkouts of one repo get two
boards. Some people want exactly that. It should be a choice, not the default.

**What makes the DB partly rebuildable, and partly not.** `.switchboard/plans/`, `features/`, `reviews/`
and `sessions/` are committed by design (see the `.gitignore` negations), and the plan watcher re-imports
`.md` files on sight. So plan *content* survives losing the DB. Column placement, priority order, dispatch
history, `plan_events`, worktree rows, feature membership and the config table do not — they are DB-only.
Losing the database is therefore not catastrophic and not harmless, which is exactly why the location
should be a deliberate decision.

### Design

**Carrier: `.switchboard/db-pointer`, not the `kanban.dbPath` setting.** The pointer already exists
(`writeDbPointer` `:1195`, `readDbPointer` `:1210`) and is already consulted *first* in `forWorkspace`,
ahead of the setting and the default. Using it means **no new resolution mechanism** — the ordering that
ships today already does what this plan needs. It is also the only carrier that works on both hosts: the
standalone shim's `Configuration.update` is a deliberate no-op (`vscodeShim.ts:218` onward), so a workspace
setting can never be written from the browser host, while a pointer is a plain file write.

Leaving a tiny gitignorable breadcrumb in the repo also solves orphaning in the right direction: move or
rename the repo and the pointer moves with it; the database stays where the user put it.

**Default offered: machine-global.** `~/.switchboard/boards/<dirname-slug>-<hash8>/kanban.db`, where
`hash8` is the first 8 hex of a sha256 over the resolved absolute workspace path. The slug keeps the
directory legible when a user goes looking; the hash keeps two same-named repos apart. `~/.switchboard` is
already the machine-global home for the encrypted secrets store, so this adds a sibling rather than a new
convention.

**The three options, on first run:**

1. **This machine** (default) — the path above. Survives `git clean`, fresh clones, ephemeral checkouts.
2. **In this repo** — `<root>/.switchboard/kanban.db`, today's behaviour, for people who want the board to
   travel with the checkout. Stated with its trade-off, not hidden.
3. **A path I choose** — absolute path, `~` expanded. The existing Dropbox / iCloud / Google Drive presets
   fold in here as shortcuts. Must carry an explicit warning: a synced folder is not a shared database
   (see the concurrency note below).

**When the question is asked.** Only when there is no existing control plane and no pointer — first
activation in a workspace, and standalone `init` / first start. Never on upgrade, never again once
answered. A non-interactive host (`--detach`, CI, a cloud session) must not block: it takes the default and
logs which location it chose, with the CLI flag to override it stated in that same line.

**Resolve through a location provider, not a bare path.** Today's providers are `local-path` (a filesystem
path) and nothing else. Give the resolver an interface — resolve, validate, migrate-into — so a future
`app-managed` or `remote` provider can be added without touching every call site. This is the cheap hedge
that keeps the app / hosted-DB direction from requiring a third rewrite of this code; it is not a licence
to build a remote provider now.

### Explicitly deferred: the app-owned and cloud databases

Stated so this plan does not pretend to deliver it. A hosted or app-owned board is **not a different path,
it is a different storage engine**, and the current one cannot be pointed at a network. `sql.js` holds the
whole database in memory, persists by writing the entire file behind a 300 ms trailing debounce, and
detects other writers only by comparing file mtime on read. That is single-writer by construction — which
is why a synced folder produces conflict copies rather than collaboration. A real shared board needs a
server-side store and a change protocol, and the honest sequencing is: land the location choice, then
decide whether the app ships an embedded engine (a bundled server-backed SQLite) or talks to a remote one.
The provider interface above is the seam for that work.

## Proposed changes

1. **`KanbanDatabase`** — resolution stays as it is (pointer → setting → default); `defaultDbPath` becomes
   the *fallback for an unanswered choice*, not the definition of where boards live. Add the resolved
   location and its provider to whatever `handleGetDbPath` (`TaskViewerProvider.ts:8295`) reports, so the
   Setup panel can show where the board actually is.
2. **First-run choice, extension host** — a Setup-panel step (the DB section already hosts `setLocalDb`,
   `setCustomDbPath`, `setPresetDbPath`, `resetDatabase` at `SetupPanelProvider.ts:971-990`, so this is a
   new option in an existing surface, not a new surface).
3. **First-run choice, standalone** — a `--db <path|here|machine>` flag on `init` and on start, plus the
   `SWITCHBOARD_KANBAN_DBPATH` env var that `StandaloneHostPathConfigProvider` already honours. Default
   taken silently and logged when non-interactive.
4. **One-shot migration for existing installs** — marker-gated in `.switchboard/`, runs when the user picks
   a new location, built on the repaired `migrateIfNeeded`. Copy before rename, source kept as
   `*.migrated.bak`, never unlinked. `target_has_data` routes to the existing reconciliation rather than
   guessing. Per house rule, assume the legacy state shipped and never assume a prior migration ran.
5. **Location provider seam** — the interface plus the `local-path` implementation. No remote provider.

## Verification plan

1. **Each option, end to end.** Fresh workspace × each of the three choices: assert the DB lands at the
   expected path, a `db-pointer` is written, and a restart resolves back to the same file.
2. **Existing install migrates.** Seed an in-repo DB with plans in several columns, non-default priority
   order, and worktree rows. Choose "this machine". Assert every one of those survives at the new path, and
   that the old file remains as `*.migrated.bak`.
3. **Two same-named repos.** Two directories both called `api` in different parents. Assert two distinct
   machine-global board directories and no cross-talk.
4. **Repo moved after the choice.** Rename the workspace directory. Assert the pointer still resolves and
   the board is intact (this is the case in-repo storage gets right and a naive global keying gets wrong).
5. **Non-interactive.** `--detach` and a cloud-style checkout: assert no prompt, the default taken, and one
   log line naming the location and the override flag.
6. **Never re-asked.** Second activation and second `init` in an answered workspace: assert no prompt and no
   config rewrite.
7. **Upgrade with no answer given.** An existing install that never sees the prompt keeps reading its
   in-repo database. No silent relocation on upgrade, ever.
8. **Standalone parity.** The same choice made over `npx` persists across a restart — the case the
   `kanban.dbPath` setting cannot serve.

## Dependencies

- **`db-relocation-silently-loses-the-board.md`** — hard prerequisite. `migrateIfNeeded` currently refuses
  every target outside the source workspace and the callers repoint anyway, so building a location choice
  on it today would hand users an empty board and call it success.

## Out of scope

- The hosted / app-owned database itself — see the deferral above.
- Changing what the DB stores, or making more of it rebuildable from the plan files. Worth doing; separate.
- The standalone mapping-index gap (the control-plane redirect is extension-only, so a child repo resolves
  its own DB under `npx` where the IDE would redirect to the parent). Adjacent, not this plan.

## Metadata
- **Tags:** database, ux, cli, infrastructure, reliability
- **Complexity:** 7
