# Scaffolding Installs a CLI Dependency It Never Checks

## Goal

`setup scaffold` writes agent skills that shell out to the `switchboard` CLI, without checking that
a CLI is reachable or saying how to get one. A user who tried the product with `npx` has no binary
on PATH — npx fetches, runs and discards — so scaffolding hands them a workspace whose agents cannot
work, and nothing tells them why. The CLI dependency stays; what must change is that scaffolding
verifies the dependency it creates.

### Problem analysis

**The skills genuinely require the CLI, and that is intended.** At least five scaffolded skills shell
out to a bare `switchboard` — `kanban_operations`, `manage-features`, `improve-feature`,
`external-team-lead`, `worktree-cleanup` — and the operator has confirmed (2026-09-15) that this
dependency is deliberate and is **not** to be removed. Agents driving the board through one
documented command surface is the design.

**`npx` leaves nothing behind.** That is what npx is: fetch, execute, discard. It is a legitimate and
valuable trial mode — a user evaluates the board without installing anything — and it is the mode
`b4-npx-distribution-publish.md` exists to make work. But after that run there is no `switchboard`
on PATH.

**These two facts meet at scaffold time, and nothing mediates.** `setup init` / `setup scaffold` /
`setup control-plane` write workspace files only — `.switchboard/`, the `.agents/` skill tree via
`ControlPlaneMigrationService.bootstrapControlPlaneLayout` (`cli.ts:3903`), and the control-plane
rows. None of them touches PATH, and none checks whether a CLI exists. So an npx trial user who runs
`setup scaffold` receives a workspace full of skills calling a command they do not have and were
never told to install. The trial does not merely lack agent capability — it **installs the assumption
that the capability is present**.

**The failure is silent and misattributed.** A skill invoking a missing `switchboard` fails at the
shell, inside an agent's tool call. The user sees an agent that "doesn't work", not a missing
install. Nothing in the tree detects an npx run (`npm_config_user_agent` carries `npx/…` and is
never read), so nothing can say the one sentence that would resolve it.

**`setup host` has the same shape, one layer down.** It writes a systemd unit whose `ExecStart` is
hardcoded to `/usr/bin/switchboard` — the Debian package path
(`packaging/debian/switchboard.service:67`) — and it never verifies that file exists. It goes
further: on finding another `switchboard` on PATH it warns that the unit will use
`/usr/bin/switchboard` **regardless** (`cli.ts:2478-2486`). Run from an npx trial or an npm-global
install, `setup host` writes a unit pointing at a binary that is not there, and reports success.

**Three channels, no bridge.** `npx` (ephemeral, nothing on PATH), `npm -g` (bin on PATH), and the
`.deb` (`/usr/bin/switchboard`, which `setup host` assumes). Each is individually coherent. Nothing
tells a user which one they are on, or what the next step is to reach the one their next command
requires.

### Root cause

Scaffolding is modelled as a **file-writing** operation, so its contract stops at the files. But what
it writes is executable instructions with an external prerequisite, which makes it an
**install** operation whose prerequisite it never states or checks. The gap is not in npx and not in
the skills — each is correct alone. It is that the step which couples them asserts nothing.

## Metadata

**Feature:** b0f1f2cd-8591-4021-8b5f-51e5b6bcbb1f
**Tags:** cli, devops, ux, reliability
**Complexity:** 4
**Repo:** switchboard

## User Review Required

No. The operator settled the governing constraint on 2026-09-15: *"I don't want to remove the CLI
dependency."* This plan keeps it and makes it checked.

## Settled Design

- **The CLI dependency stays.** Skills keep shelling out to `switchboard`. No fallback path, no
  HTTP-only variant, no bundled shim — those would be a second control surface to keep in sync, and
  the operator has ruled the dependency in.
- **npx stays a first-class trial.** The fix must not require installing before evaluating; that is
  the point of the trial. An npx user may run the board and open it. What they may not do is receive
  scaffolded skills silently.
- **Scaffolding states its prerequisite and checks it.** Before writing a CLI-dependent skill tree,
  `setup scaffold`/`init` resolves `switchboard` on PATH. Found: proceed silently. Not found: still
  scaffold, but end with the install instruction for the channel the user is on.
- **Warn and proceed; do not refuse.** Scaffolding into a workspace ahead of installing is a
  legitimate order of operations, and a hard failure would break it. The defect is silence, not
  permissiveness — so the fix is a loud, specific closing message, not a gate.
- **Name the channel, not a generic instruction.** "Install the CLI" is not actionable. Detect the
  context — an npx run (`npm_config_user_agent` contains `npx`), a cloned repo, or neither — and
  print the one command that applies.
- **`setup host` verifies its own ExecStart target.** It must `stat` `/usr/bin/switchboard` before
  writing a unit that execs it, and fail loudly naming the missing file. A systemd unit that cannot
  start is worse than no unit: it reports success now and fails at boot, when nobody is watching.
- **This plan does not rename anything or touch publishing.** `b4-npx-distribution-publish.md`
  (same feature) owns the package name, the `files` allowlist, and the publish pipeline, and
  explicitly excludes the agent entry protocol. This plan is that exclusion.

## Complexity Audit

### Routine
- The PATH probe and the closing message.
- The `stat` check in `setup host`.

### Complex / Risky
- **Channel detection is heuristic.** `npm_config_user_agent` is set by npm, not guaranteed, and
  absent when the CLI is invoked directly. The detection must degrade to a generic-but-correct
  message rather than printing a confidently wrong command — a wrong install instruction is worse
  than a vague one.
- **The message is the deliverable.** Most of the risk is wording: it must survive being read by
  someone who does not yet know there are three channels.
