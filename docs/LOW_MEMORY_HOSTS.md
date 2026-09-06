# Low-Memory Host Guide & Resident Memory Budget (4 GB Hosts)

This document establishes the resident memory budget, operating constraints, and verification procedures for running Switchboard standalone host on memory-constrained devices (such as a Raspberry Pi 4 Model B with 4 GB RAM or a 4 GB cloud VM).

---

## 1. Resident Memory Budget

Following the storage overhaul from `sql.js` to `better-sqlite3`, which removed the 1.2 GB uncollectable WASM arena, the resident memory targets on low-memory Linux hosts are:

| State | Target Resident Memory (RSS) | Measured on 4 GB Raspberry Pi | Notes |
|---|---|---|---|
| **Steady-state Idle** | **< 350 MB** | **~214 MB** | Server running with active tailnet/loopback listeners, PTY fleet, and board watchers. |
| **Peak Load / Workload** | **< 500 MB** | **~240–320 MB** | Processing concurrent API requests, board sync, and CLI dispatches. |
| **Open File Descriptors** | **< 100** | **~53 FDs** | Normal operating descriptors across network sockets and database handles. |
| **Inotify Descriptors** | **< 8,192** | see note | Raspberry Pi OS ships `fs.inotify.max_user_watches=8192`. The host must fit inside that budget *unmodified* — the ceiling is the target, not something the operator raises. |

> **Inotify — measure before you claim.** A host measured on 2026-09-06 was still
> holding **17,218** watch descriptors, i.e. more than twice a Pi's entire budget,
> because the Antigravity brain watcher armed two unbounded recursive watches per
> IDE root. That watcher is now depth-bounded (one watch per plan root plus one
> per session directory, capped by `switchboard.planScanner.maxWatchesPerPreset`),
> and the `.switchboard` watch is narrowed to `plans/` + `features/`. The
> post-fix figure has NOT yet been re-measured against a rebuilt host — do that
> before quoting a number here.

> **Warning — Pre-Fix Baseline**:
> Prior to the 2026-09-05 storage overhaul, the host grew to **3,446 MB RSS** (growing ~100 MB/hr) due to the in-memory WASM arena and ~700 retained copies of the board in heap. On a 4 GB host, this triggered OOM kills within 24 hours.
>
> The 1.16 GB `external` half of that total is definitively gone with `sql.js`. The
> 1.19 GB `heapUsed` half — roughly 700 retained copies of the board, whose retainer
> was never identified — has **not** been shown to be gone by a heap snapshot. Until
> a snapshot confirms the ~700-copy pattern is absent, treat a low RSS as encouraging,
> not as proof the retention was fixed.

---

## 2. On-Demand Memory & Descriptor Probe

An on-demand, non-perturbing probe command is built into the Switchboard standalone CLI:

```bash
switchboard probe [--samples N] [--interval MS] [--csv <path>] [--json]
```

### Probe Output Format
The probe outputs CSV with the following columns:
```csv
timestamp,pid,rss,heapUsed,heapTotal,external,arrayBuffers,inotifyDescriptors,openFds
```

### Examples
1. Single instant reading:
   ```bash
   npx switchboard probe
   ```
2. Sample 10 times at 1-second intervals and save to CSV:
   ```bash
   npx switchboard probe --samples 10 --interval 1000 --csv memory-profile.csv
   ```
3. Read as JSON:
   ```bash
   npx switchboard probe --json
   ```

*Note: Executing the probe perturbates host RSS by less than 1 MB, well below the 5 MB ceiling.*

---

## 3. Recommended Raspberry Pi Configuration

When running Switchboard standalone on Raspberry Pi OS (64-bit) with 4 GB RAM:

1. **Node.js Memory Configuration**:
   The default V8 heap ceiling is sufficient for normal standalone operation (~200–350 MB RSS). However, heavy build tooling (such as Webpack bundle recompilation) requires swapping or an explicit memory flag:
   ```bash
   export NODE_OPTIONS="--max-old-space-size=2048"
   ```
2. **Swap Configuration**:
   Ensure at least 2 GB of swap is configured to prevent abrupt kernel OOM kills during occasional intensive operations:
   ```bash
   # /etc/dphys-swapfile
   CONF_SWAPSIZE=2048
   ```
3. **Inotify Watch Limits**:
   Do **not** raise `fs.inotify.max_user_watches` to make Switchboard fit. The
   budget above exists so the host runs inside the 8,192 watches Raspberry Pi OS
   already gives you; raising the limit hides a watcher that is growing without
   bound rather than fixing it. To check what the host is actually holding:
   ```bash
   switchboard probe            # inotifyDescriptors column
   cat /proc/sys/fs/inotify/max_user_watches
   ```
   If the probe's count approaches the limit, the plan scanner presets
   (`switchboard.planScanner.presets.*`) are the first thing to turn off, and
   `switchboard.planScanner.maxWatchesPerPreset` bounds what any one of them arms.
4. **Build Distribution**:
   Run pre-built artifacts (`dist/standalone/cli.js`) rather than re-running bundlers (Webpack) on the device.

---

## 4. Verification

Run the resident memory budget contract test:
```bash
npm run test:contract:resident-memory
```

It has two halves. The **static** half gates CI: it asserts the probe schema, the
narrowed watch roots, the depth-bounded brain watcher and the numbers on this page.
The **live** half — the actual RSS and descriptor ceilings — runs only when a built
`dist/standalone/cli.js` and a running host are present, and prints
`LIVE BUDGET CHECKS NOT RUN` when they are not. A green CI run is therefore evidence
that the enforcing code paths are intact, **not** that the budget currently holds;
the 24-hour hourly probe run remains a manual procedure:

```bash
switchboard probe --samples 24 --interval 3600000 --csv memory-24h.csv
```
