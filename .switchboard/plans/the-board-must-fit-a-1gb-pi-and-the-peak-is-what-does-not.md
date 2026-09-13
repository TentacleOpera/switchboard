# The Board Must Fit a 1 GB Pi, and It Is the Peak That Does Not

## Goal

The standalone host runs a real team on a 1 GB device. Not a measured idle baseline — a peak,
under load, with a gate that fails when it is exceeded.

### Measured, 2026-09-13, 31 samples over 10m02s, 9 live seats

The board was serving a coding team of four plus three planners and a reviewer while a browser
panel was open.

| | MB |
| :--- | ---: |
| RSS minimum | 488.5 |
| RSS **peak** | **749.0** |
| RSS last | 614.2 |
| heap used, minimum | 137.7 |
| heap used, **peak** | **351.6** |
| heap swing | **213.9** |

```
 +80s   rss 526.3   heap 137.7
+100s   rss 749.0   heap 351.6   ← burst
+120s   rss 628.9   heap 246.4   ← collected
…
+421s   rss 696.9   heap 266.0   ← second burst
+481s   rss 727.4   heap 306.3
+521s   rss 614.1   heap 167.9   ← collected
```

**Three things this says, and one it does not.**

1. **It is bursty, not a leak.** Two spikes, each collected. A leak climbs monotonically; this
   allocates ~214 MB, throws it away, and repeats. The swing is the size of a unit of work being
   built and discarded.
2. **The floor ratchets.** First-half mean 582.6 MB, second-half 640.1 MB, and RSS never returns
   to its 488 MB minimum after the first burst. V8 collected the objects; the allocator kept the
   pages. On a host with headroom that is invisible. On a 1 GB device every burst costs
   permanently.
3. **The peak is the blocker, not the baseline.** 488 MB survives on 1 GB. 749 MB does not, and
   that is before the OS, and with only nine seats.
4. **What it does NOT say:** how much of the 214 MB is live retention versus churn. RSS cannot
   distinguish them. `resident-memory-budget-for-low-memory-hosts` already established the method
   — a forced GC over the inspector, which split a 3,446 MB host into 2,807 MB live and 639 MB
   reclaimed. That measurement has to come first here, because it decides which of the changes
   below is the one that matters.

### Why the existing plans do not cover this

Four plans touch host memory and none of them targets this case:

- **`resident-memory-budget-for-low-memory-hosts`** (CODE REVIEWED) is the closest and has the
  right mechanism — a stated, enforced ceiling with a gate. Its number is **4 GB**. A ceiling an
  order of magnitude above the target does not constrain the target, and its baseline (a 22-hour
  host at 3,446 MB growing 100 MB/hour) is a different failure from a 214 MB burst on a
  three-hour host.
- **`The Board Renders Every Card It Has Ever Held`** (CODE REVIEWED) is about open-time latency.
  It helps here incidentally, not by design.
- **`The Board Ships 2.8 MB of Uncompressed JSON`** is about transfer cost to a remote device.
  Compression shrinks the wire, not the heap — the payload is built in full before it is gzipped,
  so it does not touch the burst at all.
- **`Terminal WebSockets Cross Every Link Uncompressed`** is the same shape for terminal output.

### The measured driver

579 cards, 43 fields each, of which **13,210 field-slots are null or empty** — 53% of every card
is shipped as an empty value and its key name. The content sums to ~170 KB; the payload is
892 KB. And 317 of the 579 sit parked in `PLAN REVIEWED` with 91 more in `CODE REVIEWED`, all
materialised on every build, none of them in play.

Multiply that by however many clients receive a full-state push and the 214 MB swing stops being
mysterious.

### Non-goals

- **Capping V8 with `--max-old-space-size`.** The heap genuinely needs ~352 MB at peak. A cap
  below that converts the burst into a crash at the cap and calls it a fix. The transient must
  shrink before any ceiling is lowered.
- **A 4 GB budget.** That target is the other plan's and is already met.
- **Optimising the idle baseline.** 488 MB idle is survivable; it is not what fails.

## Metadata

- **Complexity:** 6
- **Tags:** standalone, memory, performance, pi

## User Review Required

None.

## Proposed Changes

### 1. Split the 214 MB before changing anything

Run the forced-GC measurement from `resident-memory-budget-for-low-memory-hosts` at the peak of a
burst, not at rest: heap before, heap after, RSS after. That number decides everything else — if
most of it is reclaimed, this is churn and change 2 is the fix; if it is retained, there is an
owner to find and shrinking payloads only delays it.

Record it in this plan. A plan that optimises without this is guessing, which is how a 4 GB
budget got written for a host that needed to fit 1 GB.

### 2. Stop shipping empty fields

Omit null and empty values from the board payload. 13,210 empty slots across 579 cards, each
costing its key name as well as its value. An absent field and a null field already mean the same
thing to every reader, so this is a serializer change with no semantic consequence — and it
attacks the burst directly, because the burst *is* payloads being materialised.

### 3. Window the board read to what is in play

317 cards in `PLAN REVIEWED` and 91 in `CODE REVIEWED` are built into every full-state push. The
archive store exists and `GET /kanban/plan` already spans both tiers, so a card that ages out
stays reachable by id. Collection reads should return the working set; the rest belongs in the
archive.

### 4. A ceiling for THIS target, enforced

Adopt the budget plan's mechanism with a number that constrains the Pi: a stated peak-RSS ceiling
measured **under load with a team running**, not at idle, and a gate that fails when a run
exceeds it. An idle baseline is not evidence about a device that has to hold a team.

### 5. Find out what a burst is

The spikes were ~100 s and ~420 s in, which matches seat activity rather than any timer. Attribute
one: log the trigger and the client count at each full-state build. If it is per-connected-client,
the multiplier is the team size and everything above scales linearly with the thing the product
exists to do.

## Verification Plan

### Automated Tests

1. **New** `src/test/board-payload-size-contract.test.js`, wired as
   `test:contract:board-payload-size` **and invoked from
   `.github/workflows/integration-tests.yml`** — defined-but-not-invoked is not a gate. Asserts a
   synthetic 600-card board serialises with no null or empty-string fields, and that the payload
   stays under a stated byte budget per card.
2. Assert a collection read returns only the working set, and that a card excluded from it is
   still reachable by `GET /kanban/plan?planId=`.
3. A load harness that opens N clients against a seeded board and records peak RSS, failing above
   the ceiling from change 4. Without this the ceiling is a comment.

### Goal Invariants

- Peak RSS under a running team of four plus three planners stays inside the 1 GB budget with
  room for the OS — verified by the same sampling method that produced the 749 MB figure, not by
  an idle reading.
- The heap swing per full-state build is a stated number with a test that fails when it grows.
- A card parked in `PLAN REVIEWED` is not materialised by a full-state push, and is still
  retrievable by id.
- The forced-GC split is recorded in this plan, so the next person does not re-derive it.
