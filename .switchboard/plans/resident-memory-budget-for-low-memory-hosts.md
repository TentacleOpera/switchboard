# Establish a resident-memory budget for the standalone host, and find the retention that has no owner yet

## Goal

Give the standalone host a stated, measured, enforced resident-memory ceiling so that running
Switchboard on a 4 GB device is a verified claim rather than a hope — and close the one
retention measured during the 2026-09-05 investigation that still has no identified owner.

### The problem

Before 2026-09-05 nobody knew what the host cost. A 22-hour-old standalone process was measured
at **3,446 MB RSS**, growing ~100 MB/hour, and peaking at **4,736 MB** during its own shutdown.
On a 4 GB device that process is dead well before its first day is out, and there was no gate,
no log line, and no test that would have caught it at any point.

Two of the three contributors are now understood and have their own plans. The third does not.

### What was measured, and what is still unexplained

A forced GC over the inspector split the 3,446 MB cleanly:

| | before GC | after GC | reclaimed |
|---|---|---|---|
| rss | 3,446 MB | 2,807 MB | 639 MB |
| heapUsed | 1,285 MB | 1,191 MB | **94 MB** |
| external | 1,160.6 MB | 1,160.4 MB | **0.2 MB** |

- **`external`, 1.16 GB** — a single 1,202.85 MB `ArrayBuffer`: the `sql.js` WASM arena, which
  only ever grows and which GC cannot reach. **Already fixed** — the storage overhaul replaced
  `sql.js` with `better-sqlite3`, and the rebuilt host idles at ~340 MB.
- **`heapUsed`, 1.19 GB of live, reachable JS.** A 16.3M-node heap snapshot showed 818 MB of
  strings and 318 MB of plain objects, composed almost entirely of duplicated plan-row values:

  ```
  Object              1,965,001 instances   306.9 MB   ÷ 3,071 rows ≈ 640 copies
  "CODE REVIEWED"     1,503,468 instances    48.1 MB   ÷ 2,075 rows ≈ 724 copies
  "Browser Switchboard" 829,012 instances    33.2 MB   ÷ 1,192 rows ≈ 695 copies
  "PLAN REVIEWED"       194,132 instances     6.2 MB   ÷   278 rows ≈ 698 copies
  ```

  Four independent ratios converge on **~700 retained copies of the entire board**.

**The retainer was not identified.** The obvious candidate was excluded by measurement: only
**55** live `WebSocket` objects were in the heap, so the wsHub's per-connection push queues are
not holding these, despite 2,263 connection-reaping warnings in the last 3,000 log lines. The
remaining candidates — a cache keyed by something with ~700 entries, a debounce map, or an
accumulating history buffer — were not distinguished, because that requires retainer-path
analysis over the snapshot's edge table, which was not run.

This retention may have died with the old engine. It may not. On a 4 GB device the difference is
between a host that runs for months and one that dies daily, and right now nobody can say which.

## Proposed changes

1. **A repeatable probe.** A script that attaches to a running host and records
   `process.memoryUsage()`, the inotify descriptor count, and the open-fd count to a CSV. No new
   runtime dependency and no always-on instrumentation — it runs on demand.
2. **A stated baseline.** Run the probe hourly for 24 hours against a normally-used host and
   record steady-state RSS, growth per hour, and peak. Publish those numbers as the budget.
3. **Resolve the unexplained retention.** If the 24-hour run shows RSS climbing, take a heap
   snapshot and run retainer-path analysis over the edge table to name the object holding the
   board copies, then fix it. If RSS is flat, record that the retention was an artefact of the
   `sql.js` engine and close it with the evidence — not by assumption.
4. **A regression gate.** A test that boots a host against a synthetic board of ~3,000 plans,
   drives a fixed workload, and fails if RSS exceeds the published budget. This is the gate that
   did not exist while the host grew to 3.4 GB.
5. **Document the low-memory target.** State the supported floor (4 GB, and what must be turned
   off to hold it) where an operator will find it, rather than leaving it to be rediscovered.

**Both hosts.** The budget and the gate are stated for the standalone host, which is what runs on
a constrained device. The retention hunt is not host-specific: whatever holds ~700 board copies
is in shared service code and is therefore held in the extension host too, where a long-lived
window pays the same cost. Both composition roots are checked for which of the relevant seams
each wires.

## Metadata

**Complexity:** 5
**Tags:** backend, reliability, standalone, memory, testing

## User Review Required

None — the approach is fully specified.

## Verification Plan

1. The probe runs against a live host and produces a CSV with a row per sample; assert it does
   not perturb the host (RSS delta across a probe run under 5 MB).
2. A 24-hour hourly run completes and produces a steady-state figure, a growth-per-hour figure,
   and a peak figure. Assert growth-per-hour is under 5 MB.
3. If growth exceeds that, a heap snapshot plus retainer analysis names a specific holding
   object; the fix is verified by re-running item 2 to a flat result.
4. The regression gate fails when run against the pre-fix `sql.js` build (proving it detects the
   condition it exists to detect) and passes against the current build.
5. Assert the documented floor is reproducible: a host started with the low-memory settings
   applied holds under the published budget across the 24-hour run.
