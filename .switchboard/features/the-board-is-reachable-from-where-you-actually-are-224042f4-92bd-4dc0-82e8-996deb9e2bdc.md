---
description: 'The Board Is Reachable From Where You Actually Are'
---

# The Board Is Reachable From Where You Actually Are

## Goal

The board is an appliance on a small box that is reached from other machines, and two paths assume otherwise: it teaches its own address as a bare IP, which is not a secure context and so disables the browser clipboard and every API that requires one; and HTML previews run on a second ephemeral server that no tunnel and no Remote-SSH forward can reach. Both are the same mistake — an address that works only from the machine the board runs on.

## How the Subtasks Achieve This

- **The Board Teaches Its Own Address as a Bare IP**: the board advertises `http://<ip>:7777`, which is not a secure context, so `navigator.clipboard` is undefined and every API gated on a secure context silently degrades. Fixing the advertised address restores that whole class of browser capability at once.
- **HTML previews run on a second ephemeral server that no tunnel and no Remote-SSH forward can reach**: previews bind a second, unpredictable port that no forward covers, so the feature works only from the machine the board runs on.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The Board Teaches Its Own Address as a Bare IP](../plans/the-board-teaches-its-own-address-as-a-bare-ip.md) — **PLAN REVIEWED** — ID: 1ca5db8f-84d0-407d-ab5c-b1fcc24390db
- [ ] [HTML previews run on a second ephemeral server that no tunnel and no Remote-SSH forward can reach](../plans/html-previews-run-on-a-second-server-no-tunnel-reaches.md) — **PLAN REVIEWED** — ID: 0e16770c-b865-46ff-a5b9-3bdb3630bf94
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; the two can be executed in parallel. Note that the bare-IP subtask removes the triggering condition for a separate, already-filed clipboard defect (`a-card-advances-on-a-copy-that-never-reached-the-clipboard.md`) — but does not fix it, since that plan's ordering and honesty defects are real on a secure origin too. Neither blocks the other.
