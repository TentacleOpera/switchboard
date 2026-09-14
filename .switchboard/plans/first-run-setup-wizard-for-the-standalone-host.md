# A First-Run Setup Wizard for the Standalone Host

## Goal

`npx switchboard` on a fresh machine writes a 0-byte `kanban.db` into the repo, runs 64 schema migrations against it, and hands back a board the user may not want in a location they were never asked about. If they already have a database — a copy from another machine, a global store, a sibling repo — it is ignored, and the first thing they do is delete what the tool just spent a minute building.

Give the standalone host a first-run flow split at the natural seam: **the database question in the terminal, everything else in the browser.** The location of the database is the precondition for the server, so the terminal asks it; scaffolding, CLIs, roles and teams all have working panel UI already, so the panel asks those. Standalone is increasingly the **first** contact with Switchboard, before the VS Code extension, so first run has to stand on its own; it does not have to do so in a second UI idiom.

### Problem Analysis (re-verified against HEAD ead33f59)

**The first-boot path creates unconditionally and asks nothing.**

> **Superseded:** `src/standalone/bootstrap.ts:467-478` writes a zero-byte `kanban.db` via `writeFileSync(dbPath, Buffer.alloc(0))` then calls `ensureReady()`.
> **Reason:** The zero-byte pre-touch was dropped. The start path at `bootstrap.ts:838-850` now calls `await db.createIfMissing()` directly. But the core defect is unchanged: `createIfMissing` still fires unconditionally with no probe. The start path still creates a database before asking whether one should exist.
> **Replaced with:** `bootstrap.ts:838-850` resolves the DB, mkdir's the parent, and calls `await db.createIfMissing()`. The migration chain runs on the empty file `createIfMissing` creates. The wait the user experiences is still spent on an artifact they may be about to delete. The probe-before-create fix is still needed — it gates the `createIfMissing` call, not the old `writeFileSync`.

`forWorkspace` resolves a *configured* location (`customDbPath` → `kanban.dbPath` → mappings / `db-pointer` → `<root>/.switchboard/kanban.db`). It never looks for an **unconfigured existing** database, and nothing defers the build until the location is settled.

> **Note:** `db-pointer` has been retired by the storage consolidation programme. The resolution chain is now shorter — `customDbPath` → `kanban.dbPath` → `<root>/.switchboard/kanban.db` (or the global store). The `db-pointer` probe tier in the wizard should be kept as one independently removable branch (per the existing risk note) but may already be a no-op.

**There IS interactive prompting in the CLI.**

> **Superseded:** There is no interactive prompting anywhere in the CLI. No `readline`, no prompt library, no TTY handling. The wizard is net-new, not an extension of an existing flow.
> **Reason:** `openPrompter()` at `cli.ts:875` creates a readline interface and provides an `ask` method. It is used in 10+ places: `cmdSetup` (:2742), the top-level menu (:2827), `cmdSetupHost` (:2359), and more. `cmdSetup` at `:2702` is a full interactive TTY menu (init/scaffold/control-plane/secrets). `process.stdin.isTTY` is checked at :2726.
> **Replaced with:** The wizard should use the existing `openPrompter()` rather than introducing `node:readline/promises` as net-new. The wizard is an extension of the existing `cmdSetup` interactive flow, not a greenfield prompt. The TTY-detection pattern (`process.stdin.isTTY` check, non-TTY exit with instructions) already exists at `:2726` and should be reused.

**Three of the five questions need data that does not exist in a form the CLI can reach.** This is the real scope of the work, and it is not the prompting:

| Question | Substrate today | Gap |
|---|---|---|
| Where does the DB live? | `kanban.dbPath`, `controlPlaneRoot`, mappings, `db-pointer` — all exist | Presentation only |
| Where does `.switchboard/` scaffolding live? | `controlPlaneRoot` stores it, but nothing *probes* for it. `detectCandidateParent` answers a different question and returns nothing below two git repos. | Needs an artifact probe (`.switchboard/`, `.agents/`, `.claude/`) at repo root and external root, with "none yet" as a real answer. |
| Which CLIs do you use? | `CLI_BRAND_ICON_KEYS` in `src/webview/terminals.js` — 19 entries (claude, antigravity, devin, jules, gemini, codex, cursor, copilot, windsurf, qwen, amp, cline, kiro, kilo, trae, opencode, zed…) | It is a **brand-icon map in a webview**, not a registry. The CLI cannot import it. |
| …and seat roles from them | `config.agents.startupCommands` — live, role-keyed, values are the CLI binary plus flags (`"lead":"claude"`, `"coder":"agy"`, `"analyst":"qwen"`). `agents.visibleAgents` is its visibility twin. | No **seed** table, but the seed is near-identity over the registry keys. Small, not a product decision. |
| …and the three teams | `SHIPPED_TEAM_TYPES` in `src/webview/kanban.html:5014` — Batch planners / Coding / Review, with head roles and member shapes | Lives in a **self-contained webview**. The CLI cannot import it, and duplicating it guarantees drift. |

