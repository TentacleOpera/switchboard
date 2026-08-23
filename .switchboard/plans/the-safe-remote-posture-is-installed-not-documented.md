# The safe remote posture is what gets installed, not what gets documented — and today the only force-push guard is a sentence in a prompt

## Goal

Make the recommended deployment shape for a self-hosted remote the *installed default*: a local push guard, a narrow-by-construction credential, and a verified "nothing but code" host. Then be honest about the one control only the operator can apply, and get them to it in one click instead of burying it in a README.

### Problem Analysis

**The current force-push guard is prompt text.** `agentPromptBuilder.ts:643` reads `pushWhenDone: 'After committing, push the working branch to its remote. Do not force-push.'`, and `TaskViewerProvider.ts:6271-6274` appends a `GIT POLICY:` line — *"stay on the current branch — do not switch or create branches, do not push to shared branches, and do not force-push."* That is the entire mechanism. It is a politely-worded request to a language model, and it is what currently stands between a dispatched agent and a rewritten shared history.

For a laptop the operator is watching, that is tolerable. For an unattended remote host dispatching agents while nobody is present — the capability `switchboard-as-a-local-app-and-a-self-hosted-remote.md` exists to add — it is not.

**Nothing checks the surrounding posture either.** There is no `api.github.com` client anywhere in `src/services`, so no branch-protection check, no credential-scope check, no report. The dedicated-host shape recorded in the app plan is entirely advisory: an operator who does it right and one who does not are indistinguishable to the product.

**But the codebase already has the right instinct.** `MultiRepoScaffoldingService.ts:149` refuses a repository URL with embedded credentials outright — `Repository URLs must not include embedded credentials`. That is credential hygiene as a hard rule rather than a recommendation, and it is the pattern to extend.

**And the cheap control is local, not on the forge.** A pre-push hook rejects force-pushes and protected-branch pushes before anything leaves the machine. It needs no token, no API client and no network, works identically against GitHub, GitLab and self-hosted remotes, and can be installed by `switchboard remote install` with no operator action. Compared with building a forge-specific posture checker, it is less code and covers more cases.

**The honest limit, which must not be glossed:** a pre-push hook is bypassable with `git push --no-verify`, and a write credential can force-push unless the *server* refuses. So the hook catches the ordinary and accidental cases — which is the realistic failure mode, an agent making a mess rather than an adversary — and **branch protection on the forge is the only actual guarantee**. The setup flow must say that plainly, because a hook that creates false confidence is worse than no hook: it converts "I know this is unprotected" into "I assumed it was handled".

### Root Cause

Every git safety rule in the product was written for a human-supervised local session, where the operator is the backstop and a prompt line is a reminder rather than a control. The unattended remote removes the operator from the loop without replacing what they were doing.

### Non-goals

- A GitHub API client or a forge-specific posture checker. The local hook covers more remotes for less code, and setting branch protection needs an admin-scoped token — a worse trade than asking the operator to click once.
- Wrapping or shimming `git` to strip `--force` / `--no-verify`. Fragile, breaks legitimate use, and defeated by calling the real binary.
- Removing the `GIT POLICY` prompt lines. They stay as hints; they stop being the guard.
- Preventing an operator who wants to force-push from doing so. The guard is for agents on unattended hosts, and it must be overridable deliberately.

## Metadata

**Complexity:** 4
**Tags:** security, devops, reliability, cli, infrastructure, docs

## User Review Required

Yes — three decisions.

