# Remove Timestamps from Kanban Plan Cards

## Goal

Remove the relative-time suffix (`just now`, `5m ago`, `3d ago`) from non-epic Kanban plan cards' meta line so the row reads only `Complexity: <category>`, freeing horizontal space on compact laptop displays and making the meta line consistent with epic cards (which already omit the timestamp).

### Problem
On smaller laptop screens, the timestamp ("just now", "5m ago", "3d ago") rendered on each Kanban plan card's meta line consumes horizontal space without adding meaningful value. The card meta line currently reads, for non-epic cards:

```
Complexity: <category> · <timeAgo>
```

The `· <timeAgo>` suffix crowds the meta row and competes with the complexity indicator for the limited width available on compact displays. Epic cards already omit the timestamp, so removing it from regular cards also makes the meta line consistent across card types.

### Root Cause
`createCardHtml()` in `src/webview/kanban.html` (line 5284) computes `timeAgo` via `formatTimeAgo(card.lastActivity)` and interpolates it into the non-epic branch of `cardMetaContent` (line 5344):

```js
const timeAgo = formatTimeAgo(card.lastActivity);
...
const cardMetaContent = card.isEpic
    ? `<span class="epic-subtask-label">EPIC: ${card.subtaskCount || 0} SUBTASK${(card.subtaskCount || 0) !== 1 ? 'S' : ''}</span> · Complexity: <span class="complexity-indicator ${complexityClass}">${category}</span>`
    : `Complexity: <span class="complexity-indicator ${complexityClass}">${category}</span> · ${timeAgo}`;
```

`formatTimeAgo` (line 5480) is referenced only by `createCardHtml` (verified: a search for `formatTimeAgo` in `src/webview/kanban.html` returns exactly 2 matches — the definition at line 5480 and the single call at line 5284), so once the timestamp is removed from the meta line the function and the `timeAgo` local become dead code.

Note: `card.lastActivity` is still used independently for card sorting (lines 5092–5120) — that usage is unaffected and must be preserved.

## Metadata
- **Tags:** ui, frontend, refactor
- **Complexity:** 2

## User Review Required
No. This is a pure cosmetic webview change with no data-model, persistence, or backend impact. No user-facing behavior beyond the removed timestamp changes. Proceed directly to implementation.

## Complexity Audit

### Routine
- Single-file change (`src/webview/kanban.html`).
- Delete one local variable assignment (`timeAgo`).
- Remove a `· ${timeAgo}` suffix from one template-literal branch.
- Delete the now-dead `formatTimeAgo` function plus its trailing blank lines.
- No data model, sorting, persistence, or backend interaction is touched.

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** None. `createCardHtml` is a pure render function invoked synchronously during column rendering; no concurrent state is read or written through `timeAgo`.
- **Security:** None. No user input, attributes, or HTML escaping are affected — only a static display string is shortened.
- **Side Effects:** Removing `formatTimeAgo` eliminates a minor existing glitch where an empty `lastActivity` produced a trailing ` · ` with nothing after it. No other side effects.
- **Dependencies & Conflicts:**
  - **Sorting dependency**: Cards are sorted by `card._ts` (derived from `card.lastActivity`) and `card.createdAt` directly (lines 5092–5120), not by the formatted `timeAgo` string. Removing the display does not affect ordering.
  - **Epic cards**: Already omit the timestamp; the change only normalizes non-epic cards to match.
  - **Completed cards**: Use the same `createCardHtml` path — they will also lose the timestamp, which is the intended consistent behavior.
  - **Dead code**: After removal, `formatTimeAgo` and the `timeAgo` local become unused. They should be removed to keep the file clean (verified: only 2 matches for `formatTimeAgo` and 2 for `timeAgo` in the file — definition/call and declaration/usage respectively).
  - **No migration needed**: This is a purely cosmetic webview change; no persisted state shape is altered.

## Dependencies
- None

## Adversarial Synthesis
Key risks: essentially none — this is a verified single-file display change. The only corrections from review are cosmetic to the plan itself: the `.card-meta` flex-layout explanation is misleading (the meta content is a single interpolated string with literal `·` separators, not separate flex children, so the row shortens because the *string* is shorter) and the dead-code cleanup should also remove the two trailing blank lines after `formatTimeAgo`. Mitigations: reframe the CSS note as plain string-shortening and include the blank lines in the deletion.

## Proposed Changes

### File: `src/webview/kanban.html`

**1. Remove the `timeAgo` local from `createCardHtml` (line 5284).**

Delete this line:
```js
const timeAgo = formatTimeAgo(card.lastActivity);
```

**2. Drop the `· ${timeAgo}` suffix from the non-epic meta branch (line 5344).**

Before:
```js
const cardMetaContent = card.isEpic
    ? `<span class="epic-subtask-label">EPIC: ${card.subtaskCount || 0} SUBTASK${(card.subtaskCount || 0) !== 1 ? 'S' : ''}</span> · Complexity: <span class="complexity-indicator ${complexityClass}">${category}</span>`
    : `Complexity: <span class="complexity-indicator ${complexityClass}">${category}</span> · ${timeAgo}`;
```

After:
```js
const cardMetaContent = card.isEpic
    ? `<span class="epic-subtask-label">EPIC: ${card.subtaskCount || 0} SUBTASK${(card.subtaskCount || 0) !== 1 ? 'S' : ''}</span> · Complexity: <span class="complexity-indicator ${complexityClass}">${category}</span>`
    : `Complexity: <span class="complexity-indicator ${complexityClass}">${category}</span>`;
```

