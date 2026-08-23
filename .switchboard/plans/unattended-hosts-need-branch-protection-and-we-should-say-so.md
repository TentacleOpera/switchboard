# An unattended host's push guard is advisory, and the honest fix is one sentence and a link — not reconfiguring the user's machine

## Goal

Tell an operator setting up an unattended remote the one thing that actually protects them, at the moment it matters, and stop there. No global git config, no generated credentials, no filesystem scanning.

> **This plan replaced a much larger one, and the rejection is the useful part.** An earlier draft proposed installing a managed `pre-push` hook via `core.hooksPath`, generating per-repository deploy keys, and scanning the host for stray secrets. That was rejected as too invasive, correctly:
> - `core.hooksPath` is a **machine-wide** git config change that silently overrides every repository's own hooks. An extension with ~4,000 installs writing that is over the line however carefully it chains.
> - Generating deploy keys puts Switchboard inside the operator's credential management.
> - Scanning the filesystem for secrets is snooping, and it would produce false positives that get ignored on first read and never revisited.
>
> There was also a cleaner argument against the whole approach: the hook was only ever a **weaker substitute for branch protection**. That draft conceded `--no-verify` defeats it and the forge is the only real guarantee — so the invasive machinery bought a seatbelt for a car that needs the airbag, and the airbag is entirely outside Switchboard's footprint. Do not re-propose the hook.

### Problem Analysis

**The force-push guard is prompt text, and that is fine on a supervised machine.** `agentPromptBuilder.ts:643` reads `pushWhenDone: 'After committing, push the working branch to its remote. Do not force-push.'`, and `TaskViewerProvider.ts:6271-6274` appends a `GIT POLICY:` line saying the same. It is a request to a language model. With the operator present and watching, that is a reasonable level of control — they are the backstop.

**The unattended remote removes the backstop without replacing it.** `switchboard-as-a-local-app-and-a-self-hosted-remote.md` adds a host that dispatches agents while nobody is present. The same advisory line is now the only thing between an agent and a rewritten shared history, and nobody is watching to notice.

**The dedicated-host mitigation is real but does not reach this.** A box holding only code has a small blast radius — worst local case is re-cloning. But it must hold a push credential to be useful, and force-push damage lands on the **shared remote**, where reimaging the host does not reach. That is the one gap the isolation argument does not close.

**And the fix is not Switchboard's to install.** Branch protection on the default branch refuses the push server-side. It cannot be bypassed with `--no-verify`, it covers every client and every agent regardless of what prompt it was given, and it is two clicks per repository. Switchboard cannot set it without an admin-scoped token — a worse trade than asking — and does not need to.

### Root Cause

Git safety in this product was written for supervised local sessions where a prompt line is a reminder. The remote host changes the supervision, not the guard. The instinct to compensate in code is what produced the invasive draft; the actual asymmetry is that the effective control lives on the forge, where the product has no business reaching.

### Non-goals

- Installing git hooks, setting `core.hooksPath`, or modifying any git configuration the operator did not ask for.
- Generating, storing or managing credentials on the operator's behalf.
- Scanning the host filesystem.
- Removing the `GIT POLICY` prompt lines. They are cheap, they are Switchboard's own behaviour, and an advisory line is worth having — it just should not be described as a guarantee.
- Blocking setup on anything. This is information, not a gate.

## Metadata

**Complexity:** 2
**Tags:** docs, security, devops, ux

## User Review Required

Yes — one decision.

**Where does the sentence appear?** Options: remote-setup output only; the Database panel's posture line; or both. Recommendation: **remote-setup output, once, plus a line in the docs.** Not the panel — a persistent warning about something Switchboard cannot verify becomes furniture, and an operator who has already enabled branch protection would see a nag they cannot dismiss truthfully.

## Complexity Audit

### Routine

- One paragraph in the remote-setup output naming branch protection, with a link.
- A short docs section on the unattended-host posture.
- A wording pass so the `GIT POLICY` lines are not read as enforcement by the next person to touch them — a code comment, not a behaviour change.

### Complex / Risky

- **Saying it once, in the right place.** Setup output scrolls past. It should be the last thing printed, after the service is running, when the operator is looking for what to do next.
- **Not overstating it either.** Branch protection protects the default branch. Agents push feature branches, which is the normal path and is deliberately unprotected. So the honest claim is narrow: it prevents an agent rewriting the branch everyone else depends on. Claiming it makes the host safe would be its own kind of false confidence.
- **Forge-neutral wording.** GitHub calls it branch protection or rulesets; GitLab calls it protected branches; self-hosted remotes may use `receive.denyNonFastForwards`. The text should name the concept and point at the operator's forge rather than assume GitHub.

## Edge-Case & Dependency Audit

**Security**
- This plan does not make the product safer by itself; it makes the operator able to. That distinction should survive into the wording — nothing here may imply Switchboard is protecting them.
- The advisory prompt line remains advisory. Worth a code comment so a future reader does not build on it as though it were enforcement, which is how the invasive draft started.

**Side effects**
- `switchboard-as-a-local-app-and-a-self-hosted-remote.md` carries the deployment-shape guidance this completes; its push-credential bullet should point here rather than at a hook.
- `MultiRepoScaffoldingService.ts:149` already refuses embedded credentials in repo URLs. That is a hard rule inside Switchboard's own footprint and a good model for the boundary: constrain what the product does, advise on what it does not control.

**Migration**
- Nothing to migrate. No configuration is written, read or changed.

## Dependencies

- **Belongs to** `switchboard-as-a-local-app-and-a-self-hosted-remote.md`; it is that plan's honest ending rather than a separate capability.
- **Independent** of the storage programme.

## Adversarial Synthesis

Key risks are all of overreach: an operator-facing warning that cannot be verified becomes furniture and is ignored; claiming branch protection makes an unattended host "safe" replaces one false confidence with another when it only protects the default branch; and assuming GitHub excludes GitLab and self-hosted operators. Mitigations: say it once at the end of setup rather than persistently in the panel; state the narrow true claim — it stops an agent rewriting the branch others depend on; and name the concept forge-neutrally.

## Proposed Changes

1. **One paragraph at the end of remote setup**, after the service is confirmed running: unattended agents push with the credential this host holds, Switchboard's own instruction not to force-push is advisory, and enabling protection on each repository's default branch is what actually prevents it. Link to the operator's forge.
2. **A docs section** on the unattended-host posture, stating what the dedicated-host shape does cover (local blast radius) and what it does not (damage to the shared remote).
3. **A code comment** at `agentPromptBuilder.ts:643` and the `GIT POLICY` lines recording that these are advisory, so the next reader does not mistake them for a control — and a pointer to why a hook was rejected.

### Migration

None. No configuration touched.

## Verification Plan

- **It appears once, last:** run remote setup; assert the paragraph is the final output after the service is confirmed running, and that it appears exactly once.
- **It is not a gate:** assert setup completes successfully without any acknowledgement.
- **Nothing is written:** assert setup modifies no git configuration at any scope, generates no keys, and reads no path outside its own directories — the regression test for the rejected draft.
- **The claim is narrow:** review-level check that the wording says protection prevents rewriting the default branch, and does not imply the host is safe or that Switchboard is protecting anything.
- **Forge-neutral:** assert the text names the concept and does not hardcode GitHub-only terminology.

## Outstanding Questions

- Is there a genuinely non-invasive way to *check* whether protection is enabled, so the message can be skipped when it is unnecessary? A read-only check needs a token Switchboard would otherwise not want, which is probably a worse trade than a message shown once.
- Should the same paragraph appear for a local install, or is it noise where the operator is present?