So the last question is blocked on two extractions — and only because a *terminal* consumer cannot import a webview. A browser consumer already can.

### Root Cause

Standalone was built as a second front door onto a product whose configuration surface is the extension's panels. Every default that a panel collects interactively — team shape, agent roster, startup commands — was stored where the panel could reach it, which is a webview file or a role-keyed config the panel writes. Nothing needed a headless path to those defaults, because nothing headless ever set them up.

### Non-goals

- **Replacing the Setup panel.** The wizard covers first run; the panel remains the place to change any of it later. The wizard writes the same config keys the panel writes, never a parallel store.
- **A migration engine.** "Are you migrating?" routes to the transfer bundle (`hand-a-workspace-to-another-machine.md`), it does not reimplement import.
- **Consolidating databases.** The N-to-1 merge is `single-global-database-in-home-store.md`. This wizard *adopts* an existing DB; it never merges two.
- **Non-interactive regression.** Every question must have a flag equivalent, and a non-TTY invocation must behave exactly as it does today minus the unconditional create.
- **Installing any system state.** The flow configures — where the board lives, where scaffolding goes, which CLIs seat which roles. It never installs a service, a `launchd`/`systemd` unit, a login item, an autostart entry or an app bundle, and it never offers to. `npx switchboard` is the try-it path and must leave nothing behind but the files the user chose a location for. A launcher is a tier-3 artifact the operator downloads deliberately — see the distribution-tier note in `switchboard-as-a-local-app-and-a-self-hosted-remote.md`. First run is precisely where "…and install the app?" would feel natural and be wrong.

## Metadata

**Complexity:** 7
**Tags:** feature, backend, cli, onboarding

## User Review Required

None.

> **Amended — the earlier escalation was wrong, and so was the surface.** The first draft escalated "the CLI→startup-command table is new product data" to User Review and proposed a terminal wizard. Three corrections, all from evidence that was already in the tree:
>
> **1. The startup-command data exists and is nearly trivial.** `config.agents.startupCommands` is a live, role-keyed map, and its values are the CLI binary plus optional flags:
> ```json
> {"planner":"devin --permission-mode bypass","lead":"claude","coder":"agy",
>  "intern":"agy","reviewer":"devin --permission-mode bypass","analyst":"qwen"}
> ```
> So a CLI→command default is mostly the identity function over the registry keys — `claude`→`claude`, `qwen`→`qwen`, `agy`→`agy`, `codex`→`codex`. The only genuinely open part is per-CLI flags (`devin --permission-mode bypass`), and the safe default there is no flags with an editable field. What the first draft called missing product data was a seed table that writes itself from the registry. `agents.visibleAgents` is the matching role-visibility map and gets seeded the same way. No escalation warranted.
>
> **2. Control-plane detection is the wrong probe for scaffolding.** Question 4 leaned on `controlPlaneRoot` and, by implication, `ControlPlaneMigrationService.detectCandidateParent`. That detector answers a different question: it looks for a *parent directory holding two or more git repos* and suggests consolidating there (`extension.ts:4238-4270`, gated on `discoveredRepos.filter(r => r.hasGit).length < 2`). It returns nothing for a single-repo user, and it says nothing about where scaffolding currently is. Scaffolding may not exist yet, and when it does it may sit inside the repo or outside it. Question 4 must probe for the artifacts themselves — `.switchboard/`, `.agents/`, `.claude/` — at the repo root **and** at any configured external root, and treat "none found" as a first-class answer rather than a detector returning empty.
>
> **3. This should be a webview, not a terminal wizard.** Four of the five questions already have panel UI: `setup.html` ships tabs for **Database**, **Control Plane**, Multi-Repo, Plan Scanner, Remote and more, and the Agents tab already edits `startupCommands` and `visibleAgents`. Standalone serves those same panels in a browser via `headlessPanelHtml.ts`. A terminal wizard would reimplement four existing surfaces in a second idiom, and every future setting would have to be added twice. The extension's own onboarding is the shape to follow — detect a condition, offer once, remember the dismissal — not a scripted interrogation.
>
> The revised design is therefore **probe in the terminal, decide in the browser**, specified below. The terminal owns only what must happen before a page can render; everything else is the panel that already exists.

