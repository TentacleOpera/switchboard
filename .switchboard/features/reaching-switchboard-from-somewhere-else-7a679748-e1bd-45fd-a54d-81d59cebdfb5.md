# Reaching Switchboard From Somewhere Else

**Complexity:** 6

## Goal

Make Switchboard usable when the browser is not on the machine running it.

Four independent blockers. The board is unusable on a phone, and not because of styling - there is not one width breakpoint in any panel HTML file, every media rule being prefers-reduced-motion. The layout problem is already solved by the sidebar idiom; what is missing is a narrow tap-only route serving the five away-from-desk functions. Messaging a terminal is one-way: sending is solved and well-guarded, collecting the reply does not exist, and the mechanism that looks obvious - holding a request open until the agent answers - is precisely the one that cannot survive a mobile connection.

The server bind is hardcoded to loopback with no option threaded in, so a phone on the operator tailnet has nothing to connect to, while the docs promise a proxy recipe the project own reasoning argues against. And HTML previews are served by a second ephemeral http server standing up its own listener, so no SSH tunnel, no Remote-SSH forward and no proxy can reach them - a laptop-remote bug on the posture already recommended.

Together these make one capability: Switchboard reachable and operable from a device that is not the host.


## How the Subtasks Achieve This

- **A Phone-Shaped Command Route**: serves a narrow tap-only surface with the five away-from-desk functions, borrowing the sidebar idiom that already solved the layout. The board is unusable on a phone not because of styling but because there is not one width breakpoint in any panel file.
- **A Message To A Terminal Has No Return Path**: adds a collectable reply. Sending is solved and well-guarded; collecting does not exist, and the obvious mechanism — holding a request open until the agent answers — is exactly the one a mobile connection cannot sustain.
- **A Phone On The Tailnet Has Nothing To Connect To**: fixes the hardcoded loopback bind (the blocker is the bind, not the Host header) and replaces the docs' Tailscale proxy recipe, which the project's own reasoning argues against, with a verified path and an honest account of the trade.
- **HTML Previews Run On A Second Server No Tunnel Reaches**: serves previews from the board's own port on a distinct origin instead of a per-folder ephemeral server whose port is unknowable in advance and which no SSH tunnel or Remote-SSH forward can reach.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [A message sent to a terminal has no return path, so the one function a phone most needs is one-way](../plans/a-message-to-a-terminal-has-no-return-path.md) — **CREATED** — ID: 0c40da08-1029-4787-a053-52d7c41c544e
- [ ] [A phone on the tailnet has nothing to connect to, and the docs promise a recipe that should not ship](../plans/a-phone-on-the-tailnet-has-nothing-to-connect-to.md) — **CREATED** — ID: 82199376-6c73-4ec0-a070-e4965d0d7d8c
- [ ] [HTML previews run on a second ephemeral server that no tunnel and no Remote-SSH forward can reach](../plans/html-previews-run-on-a-second-server-no-tunnel-reaches.md) — **CREATED** — ID: 0e16770c-b865-46ff-a5b9-3bdb3630bf94
- [ ] [A phone-shaped command route, because the sidebar already solved the layout and the board never serves it](../plans/mobile-command-route-borrows-the-sidebar-idiom.md) — **CREATED** — ID: 6482f7c3-125d-40be-b341-38eeb57d9bb4
<!-- END SUBTASKS -->

## Dependencies & sequencing

The command route lands **first**. It is the referent for everything else: it ships four of its five functions without the return path and gains the fifth when that lands, and the tailnet plan is a **hard** dependant — without the route there is nothing on the other end worth reaching, and its exposure decision has no subject. The tailnet plan must not land first.

The command route is testable before either dependency, over an SSH tunnel from a laptop browser resized to 390px, or from a phone with an SSH client. So the sequence is: route, then answer-back and tailnet in either order.

The previews subtask is independent of the other three and can ship at any point — it is a laptop-remote bug affecting the SSH tunnel and Remote-SSH postures that are already recommended, not a phone feature. It should follow the host-aware panel-guard pattern established by `standalone-remote-access-story.md` rather than invent a second convention.

Two documentation couplings: both the tailnet and previews subtasks write to `docs/REMOTE_ACCESS.md`, as does `document-the-storage-and-deployment-model-as-it-ships.md` outside this feature. Sequence those edits. And the tailnet plan recommends the durable API token for any enrolled phone, which lands in the API-auth work — note it, do not duplicate it.