1. **Hook installation mechanism.** Per-repo `.git/hooks/pre-push`, versus `core.hooksPath` set globally on the remote host. Recommendation: **`core.hooksPath` to a Switchboard-managed directory**, because it covers repositories cloned *later* without revisiting each one — which matters on a host whose whole job is cloning repos. Critical caveat: `core.hooksPath` **replaces** per-repo hooks, so it would silently break husky / lefthook / pre-commit setups. The managed hook must therefore chain to the repository's own `.git/hooks/pre-push` when one exists, and that chaining is the part to get right rather than the guard itself.
2. **Does the guard apply on the operator's own machine too, or only on remote hosts?** Recommendation: **remote hosts by default, offered locally.** Locally the operator is present and is the backstop; imposing it there is the kind of friction that gets the whole feature disabled.
3. **Credential shape.** Recommendation: **generate a per-repository deploy key** rather than prompting for a token. A deploy key is narrow by construction — it cannot accidentally be given more scope — whereas a fine-grained token is narrow only if configured correctly. Making the safe option the easy one beats documenting it.

## Complexity Audit

### Routine

- A `pre-push` hook script rejecting force refspecs (`+`, `--force`, `--force-with-lease` on a protected branch) and pushes to a protected branch list.
- `ssh-keygen` per repository during remote setup, printing the public key to paste.
- A host scan for stray secrets, run at setup and reported.
- Demoting the `GIT POLICY` prompt lines from guard to hint in their wording.

### Complex / Risky

- **Hook chaining is where this breaks other people's repos.** `core.hooksPath` is global and total: set it and every repository's own hooks stop running. Many projects rely on them. The managed hook must detect and invoke the repo's own `pre-push`, forward its arguments and stdin faithfully, and propagate its exit code — and getting stdin wrong is subtle, because `pre-push` receives its ref list on stdin, so a naive chain consumes it and the delegate sees nothing.
- **Protected-branch identification.** A branch-name list (`main`, `master`, `develop`, release patterns) is a heuristic. It should also treat *the remote's default branch* as protected, resolved from the remote rather than guessed — and fail closed when it cannot be resolved, since failing open on an unknown remote is precisely the case that matters.
- **False confidence is the main risk of shipping this.** `--no-verify` bypasses the hook entirely. The setup output must state that the hook is a seatbelt and branch protection is the guarantee, and the panel must not render a green tick that implies more than the hook delivers.
- **Deploy keys are per-repository, so a many-repo host accumulates keys.** That is the cost of narrowness. The setup flow should batch the generation and produce one list to work through, not one prompt per repo across an afternoon.
- **The secret scan will find true positives that are fine.** A `.env.example`, a test fixture key, a repo that legitimately needs a service token. It must report and let the operator accept, not block — a scan that cries wolf gets ignored, and this one only needs to be read once.

## Edge-Case & Dependency Audit

**Race conditions**
- Worktrees: Switchboard is worktree-heavy, and worktrees share the common git dir's hooks, so a `core.hooksPath` guard covers them. Worth an explicit test rather than an assumption, since it is the configuration this product produces most.
- A repo cloned while setup is mid-run should still receive the guard — another argument for `core.hooksPath` over per-repo installation.

**Security**
- The generated deploy key's private half lives on the remote. It is a write credential for one repository; `0600`, and named so it is identifiable in a later audit.
- The scan must not log the secrets it finds. Report paths and kinds, never values.
- Nothing here should imply Switchboard is protecting the operator from a compromised host. It narrows what an agent can casually destroy; it is not a containment boundary.

**Side effects**
- `MultiRepoScaffoldingService`'s embedded-credential refusal is the existing precedent and should be referenced so the two rules read as one policy.
- The app plan's `switchboard remote install` is where this runs; the Database panel is where posture is shown.
- Prompt wording changes touch `agentPromptBuilder.ts:643` and the `GIT POLICY` lines in `TaskViewerProvider.ts` — the same files other plans edit, so coordinate.

**Migration**
- New hosts get this at install. An existing self-hosted remote needs a retrofit path — a `switchboard remote harden` that installs the guard and runs the scan without reinstalling the service.
- `core.hooksPath` may already be set on the host by something else. Detect, report, and refuse to clobber rather than overwrite.

## Dependencies

- **Part of** `switchboard-as-a-local-app-and-a-self-hosted-remote.md`, whose install flow this extends and whose deployment-shape guidance this makes real.
- **Independent of** the storage programme entirely — it needs no store, no tier split, and could ship first.
- **Complements** `the-remote-command-vocabulary-is-closed.md`: that plan bounds what a remote surface can ask for, this bounds what a local agent can destroy once asked.

