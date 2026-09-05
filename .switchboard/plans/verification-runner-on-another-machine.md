# Superseded — verification on another machine needs no new mechanism

kanbanColumn: BACKLOG

## Goal

Record why this card was withdrawn, so the idea is not re-proposed. **Do not code this.**

## Why it was withdrawn

It proposed a `verify` job kind on the phone-a-friend path, with its own git transport and its own
verdict channel, so a coder on a Pi could hand verification to a runner on a workstation. Every
piece of that already exists by a shorter route.

1. **The coder-to-reviewer handoff is already the delegation.** A team commits once as its head,
   and the reviewer reviews that commit. A second delegation path alongside it is duplication.
2. **The role defaults already encode the split.** `KanbanProvider.ts:6734` sets
   `skipTests` to `true` for lead, coder and intern, and `false` for reviewer. Coders are already
   meant not to test and the reviewer is already meant to.
3. **Seat safeguards already reach lead-driven prompts.** `seat-safeguards-are-dropped-on-the-fleet-prompt-path`
   (`e53177b5`) and `seat-directive-block-is-delivered-once-not-on-every-message` (`14ff96eb`) both
   completed 2026-09-05. `buildSeatDirectiveBlock` carries skip-tests among its seat-scoped subset,
   and it is wired in **both** composition roots — `TaskViewerProvider._ptyHostVerb` and
   `standalone/bootstrap.ts`. Verified present in the running Pi bundle.
4. **Placing a reviewer on another machine is one existing card.** `An Agent Seat Can Run Its CLI on
   Another Machine, Over SSH` (`6f0dbeb9`) supplies the host field, the remote working directory and
   the loud failure on an unreachable host.
5. **Pushing at handoff is configuration, not code.** `buildGitPolicyBlock` already takes a `push`
   strategy alongside branch and commit, so a lead whose reviewer is remote sets `gitPushStrategy`.

## What survives, and where it lives

One idea from the withdrawn card is worth keeping and does **not** have a home: **a verification
whose result never arrived must never read as a pass.** A reviewer seat on an unreachable host, or
one that never reports, must produce a distinct reported state. Raise it against whichever card
implements remote reviewer placement — it is a property of that work, not of a separate mechanism.

## Metadata

- **Complexity:** 1
- **Tags:** superseded, no-code
