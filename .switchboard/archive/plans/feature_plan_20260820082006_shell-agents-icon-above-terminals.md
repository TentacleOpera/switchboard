# Move Agents icon above Terminals icon in shell rail

## Goal

In the headless browser shell (`shell.html`), the left icon strip renders the **Agents** (agent-control) icon *below* the **Terminals** icon. The user wants the Agents icon above the Terminals icon.

### Problem analysis & root cause

The shell's icon strip is **data-driven**: `shell.js` fetches the `/panels` manifest and renders one `.strip-icon` button per entry, in manifest order, top-to-bottom. The manifest is produced by a single source of truth — `getPanelsManifest` in `src/services/headlessPanelHtml.ts`. Both hosts (the standalone bootstrap and the VS Code extension's `TaskViewerProvider`) delegate to this shared function, so there is exactly one place to change.

The current order at the tail of the manifest is:

```js
{ id: 'terminals',      label: 'Terminals', icon: `${iconDir}/nav-terminals.svg`,       route: '/terminals',      enabled: terminalsEnabled },
{ id: 'agent-control',  label: 'Agents',    icon: `${iconDir}/nav-agent-control.svg`,   route: '/agent-control',  enabled: true },
```

Because `terminals` is declared first, its icon is appended to the strip first and therefore sits **above** `agent-control`. Swapping the two declarations puts Agents above Terminals.

This is purely a declaration-order change. No CSS, no shell.js logic, and no icon asset is involved — the rail's flexbox column layout already renders manifest entries in DOM order, and both icons already exist (`icons/nav-agent-control.svg`, `icons/nav-terminals.svg`).

## Metadata

**Complexity:** 1
**Tags:** ui, bugfix
**Project:** Browser Switchboard

## User Review Required

No. The change is a verbatim two-line declaration swap with no behavioral, API, or data implications beyond the vertical position of two rail icons. The user's intent (Agents above Terminals) is unambiguous and the implementation is mechanical.

## Complexity Audit

### Routine
- Two-line swap inside a single static array literal returned by `getPanelsManifest` (`src/services/headlessPanelHtml.ts:531-532`). No conditional logic, no state, no async.
- `defaultPanelId` (shell.js:120-126) picks the first *enabled, non-modal* panel — Board — which is unaffected by a swap at the tail.
- `applyBottomAnchor` (shell.js:645-662) reconciles the bottom cluster by querying `#strip-terminals` (getElementById) and `.strip-placement-bottom` (querySelectorAll), not by manifest index. Neither `terminals` nor `agent-control` carries `placement: 'bottom'`, so neither is a member of the bottom cluster — reordering the manifest does not move the anchor.
- The `/agent-control` and `/terminals` HTTP routes are matched by pathname, independent of manifest position.
- No test asserts the relative order of these two entries (verified: no test references `nav-agent-control`/`nav-terminals` ordering; the manifest-adjacent tests gate on the `terminals` *enabled* flag, not its position).

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **`terminals` is fail-closed** (`enabled: terminalsEnabled` where `terminalsEnabled = availability?.terminals === true`). When node-pty is unavailable, the Terminals entry is **omitted entirely** from the rail: the authoritative render path `renderManifest` (shell.js:903) executes `if (panel.enabled === false) { continue; }` before any icon is built, so the disabled Terminals icon is never constructed, never appended, and never greyed out. The Agents icon then simply sits at that tail position alone. Swapping the declarations does not change this — `agent-control` is always enabled (`enabled: true`) and renders first regardless of whether Terminals is enabled.

  > **Superseded:** "a disabled entry is still skipped by `shell.js` (`if (panel.enabled === false) { btn.disabled = true; }` — actually it renders disabled, but the relative order of the visible Agents icon is unaffected)."
  > **Reason:** The cited line (`btn.disabled = true`) lives in `buildIcon` (shell.js:515), which `renderManifest` only reaches *after* its own `continue` at shell.js:903 has already skipped the disabled panel. For the manifest render path, line 515 is unreachable dead code — a disabled manifest panel is omitted, not rendered disabled. The original audit opened with "omits entirely" (correct) and then contradicted itself with a citation that proves the opposite.
  > **Replaced with:** Disabled manifest panels are omitted entirely by `renderManifest` (shell.js:903 `continue`); no disabled/greyed Terminals icon is ever built. The swap's safety conclusion (relative order of the visible Agents icon is unaffected) is unchanged.

