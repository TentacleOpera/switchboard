# SUPERSEDED — replaced by a narrower plan, after one of its ideas was revived

> **Superseded (2026-08-27) by `board-state-remote-mirror-channels.md` and
> `storage-topology-one-choice-three-stores.md`.**
>
> **Reason.** This plan proposed moving the board snapshot off the
> `switchboard/board` orphan ref into a dedicated private repository, for access
> isolation. That placement was already decided, and the specific shape proposed
> here was already rejected:
>
> - `board-state-remote-mirror-channels.md` defines `boardStateExport:
>   none | control-plane | wiki | notion | linear`, where `control-plane` is
>   *"its own git repo with a remote; the mirror is pushed there instead of into
>   any managed project's repo"* — a separate repo with independent visibility.
>   Its **Rejected alternatives** section names *"per-project dedicated private
>   companion repo"* as superseded by extending the control plane, because the
>   control plane already aggregates sibling projects under one location. This
>   plan re-proposed the rejected option.
> - `storage-topology-one-choice-three-stores.md` exists to end the
>   proliferation of storage placements — it enumerates ten current answers to
>   "where does my data live" and argues storage must be a topology the product
>   owns rather than a setting a user types. A new placement mechanism is an
>   eleventh answer, which is what that plan is written to prevent.
> - `git-carried-shared-board-state.md` deliberately keeps the orphan ref and
>   makes it **multi-writer** via a compare-and-swap retry loop, because a
>   non-fast-forward rejection is a lost-write detector. This plan's
>   "one writer per repo" invariant and its "stop force-pushing, retry once"
>   handling contradict that design directly.
>
> **Replaced with:** `canonical-control-plane-layout-with-sibling-repos.md`.
>
> **Revived (2026-08-27, later the same day).** The user ruled that board state and
> instructions must **never** live in the control plane. That removes the ground
> mirror-channels rejected the dedicated-repo option on — and the reason is one
> that rejection did not consider: the control plane holds the `personas`,
> `workflows` and `skills` agents execute (`ControlPlaneMigrationService.ts:873`),
> so a command channel there lets anyone who can file an instruction rewrite the
> prompt the agent runs on. A closed action allowlist is worthless beside an open
> door.
>
> So a dedicated board repo comes back — but as a **destination value on the
> shipped `boardStateExport` setting**, activating the `remoteUrl` placeholder that
> already exists, not as a new mechanism. The parts of this plan that were wrong
> stay dead: the one-writer-per-repo invariant and the force-push removal both
> contradicted `git-carried-shared-board-state.md`, which owns the arbitration
> protocol.
>
> ---
>
> ### The one argument worth keeping, recorded here so it is not lost
>
> Those plans chose a separate repo to keep board churn out of developer git
> history. None of them states the *access* consequence, and one of them should:
>
> **Read access on a git repository is repo-wide, and that includes
> non-human readers.** `git-carried-shared-board-state.md`'s Security section
> says *"anyone with repo read access sees the board. That is the intended trust
> model — it is the team's existing boundary — but it must be stated."* The
> statement should also name what is easy to overlook: every CI job, GitHub App,
> and automation token with `contents: read` on that repository can read the
> board snapshot too. Those hold the same key as a collaborator and do not feel
> like people with access. Branch rulesets cannot narrow this, because they
> restrict *writes* to a ref pattern and read access has no ref granularity.
>
> This is a sentence to add to that plan's security statement, not a reason to
> change the placement. `wiki` already carries the equivalent caveat explicitly
> (GitHub wiki visibility always matches the parent repo's).
>
> A second finding from this line of thinking was material enough to move rather
> than merely record: mirror-channels §3's inbound trust guard uses the commit
> author email, which is self-asserted. That is now written up in
> `remote-dispatch-is-its-own-audited-seam.md`.

## Metadata

**Complexity:** 1
**Tags:** docs