**3. Remove the now-unused `formatTimeAgo` function and its trailing blank lines (lines 5480–5492).**

Delete:
```js
function formatTimeAgo(iso) {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
}
```

Also remove the two blank lines immediately following the function (lines 5491–5492) so no stray whitespace remains.

No CSS changes are required. Note: `.card-meta` does use `display: flex; gap: 4px;` (lines 945–947), but this is irrelevant to the change — `cardMetaContent` is a single interpolated HTML string with literal `·` text separators, not separate flex children. The meta row simply renders a shorter string; the flex layout is unaffected.

## Verification Plan

### Automated Tests
None required. This is a pure presentation change with no logic, data flow, or persistence impact. The project test suite (run separately by the user) is not affected.

### Manual Verification
1. Reload the Switchboard webview (reload the Kanban board) and confirm:
   - Non-epic plan cards show only `Complexity: <category>` in the meta row, with no trailing `· <time>` suffix.
   - Epic cards are unchanged (still show `EPIC: N SUBTASKS · Complexity: <category>`).
   - Completed cards likewise show no timestamp.
2. Confirm card ordering is unchanged — newest cards still appear first within each column (verifies the sort path that uses `card._ts`/`card.lastActivity` directly is intact).
3. Confirm no console errors reference a missing `formatTimeAgo` (a quick search of the file should show zero remaining references to `formatTimeAgo` or the `timeAgo` local).
4. Visually confirm the meta row no longer overflows or leaves a dangling ` · ` on cards whose `lastActivity` was previously empty.

---

**Recommendation:** Complexity 2 → **Send to Intern**.

---

## Reviewer Pass — 2026-06-30

### Stage 1 — Grumpy (adversarial findings)

- **NIT — `src/webview/kanban.html:5349`:** Non-epic branch correctly drops `· ${timeAgo}` suffix, retains `Complexity: ` prefix and colored `complexity-indicator` span. Matches plan "After" spec for the non-epic branch. No defect.
- **NIT — `src/webview/kanban.html:5348`:** Epic branch no longer matches this plan's "After" spec verbatim (the `Complexity: ` prefix is absent). Root cause: Plan 1 (Remove "Complexity:" Word from Epic Kanban Cards) was implemented in the same file and removed it. Plan 2's contract was "epic cards unchanged *by this plan*" — Plan 2 did not touch line 5348. Cross-plan interference is expected and correct. Flagged for traceability only.
- **NIT — dead-code cleanup:** `formatTimeAgo` — zero matches in all of `src/`. `timeAgo` local — zero matches in `kanban.html`. Function and local fully removed (not commented out, not deferred). Removal site (around line 5483) is clean — no stray blank lines, no orphaned comments. ✓
- **NIT — sort path preservation:** `card._ts` derived from `card.lastActivity` at line 5085–5086; sort comparator at line 5118–5119 uses `b._ts - a._ts`; `createdAt` tiebreaker at lines 5122–5124 intact; fingerprint at line 4492 still includes `card.lastActivity`. Sorting fully preserved. ✓
- **NIT — empty `lastActivity` glitch:** Removing `formatTimeAgo` eliminates the prior trailing ` · ` glitch on cards with empty `lastActivity`. Side benefit realized — no dangling separator possible.

No CRITICAL. No MAJOR.

### Stage 2 — Balanced synthesis

- **Keep as-is:** Non-epic branch edit at line 5349 — correct. Dead-code removal of `formatTimeAgo` and `timeAgo` — complete and clean. Sort path — intact.
- **Fix now:** None.
- **Defer:** None.
- **Cross-plan note:** The epic branch at line 5348 diverges from this plan's "After" spec (no `Complexity: ` prefix) because Plan 1 removed it. This is correct combined behavior, not a Plan 2 regression. Plan 2's contract was "epic cards unchanged *by this plan*" — Plan 2 did not touch the epic branch.

### Code fixes applied

None — implementation matches plan requirements.

### Verification results

- **Source inspection (line 5349, non-epic branch):** `· ${timeAgo}` suffix removed; `Complexity: ` prefix and `complexity-indicator` span retained. ✓
- **Dead-code check (`formatTimeAgo`):** Zero matches in `src/`. Function fully removed. ✓
- **Dead-code check (`timeAgo`):** Zero matches in `src/webview/kanban.html`. Local fully removed. ✓
- **Removal-site cleanliness:** Area around line 5483 (former `formatTimeAgo` location) — no stray blank lines, no orphaned comments. ✓
- **Sort path:** `card._ts` from `card.lastActivity` at line 5085–5086; sort at line 5119; `createdAt` tiebreaker at 5122–5124. ✓
- **Fingerprint:** `card.lastActivity` still in fingerprint at line 4492. ✓
- **Compilation/tests:** Skipped per session directive.

### Files changed

- `src/webview/kanban.html`:
  - Line 5349 (non-epic branch of `cardMetaContent` ternary): removed `· ${timeAgo}` suffix.
  - Removed `const timeAgo = formatTimeAgo(card.lastActivity);` local from `createCardHtml`.
  - Removed the now-dead `formatTimeAgo` function definition and its trailing blank lines.

### Remaining risks

- None material. The only divergence from the plan's "After" spec is the epic branch (missing `Complexity: ` prefix), which is explained by Plan 1's concurrent implementation and is correct combined behavior.