## Complexity Audit

### Routine

- The existing `openPrompter()` (`cli.ts:875`) for the single database prompt — already used in 10+ places throughout the CLI. No new dependency needed.
- Reading and writing config keys that already exist (`kanban.dbPath`, `controlPlaneRoot`, `startupCommands`, `visibleAgents`).
- Adding flag equivalents to `cli.ts`'s existing argv parsing.

### Complex / Risky

- **Extracting `SHIPPED_TEAM_TYPES` out of `kanban.html`.** It is a self-contained webview by design, and two contract tests (`team-scoped-role-routing.test.js:972`, `standing-orders-marker-contract.test.js:315`) read the constant *out of the HTML source text*. Moving it breaks both unless they are retargeted in the same change. The extraction must leave the webview consuming the shared module rather than keeping a copy — a copy is the drift this plan exists to avoid.
- **Extracting the CLI list out of `terminals.js`.** Same shape: a webview-local map that the CLI needs. The brand-icon mapping and the launch-command mapping are different concerns and should not be fused into one object just because both are keyed by CLI name.
- **The `startupCommands` wipe guard.** `GlobalIntegrationConfigService` explicitly refuses an empty or all-blank `startupCommands` write ("WIPE GUARD: never let an empty/all-blank startupCommands or visibleAgents…"). A wizard that writes partial selections must not trip it, and must not be *rescued* by it either — a guard silently discarding the wizard's write looks identical to success.
- **TTY detection.** `npx switchboard` runs in CI, in containers, and under process managers. Prompting where there is no TTY hangs a start that used to complete. The one prompt must gate on `process.stdin.isTTY` (the pattern already exists at `cli.ts:2726` in `cmdSetup`) and fall through to `--db`.

## Edge-Case & Dependency Audit

**The create-before-ask defect is independently shippable and should land first.** Steps 1–3 of the wizard are worth nothing if `bootstrap.ts` has already built the database by the time they run. Ordering inside first run: probe → ask → *then* create. This half fixes the reported symptom (a minute spent building a file the user deletes) even if the rest of the wizard is deferred.

**Adoption candidates, in probe order:** an explicit `--db <path>`; `SWITCHBOARD_STATE_HOME`-relative `~/.switchboard/kanban.db`; a parent-directory `db-pointer`; `<root>/.switchboard/kanban.db`.

> **The `db-pointer` tier is scheduled for deletion — make it skippable, not load-bearing.** `single-global-database-in-home-store.md` (PLAN REVIEWED) deletes `db-pointer`, `switchboardLocationGuard` and the `WorkspaceIdentityService` mapping subsystem outright: after consolidation there is one database and nothing to point at. Probe it while it exists, but keep it as one independent tier that can be removed by deleting its own branch — do not fold it into the `~/.switchboard` or `<root>` tiers, and do not let a later tier's correctness depend on it having run. The other three tiers survive that plan unchanged.
>
> **The panel half of this wizard targets a surface being retired.** `database-panel-in-the-shell-rail.md` (PLAN REVIEWED) deletes the Setup panel's "Database Operations" section and states it "retire[s] the three plans that propose redesigning it". This wizard does not redesign that section — its panel questions are scaffolding, CLIs, roles and teams, not storage — so it is not one of the three. But the two plans land in the same panel, so build the storage question in the **terminal** half only and never add a storage control to Setup. This plan's own risk note already sequences the terminal half first ("the create-before-ask fix is sequenced first and shippable alone"); treat that as the shipping order, not just a mitigation. **More than one candidate is a question, not a guess** — present them and let the user choose. Silently preferring one is how `a-configured-db-path-may-not-be-where-the-board-is.md` describes installs ending up with a configured path pointing at an empty file while the real board sits elsewhere.

**Adopting a foreign DB still runs migrations.** A database from an older install is behind head and `ensureReady()` will migrate it. That is correct and must be *said* — "adopting an existing database, upgrading its schema" — because the user has just been told the wizard avoids a long build and will otherwise read the same wait as the bug they reported.

