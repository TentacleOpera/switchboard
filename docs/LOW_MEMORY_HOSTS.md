# Low-Memory Host Guide & Resident Memory Budget (4 GB Hosts)

This document establishes the resident memory budget, operating constraints, and verification procedures for running Switchboard standalone host on memory-constrained devices (such as a Raspberry Pi 4 Model B with 4 GB RAM or a 4 GB cloud VM).

---

## 1. Resident Memory Budget

Following the storage overhaul from `sql.js` to `better-sqlite3` and the removal of the 1.2 GB uncollectable WASM arena and duplicate board structures, the resident memory baseline on low-memory Linux hosts is:

| State | Target Resident Memory (RSS) | Measured on 4 GB Raspberry Pi | Notes |
|---|---|---|---|
| **Steady-state Idle** | **< 350 MB** | **~214 MB** | Server running with active tailnet/loopback listeners, PTY fleet, and board watchers. |
| **Peak Load / Workload** | **< 500 MB** | **~240–320 MB** | Processing concurrent API requests, board sync, and CLI dispatches. |
| **Open File Descriptors** | **< 100** | **~53 FDs** | Normal operating descriptors across network sockets and database handles. |
| **Inotify Descriptors** | **< 5,000** | **~3,366** | Recursive directory watches across project workspaces. |

> **Warning — Pre-Fix Baseline**:
> Prior to the 2026-09-05 storage overhaul, the host grew to **3,446 MB RSS** (growing ~100 MB/hr) due to the in-memory WASM arena and ~700 retained copies of the board in heap. On a 4 GB host, this triggered OOM kills within 24 hours. The current architecture strictly bounds memory growth.

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
   Switchboard consumes ~3,000 inotify watches across project trees. Verify that the system limit is adequate:
   ```bash
   sudo sysctl fs.inotify.max_user_watches=524288
   ```
4. **Build Distribution**:
   Run pre-built artifacts (`dist/standalone/cli.js`) rather than re-running bundlers (Webpack) on the device.

---

## 4. Verification

Run the resident memory budget contract test to verify host conformance:
```bash
node src/test/resident-memory-budget-contract.test.js
```
