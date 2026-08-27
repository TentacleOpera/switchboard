# SUPERSEDED — the transport already exists; only the payload was missing

> **Superseded (2026-08-27) by `board-state-remote-mirror-channels.md` §3 and
> absorbed into `board-control-instruction-format-and-executor.md`.**
>
> **Reason.** This plan proposed a new `BoardControlWatcher`: poll a remote with
> `ls-remote`, compare against a stored cursor, fetch on change, read files,
> hand them to an executor. `board-state-remote-mirror-channels.md` §3 already
> specifies that mechanism, in more detail and better integrated:
>
> - a `GitStateProvider` implementing the existing pull-only `RemoteProvider`
>   seam, so it rides `RemoteControlService`'s existing 60 s (30–120 s
>   configurable) poll loop rather than standing up a parallel timer;
> - inbound deltas read via `git fetch` + `git log <lastSeenSha>..<remoteHead>`;
> - a cursor holding the **last-processed commit SHA** in the same DB config
>   table the Linear/Notion cursors use — and it notes that a SHA needs no
>   de-dup cache, unlike Notion's timestamp cursor;
> - an outbound push cycle that fetches and reconciles first, so an inbound edit
>   never causes a rejected non-fast-forward push;
> - an inbound trust guard on every delta before anything is dispatched.
>
> Building a second poller beside that one would be the divergence this codebase
> has a rule about: two mechanisms reading one remote, drifting.
>
> **Replaced with:** an extension of `GitStateProvider` to also read
> `instructions/`, specified in
> `board-control-instruction-format-and-executor.md`. What this plan contributed
> and that plan now carries: the instruction payload, replay suppression keyed to
> an instruction id rather than a commit SHA (a force-push changes the SHA while
> re-presenting the same instruction), receipts, and the rule that an applied
> action is never rolled back because its receipt could not be published.
>
> Two design points from this plan that survive and are worth stating where they
> now live:
>
> - **`ls-remote` before fetch.** `git ls-remote <remote> <ref>` returns the
>   remote SHA in one round trip and transfers no objects, so the common
>   "nothing changed" case costs almost nothing. Worth adding to
>   `GitStateProvider`'s poll regardless of instructions.
> - **The working tree is never involved.** `BoardSnapshotPublisher` already
>   solved this with a temp worktree removed in a `finally`
>   (`BoardSnapshotPublisher.ts:389-403`); whatever reads instructions must hold
>   the same line.

## Metadata

**Complexity:** 1
**Tags:** docs
