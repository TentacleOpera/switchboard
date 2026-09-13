# Switchboard Runs Inside a 1 GB Pi

**Complexity:** 6

## Goal

The standalone host runs a real team on a 1 GB device within a stated 800 MB peak RSS budget, measured under load rather than at idle. Measured 2026-09-13 over 10 minutes with nine live seats: RSS 488 MB minimum, 749 MB peak, V8 heap swinging 138 to 352 MB. The peak is what does not fit, not the baseline, and the driver is that every board read returns all 579 cards with all 43 columns and every caller narrows afterwards in JavaScript. This feature closes the footprint work: what the two supported configurations actually are, and what the host must cost to hold a team on the smallest supported board.

## How the Subtasks Achieve This

- **Two Configurations: Board Only, and Board Plus Agents**: states what the product actually
  claims to run on. The 1 GB target is only meaningful for board-only — with seats local, the
  measured 2.2 GB of agent CLI processes dwarfs everything the host does. This subtask is what
  makes the budget in the other one a claim about a named configuration rather than a number
  without a subject.
- **The Board Must Fit a 1 GB Pi, and It Is the Peak That Does Not**: sets and enforces the
  800 MB peak-RSS budget, measured under load. It carries the measurement (RSS 488 min / 749
  peak, heap 138 → 352, a 214 MB swing collected twice in ten minutes), identifies the driver
  (`SELECT <43 columns> FROM plans WHERE workspace_id = ?` with no predicate, called from 16
  sites, each narrowing in JS afterwards), and makes the V8 old-space limit an explicit,
  measured setting rather than whatever Node derives from physical memory.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Two Configurations: Board Only, and Board Plus Agents](../plans/two-configurations-board-only-and-board-plus-agents.md) — **PLAN REVIEWED** — ID: c76ca59b-5ad5-4684-bbd8-0124e85aebde
- [ ] [The Board Must Fit a 1 GB Pi, and It Is the Peak That Does Not](../plans/the-board-must-fit-a-1gb-pi-and-the-peak-is-what-does-not.md) — **PLAN REVIEWED** — ID: 8b7e5490-ebb5-4782-8467-592cdd03c2c4
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Two Configurations** should land first: it decides which configuration the budget applies to,
and a ceiling written before that is a number with no subject.

Neither subtask should be coded before the forced-GC measurement in change 1 of the budget
subtask. RSS alone cannot separate live retention from allocator churn, and that answer decides
which optimisation is the one that matters — optimising first is how a 4 GB budget came to be
written for a host that needs to fit 1 GB.

### Related work deliberately NOT grouped here

Four plans touch the same footprint and are all past coding, so pulling them in would drag
finished work backwards:

| plan | column | why it is out |
| :--- | :--- | :--- |
| Establish a resident-memory budget for the standalone host | CODE REVIEWED | right mechanism, 4 GB target — this feature reuses its forced-GC method |
| The Board Renders Every Card It Has Ever Held | CODE REVIEWED | open-time latency; helps here incidentally |
| One Shell Load Builds the Board Fourteen Times | CODE REVIEWED | the allocation churn itself |
| The Terminals Panel Costs a Megabyte and a Half | LEAD CODED | client-side weight |

*Building and Gating on the Pi* (`b5d07e2b`) is a separate feature and stays separate: it is
about build time and the toolchain on the Pi, not about what the host costs while running.