**Never create in a non-TTY, non-flagged invocation.** Today `start` creates silently. After this, a non-TTY start with no candidate and no flag should **fail with instructions** rather than build. That is a deliberate behaviour change on a shipped path and belongs in release notes: a `start` that finds nothing and creates nothing is better than one that quickly creates the wrong thing.

**Migration/compat.** No schema change. Existing installs have a resolvable DB and never see the wizard — the trigger is "no database resolved **and** no candidate adopted **and** first run", not "version changed". Re-running the wizard must be an explicit `switchboard setup`, never automatic.

**Host parity.** The wizard is standalone-only by nature (there is no terminal in the extension host), but every key it writes is read by both hosts, so the extension must see the same result. Per the standing rule in `CLAUDE.md` / `AGENTS.md`, the shared modules extracted here (team presets, CLI registry) belong to both hosts, not to the CLI.

**Scaffolding question interacts with a Planned plan.** `control-plane-scaffold-out-of-the-repo.md` (PLAN REVIEWED) makes `.agents/` and `.claude/` a gitignored, regenerated projection rather than committed content. Question 4's "inside the repo or an external folder (recommended)" should present the recommendation that plan lands on, not invent a second policy. If that plan ships first, question 4 may reduce to confirming a default.

## Dependencies

- **`hand-a-workspace-to-another-machine.md`** — question 1 ("are you migrating?") routes into that bundle's import. Until it exists, question 1 should point at the manual copy steps rather than promise an import that is not built.
- **`control-plane-scaffold-out-of-the-repo.md` (PLAN REVIEWED)** — sets the recommended answer for question 4.
- **Collides with `standalone-start-path-db-creation-parity.md`** — both edit the first-boot block in `bootstrap.ts` (now at `:838-850`, was `:467-478`). That plan's step 1 (ship `createIfMissing` on the start path) has shipped; this plan's probe builds in front of that `createIfMissing` call. The convergence work (that plan's step 2) should land first so the wizard's probe gates a converged creation path.

## Adversarial Synthesis

Key risks. (1) Building the wizard while `bootstrap.ts` still creates unconditionally produces a wizard that asks where to put a database that already exists — the questions must gate the creation, not follow it. (2) Duplicating `SHIPPED_TEAM_TYPES` or the CLI list into the CLI instead of extracting them gives two sources that drift, and the contract tests that read them out of HTML source text will not notice. (3) Inventing launch commands for 19 CLIs seats roles that fail on first dispatch; an empty field is better than a wrong one. (4) Prompting without a TTY guard hangs `start` in CI. (5) The `startupCommands` wipe guard silently discarding a partial write looks exactly like success. Mitigations: the create-before-ask fix is sequenced first and shippable alone; extraction is specified as move-and-consume, with the two source-text tests named; the command table is escalated to User Review rather than guessed; TTY gating and flag equivalents are required for every question; the wipe-guard interaction gets its own assertion.

## Proposed Changes

### 1. Probe before create (independently shippable)

In `bootstrap.ts`, before the `await db.createIfMissing()` at `:850`, resolve candidates in the order above. One candidate → adopt and report it. Several → prompt (TTY) or list-and-exit (non-TTY). None → run the wizard (TTY) or exit with instructions (non-TTY). Creation moves *after* the answer.

### 2. Ask the bootstrap question in the terminal

The database location is the **one** question that must be answered before anything else can run, and it is the one question with no panel to duplicate — because the panel cannot render until it is answered. Ask it in the terminal.

> **Superseded:** a DB-less "setup mode" server, booting `LocalApiServer` with a null DB so the browser could collect the database location too.
>
> **Reason:** that was infrastructure invented to avoid a single `readline` prompt. Today the database is built at `bootstrap.ts:467` and the server at `:2910`; making the server boot without a database, serve a restricted route set, and then continue into normal boot without a restart is a substantial new piece — and its entire purpose would be to ask one question that a terminal can ask in three lines. The webview argument is a duplication argument, and it does not apply to a question whose answer is the precondition for the webview existing.
>
> **Replaced with:** one terminal prompt using the existing `openPrompter()` (`cli.ts:875`), gated on `process.stdin.isTTY` (pattern at `:2726`), with `--db <path>` as the flag equivalent. Once answered, boot proceeds exactly as it does today and the panel serves normally.
>
> **Keep the decision separable from the prompt.** The probe and the resolution belong in a function that returns a decision; `readline` is one caller, `--db` a second, and a launcher's first-run screen a third. `switchboard-as-a-local-app-and-a-self-hosted-remote.md` (New, complexity 9) makes "where the board lives" one axis of its mode picker — the same question this prompt asks, generalised to two machines — so a second caller is already foreseeable. Welding the logic into the prompt buys a rewrite later for nothing saved now.

Three outcomes from the probe:

- **one candidate** → adopt it, say which, no prompt;
- **several** → list them and ask which (or `--db`);
- **none** → ask: use an existing database (path), a transfer bundle, or create a new one — and if new, where.

**Outside the repo is the default, not a recommendation.** `~/.switchboard/kanban.db` is pre-selected and accepted by pressing enter. A named external path is the second option. **In-repo is last, and choosing it requires typing the choice, not accepting a default** — and the prompt states what it costs in one line rather than leaving the user to discover it.

The cost is not a matter of taste, and the withdrawn `db-location-chosen-at-install.md` had already assembled the evidence:

> `git clean -xdf` deletes the board. So does a fresh clone, so does deleting and re-cloning a repo, so does any ephemeral checkout — a cloud session, a CI job, a container. A read-only or mounted-in repo cannot host a writable board at all. Synced folders corrupt it.

That plan was withdrawn as superseded by the consolidation work, but the argument survives its withdrawal and nothing has shipped that answers it.

**And the backups do not rescue it, because they are in the repo too.** `writeDbBackup` derives its target from the *workspace root*, not from the database's own location (`KanbanDatabase.ts:7306`):

```ts
const backupDir = path.join(this._workspaceRoot, '.switchboard', 'dbbackup');
```

> **Line reference updated:** was `KanbanDatabase.ts:7306`, now `:9597` (re-verified against HEAD ead33f59).

So `git clean -xdf` takes the board and every snapshot of it in the same stroke. In this workspace that directory is **29 MB across 4 files** — four whole copies of a 7.3 MB database, sitting inside the repository, protecting nothing against the failure mode most likely to destroy the original.

Worse, it does not follow the database. A user who moves the DB to `~/.switchboard/kanban.db` still gets backups written into `<repo>/.switchboard/dbbackup/` — so the recommended choice silently keeps one foot in the repo. **Fix this alongside the default:** derive `backupDir` from `path.dirname(this.dbPath)`, so backups live wherever the database lives. Without it, "store it outside the repo" is only half true and the half that fails is the recovery half.

Non-TTY with no candidate and no `--db` exits with instructions and creates nothing.

That collapses the first three of the five questions into one exchange, because "are you migrating?", "do you have an existing database?" and "where should it live?" are the same decision asked three ways.

### 3. Everything else is the panel that already exists

Scaffolding location, CLI selection, role seating and the three teams all have working UI in `setup.html` and the Agents tab, and standalone already serves them. They are asked **after** boot, in a first-run panel mode shaped like the extension's onboarding (`extension.ts:4238-4270`): a condition, an offer, a remembered dismissal.

The terminal prints the URL once and does not ask about any of them.

### 4. The scaffolding probe (panel-side)

Driven by an **artifact probe** — `.switchboard/`, `.agents/`, `.claude/` at the repo root *and* at any configured external root. Report what was found and where; treat "none yet" as a first-class answer with a recommendation, not as a detector returning empty. Do **not** call `detectCandidateParent`: it is gated on two or more git repos and answers "should you consolidate a control plane", a different question with a different trigger.

### 4a. Backups follow the database

Change `writeDbBackup`'s `backupDir` from `<workspaceRoot>/.switchboard/dbbackup` to `<dirname(dbPath)>/dbbackup`. Existing in-repo backup directories are left alone — not migrated, not deleted — since they are recovery artifacts and deleting them is the opposite of the point. New snapshots land beside the database.

This is small, independently shippable, and it is the difference between the recommended location being genuinely outside the repo and being outside the repo except for its backups. `kanban-db-backup-retention-deletes-the-wrong-files.md` (CODE REVIEWED) owns retention *within* the directory and is unaffected by where the directory is.

### 4b. The seed table

`src/services/cliRegistry.ts` carries the 19 keys with an optional `startupCommand` defaulting to the key itself. Per-CLI flags are the only hand-authored part and default to none, with the field editable in the panel. Seeding writes through the same `GlobalIntegrationConfigService` path the panel uses — and must clear the wipe guard rather than be silently discarded by it, which looks identical to success.

### 5. `switchboard setup` — reconcile with the existing subcommand

`switchboard setup` already EXISTS at `cli.ts:3824` → `cmdSetup` (`:2702`), an interactive TTY menu routing to init/scaffold/control-plane/secrets. The wizard's first-run flow should be added as a new option in this existing menu (or as a new `setup firstrun` subcommand), not a replacement. The flow is reachable after first run without deleting anything — it is the dismissal's escape hatch. Do NOT create a second `setup` subcommand.

## Verification Plan

### Automated

1. `npm run compile-tests` — clean.
2. New: **probe-before-create.** Given a workspace with no DB and a candidate at `~/.switchboard/kanban.db`, assert the candidate is adopted and **no file is written** at `<root>/.switchboard/kanban.db`. Assert the absence — a test that only checks the board loads passes today.
3. New: **no-candidate, non-TTY start creates nothing.** With `isTTY` false, no candidate and no `--db`, assert a non-zero exit with instructions and **no database file written** anywhere. Assert the absence — a test that only checks the board loads passes today.
4. New: **flag equivalence.** `--db <path>` produces the same adoption and the same config write as answering the prompt, and suppresses the prompt entirely.
4b. New: **scaffolding probe.** Given `.agents/` at the repo root and nothing external, assert the probe reports repo-local; given neither, assert "none yet" rather than an empty result; assert `detectCandidateParent` is **not** on this path.
5. New: **wipe-guard interaction.** A partial CLI selection writes `startupCommands` successfully; assert the values are present afterward, not merely that the write was attempted.
6. New: **single source for presets.** Assert `kanban.html` no longer defines `SHIPPED_TEAM_TYPES` inline and that the extracted module is the only definition; same for the CLI list in `terminals.js`.
7. Retargeted: `test:contract:team-scoped-routing` and `test:contract:standing-orders-marker` pass against the extracted module.
8. `npm run test:contract:standalone-fork` and `npm run standalone-parity:check` — regression.

**Gate wiring:** the retargeted tests are already invoked by `.github/workflows/integration-tests.yml` (lines 228 and 177). Any new test file needs both a `package.json` script and a workflow step.

### Manual

9. Fresh machine, no `~/.switchboard`: run `npx switchboard`, answer the database prompt, then follow the printed URL and complete the panel. Confirm the board comes up with the chosen DB location, the chosen scaffold root, core roles seated with startup commands, and the three teams present.
10. Same, answering "migrating" at question 1 with a transfer bundle: confirm 3–5 are skipped and the imported settings are in effect.
11. With an existing `~/.switchboard/kanban.db`: confirm it is adopted, the adoption is reported, and no new file appears in the repo.
12. Two candidates present: confirm both are listed and neither is chosen silently.
13. `npx switchboard` piped (no TTY), no candidate, no `--db`: confirm it exits with instructions and creates nothing. With `--db`, confirm it boots unattended exactly as today.
14. Single-repo user (the case `detectCandidateParent` returns nothing for): confirm scaffolding is still probed and answered.

### Goal Invariants

- `createIfMissing()` is NOT called when a candidate DB is found and adopted (creation is gated by the probe, not unconditional).
- `createIfMissing()` is NOT called when no candidate exists and no TTY/`--db` is provided (non-TTY creates nothing).
- `createIfMissing()` IS called after the user answers the database prompt (creation happens after the answer, not before).
- `--db <path>` suppresses the prompt and produces the same adoption as answering it.
- `kanban.html` does NOT define `SHIPPED_TEAM_TYPES` inline after extraction (assert the constant is gone from the HTML source text).
- `terminals.js` does NOT define `CLI_BRAND_ICON_KEYS` inline after extraction.
- `backupDir` is derived from `path.dirname(this.dbPath)`, NOT from `this._workspaceRoot` (backups follow the database).
- `switchboard.setup` is a single subcommand (the existing `cmdSetup` menu, extended — not a duplicate).

## Recommendation

Send to Coder, and **ship change 1 on its own first**. Probe-before-create is a contained fix to the reported symptom and needs neither the setup-mode server nor the extractions. The rest is a first-run mode over panels that already exist, plus two extractions; nothing in it is new infrastructure.