## Adversarial Synthesis

Key risks: `core.hooksPath` is global and total, so a careless install silently disables husky/lefthook/pre-commit across every repo on the host, and chaining must forward `pre-push`'s stdin ref list correctly or the delegate hook sees nothing; the hook is bypassable with `--no-verify`, so shipping it with a green tick manufactures false confidence worse than no guard; protected-branch detection by name is a heuristic that must fail closed when the remote's default branch cannot be resolved; and a noisy secret scan gets ignored on first read and never revisited. Mitigations: chain to the repo's own hook with faithful stdin and exit-code propagation, tested; state plainly that the hook is a seatbelt and branch protection is the guarantee, with no UI element implying otherwise; resolve the default branch from the remote and fail closed; and make the scan report-and-accept rather than block.

## Proposed Changes

1. **A managed `pre-push` guard** installed via `core.hooksPath` by `switchboard remote install`, rejecting force refspecs and protected-branch pushes, resolving the remote's default branch and failing closed when it cannot.
2. **Hook chaining** to each repository's own `pre-push`, forwarding arguments and stdin and propagating exit codes.
3. **Per-repository deploy-key generation** during setup, batched into one list to work through, private halves `0600` and identifiably named.
4. **A host secret scan** reporting paths and kinds — never values — with accept-and-continue rather than blocking.
5. **A one-screen posture summary** at the end of setup, separating what was installed from the one thing only the operator can do, with a direct link to branch protection for each repository.
6. **Demote the `GIT POLICY` prompt lines** to hints, with the hook named as the actual control so a future reader does not mistake the sentence for the mechanism.
7. **`switchboard remote harden`** to retrofit an existing host.
8. **Refuse to clobber** an existing `core.hooksPath`; detect and report instead.

### Migration

New hosts are configured at install. Existing hosts use the retrofit command. Nothing changes on an operator's own machine unless they opt in.

## Verification Plan

- **Force-push blocked:** from a repo on a configured host, attempt `git push --force` to a protected branch. Assert rejection. Attempt a normal push to a feature branch; assert success.
- **Default-branch resolution:** point at a remote whose default branch is not `main`. Assert it is treated as protected. Make the remote unresolvable; assert the guard fails closed.
- **Hook chaining:** install into a repo using husky. Assert the repo's own `pre-push` still runs, receives its ref list on stdin intact, and that a non-zero exit from it blocks the push.
- **Worktrees:** create a Switchboard worktree and push from inside it. Assert the guard applies — the configuration this product generates most.
- **Bypass is documented, not hidden:** assert `--no-verify` does bypass the hook, and that the setup output and panel say so rather than implying the branch is protected.
- **Deploy keys:** run setup across three repositories. Assert three keys, `0600`, identifiably named, and that pushing works with the deploy key alone and no other credential present.
- **Secret scan:** seed `.env`, `.env.example`, a private key and a test fixture. Assert all are reported by path and kind, that no value is logged, and that accepting proceeds.
- **Clobber refusal:** pre-set `core.hooksPath` to something else. Assert setup reports and refuses rather than overwriting.
- **Retrofit:** run `remote harden` on a host installed before this landed. Assert the guard and scan apply without reinstalling the service.
- **Prompt demotion:** grep-level assertion that the `GIT POLICY` lines no longer read as the sole mechanism, and that the hook is referenced as the control.

## Outstanding Questions

- Should the guard also refuse pushes to a branch the host did not create — a stronger rule than a protected-branch list, and closer to the intent of the existing prompt line ("do not push to shared branches")?
- Is a per-repo deploy key the right default for a host with many repositories, or does that tip into enough friction that operators reach for one broad token anyway — the outcome this is trying to avoid?
- Does the posture summary belong only at setup, or should the panel re-check periodically, given a repo added later has no guard until something notices?