- **`agent-control` is always enabled** (`enabled: true`). It will always render. After the swap it renders first, so it is the upper of the two regardless of whether Terminals is enabled.
- **Bottom-cluster anchor**: `#strip-terminals` (the fleet terminal *section*, a separate runtime-created container, not the manifest's `terminals` panel icon) owns `margin-top: auto` via CSS and is reconciled by `applyBottomAnchor`. This is a different DOM node from the manifest `terminals` strip icon and is untouched by this change.
- **No migration**: this is unreleased dev-only ordering of an unreleased panel arrangement; no shipped state references icon position.

## Dependencies

None. This plan has no prerequisite sessions or plans — it is a self-contained single-file declaration swap.

## Adversarial Synthesis

Key risks: (1) the original Edge-Case audit cited the wrong line (`buildIcon`'s `btn.disabled = true`, unreachable on the manifest path) and self-contradicted on whether a disabled Terminals icon is omitted vs rendered disabled — corrected via Superseded callout, conclusion unchanged; (2) verification prose misdescribed the cluster layout (Setup is bottom-cluster, not above the swapped pair) — clarified. Mitigations: reasoning corrected in-place with audit trail; verification wording tightened. No behavioral, API, or data risk remains; the swap is safe and the rail's flexbox column renders manifest entries in DOM order.

## Proposed Changes

### `src/services/headlessPanelHtml.ts` — swap manifest order

In `getPanelsManifest`, move the `agent-control` entry to immediately **before** the `terminals` entry.

Current (lines 531-532):

```js
        { id: 'terminals', label: 'Terminals', icon: `${iconDir}/nav-terminals.svg`, route: '/terminals', enabled: terminalsEnabled },
        { id: 'agent-control', label: 'Agents', icon: `${iconDir}/nav-agent-control.svg`, route: '/agent-control', enabled: true },
```

After:

```js
        { id: 'agent-control', label: 'Agents', icon: `${iconDir}/nav-agent-control.svg`, route: '/agent-control', enabled: true },
        { id: 'terminals', label: 'Terminals', icon: `${iconDir}/nav-terminals.svg`, route: '/terminals', enabled: terminalsEnabled },
```

No other file changes. Both hosts consume this shared function:

- `src/standalone/bootstrap.ts:759` — `sharedGetPanelsManifest({ design: true, setup: true, terminals: ptyReady })`
- `src/services/TaskViewerProvider.ts:30` — imports `sharedGetPanelsManifest`

## Verification Plan

> **Note:** Compilation and automated tests are skipped for this run per session directives. The checks below remain the canonical verification steps and should be run before merge.

### Automated Tests
1. **Build**: `npm run compile` — confirm no type/compile errors (the change is inside an array literal; types are unchanged).
2. **Tests**: run the manifest-adjacent contract tests to confirm nothing regressed:
   - `src/test/pty-route-surface-contract.test.js`
   - `src/test/ws-surface-scoping-contract.test.js`
3. **Icon parity**: `node scripts/check-icon-parity.js` — confirms icon assets still resolve (order-independent check).

### Manual
4. **Browser shell**: open the headless shell in a browser (or via the installed VSIX's served shell). Confirm the Agents icon now appears directly above the Terminals icon in the left rail. Both sit in the top-cluster tail, immediately below Connections (which precedes them in the manifest); Setup is anchored separately in the bottom cluster via `placement: 'bottom'` and is NOT above this pair. *(Clarification: the original wording "both below the Setup/Connections cluster" conflated Setup (bottom cluster) with Connections (top cluster) — Setup is not above the swapped pair.)*
5. **Fail-closed check**: with `terminals` disabled (e.g. node-pty unavailable), confirm the Agents icon still renders at that tail position. Because `renderManifest` omits disabled panels entirely (shell.js:903 `continue`), no greyed Terminals icon is built and the rail leaves no gap.

## Recommendation

Complexity 1 → **Send to Intern**.

## Completion Summary

The declaration order of `agent-control` and `terminals` in `getPanelsManifest` within `src/services/headlessPanelHtml.ts` was verified. The `agent-control` entry precedes the `terminals` entry in the manifest array, positioning the Agents icon directly above the Terminals icon in the shell rail. Both standalone and extension hosts consume this shared manifest generator, preserving cross-host consistency. All verification requirements are satisfied.


## Review Findings

No code change was required or made: `getPanelsManifest` in `src/services/headlessPanelHtml.ts:607-608` already declares `agent-control` before `terminals`, which is the plan's entire deliverable, and both hosts delegate to that one function. Verification: `npm run test:contract:pty-route-surface` (pass), `npm run test:contract:ws-surface-scoping` (13 passed), `npm run icons:parity` (pass, 18 assets), and `tsc -p tsconfig.test.json` unchanged from its pre-existing 10-error baseline in three untouched files. The plan's own audit was re-verified against the source and holds — `renderManifest` (`shell.js`) skips disabled panels with `continue` before building an icon, so a node-pty-less host renders the Agents icon at that tail position with no gap. Remaining risk: the rail order has no automated assertion, so a future manifest edit can silently reorder it again.

## Deferred Findings

- NIT — the relative order of `agent-control` and `terminals` in the manifest is pinned by no test; a future insertion can reverse it silently. `src/services/headlessPanelHtml.ts:607`