- **`setup host` currently succeeds where it should fail.** Turning that into a hard failure changes
  behaviour for anyone scripting it, including the .deb `postinst`. Check
  `packaging/debian/postinst` before making the check fatal there.

## Edge-Case & Dependency Audit

- **Race conditions.** None.
- **Security.** Do not resolve a missing CLI by fetching one. On a machine without the binary, the
  bare name `switchboard` resolves on npm to an unrelated third-party package — so any
  auto-install path would execute a stranger's code. Instruct; never fetch.
- **Side effects.** More output on a scaffold that previously ended quietly.
- **Dependencies & conflicts.**
  - `b4-npx-distribution-publish.md` (same feature) — makes `npx <name>` fetch *this* tool. Its
    docblock states it does **not** cover the agent entry protocol; this plan is that piece. B4
    should land first so the install instruction can name a real package.
  - `a-first-run-setup-wizard-for-the-standalone-host.md` (feature `a107a9a7`) — the interactive
    first-run path. If it lands first, this check belongs inside its flow rather than as a separate
    closing message. Neither blocks the other; whichever lands second absorbs the other's surface.
  - `packaging/debian/postinst` — installs `/usr/bin/switchboard`. The `setup host` check must not
    fire spuriously during package install ordering.

## Adversarial Synthesis

**Risk summary.** Small change, and its whole value is in wording and detection accuracy. The real
risk is a confidently wrong install instruction: a user who runs what we print and gets a
third-party package is worse off than one who got no message. So detection must fail toward the
vague-and-correct. Second risk is scope drift into B4's rename work, which would entangle two plans
that are deliberately separate. Third is making `setup host` fatal without checking the .deb's own
install ordering, which would break the packaged path this is meant to protect.

## Proposed Changes

### Change A — scaffolding checks for the CLI it depends on

#### `src/standalone/cli.ts` — the `setup init` / `scaffold` / `control-plane` handlers (`cmdSetup`, `:2702`)
- **Context:** `bootstrapControlPlaneLayout` (`:3903`) writes the CLI-dependent skill tree.
- **Logic:** after scaffolding succeeds, resolve `switchboard` on PATH. If present, say nothing new.
  If absent, print a closing block naming (a) that the skills just written require the CLI, (b) the
  install command for the detected channel, and (c) that agents will fail until then.
- **Edge case:** the probe must find the *real* binary, not merely a name. Resolve via PATH lookup,
  not by shelling `switchboard --version`, which would be slow and could hang on a broken install.

#### Channel detection
- **Logic:** read `process.env.npm_config_user_agent`. Contains `npx` → this is a trial run; print
  the global-install command. Absent, but the process is running from a cloned repo → print the
  repo's own link/install step. Neither → print the generic install line naming the published
  package.
- **Edge case:** never print a command that would resolve a bare, unowned name from the registry.
  When the channel is unknown, name the package explicitly or say to install from the repo.

### Change B — `setup host` verifies its ExecStart target

#### `src/standalone/cli.ts` — `cmdSetupHost` (`:2351`, PATH check at `:2478-2486`)
- **Logic:** before writing the unit, `stat` `/usr/bin/switchboard`. Missing → fail with a message
  naming the exact path and that the unit would exec a file that does not exist. Keep the existing
  "another switchboard on PATH" warning; it is correct and complementary.
- **Edge case:** check `packaging/debian/postinst` first — if it runs `setup host` during package
  configuration, the binary may not be in place yet at that point in dpkg's ordering. If so, the
  check needs an explicit bypass flag for that caller, not a weakened check for everyone.

### Change C — the skills fail loudly on a missing CLI

- **Context:** the launcher skill was given this treatment on 2026-09-15 — it now checks
  `command -v switchboard` and refuses rather than falling back to `npx`.
- **Logic:** extend the same guard to the other CLI-dependent skills, so a missing binary reports
  itself once, plainly, instead of surfacing as an opaque shell error inside an agent's tool call.
- **Edge case:** the guard is one line per skill and must not turn into a per-skill install
  tutorial. It names the problem and points at `setup`; scaffolding owns the instruction.

## Verification Plan

### Automated Tests
1. **Scaffold without a CLI warns.** Run `setup scaffold` with a PATH containing no `switchboard`;
   assert it completes AND that its output names the missing CLI. Fails against today's code, which
   completes silently — this is the plan's headline regression.
2. **Scaffold with a CLI stays quiet.** The same run with the binary present emits no install
   message, so the warning cannot decay into boilerplate everyone learns to ignore.
3. **Channel detection.** With `npm_config_user_agent` set to an npx-style value, the message names
   the global install; with it unset, the message is the generic form. Assert the npx case never
   prints a bare unowned package name.
4. **`setup host` refuses a missing target.** With `/usr/bin/switchboard` absent, `setup host` exits
   non-zero and names that path; no unit file is written.
5. **Skill guards present.** Every skill under `.agents/skills/` that invokes `switchboard` also
   contains a `command -v switchboard` guard — count of invokers equals count of guarded files.

### Goal Invariants
1. `cmdSetup`'s scaffold path contains a PATH resolution of `switchboard` and a branch that emits an
   install instruction when it fails. *(Paired positive: the success branch emits nothing, asserted
   by test 2, so the check cannot be satisfied by printing the notice unconditionally.)*
2. `cli.ts` reads `npm_config_user_agent` in at least one place.
3. `cmdSetupHost` stats `/usr/bin/switchboard` before writing the unit file, and returns non-zero
   when it is absent.
4. No scaffolding or setup code path invokes `npx`, `npm install`, or any fetch to resolve a missing
   CLI.
5. Every `.agents/skills/` file invoking `switchboard` carries a presence guard.
