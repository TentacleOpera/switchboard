# Replace shell.html terminal-strip status lights with coloured brand icons

## Goal

The browser cockpit's left rail (`shell.html` / `shell.js`) renders each fleet terminal as a 36px button containing a generic role-letter glyph (the first character of `t.role`, e.g. `C` / `O` / `R`) plus a tiny 7px status dot (`.strip-term-dot`) in the bottom-right corner. The user reports that these status lights "seem to not do anything at all" and should be replaced with the coloured brand icons that already identify each terminal in the Terminals panel sidebar.

### Problem analysis & root cause

The status dots are **decorative, non-interactive, and non-identifying** — three defects that together produce the "does nothing" perception:

1. **They do not identify the terminal.** The dot carries only state (`active` / `done` / `exited`), encoded as shape+colour (`shell.html:198-224`). A user glancing at the rail sees nine identical-looking buttons distinguished by a single letter and a 7px speck — there is no way to tell which agent CLI (Claude, Devin, Gemini, …) a button represents without reading the hover tooltip. The Terminals panel sidebar already solved this: `renderTerminalRow` (`terminals.js:1000-1050`) renders a coloured brand-icon `<img>` next to each row, resolved via `brandIconForCliLabel(agentLabel)` → `brandIconUri(key)` (`terminals.js:948-998`). The shell strip predates that branding work and was never updated to match.

2. **The shell has no access to the brand-icon data.** Two gaps prevent a naive port:
   - The `terminalFleetState` relay (`postFleetStateToShell`, `terminals.js:608-628`) sends only `{ name, role, worktreePath, light }` — no agent CLI label and no brand-icon key/URI. The shell cannot resolve a brand icon from `role` alone, because the role→CLI mapping (`agentNames`, populated by `fetchAgentNames` at `terminals.js:3317`) lives panel-side.
   - The shell HTML (`getShellHtml`, `headlessPanelHtml.ts:151-166`) does **not** inject the `data-brand-icon-*` body attributes that `brandIconUri` reads from. Only `getTerminalsHtml` (`headlessPanelHtml.ts:409-410`) injects them. So even if the relay carried a key, the shell would have no URI map to resolve it against.

3. **The dots are `pointer-events: none`** (`shell.html:208`) and carry no click handler — they are pure visual markup. The button's click opens the solo pop-out (`shell.js:343-398`), but the dot itself is inert. Combined with their tiny size and the fact that `active` (the steady state for a running terminal) is an unfilled ring that is easy to overlook, the dots read as dead pixels rather than live indicators.

The completion-lights feature (`shell-terminal-strip-completion-lights.md`) deliberately invested in shape+colour coding for accessibility. That investment is preserved in this plan — state is not discarded, it is re-encoded into the brand icon's presentation (dimmed for `exited`, glowing completion ring for `done`) so the information survives without a separate useless dot. The accessible name already spells out the light state (`shell.js:328`, tested at `shell-terminal-strip.test.js:271-283`), so screen-reader users lose nothing.

### Intended outcome

- Each terminal strip button shows the **coloured brand icon** for its agent CLI (Claude, Devin, Gemini, Cursor, …) as the primary 22px glyph, replacing the role-letter + status dot.
- State is still conveyed: `exited` terminals show a dimmed/desaturated icon; `done` terminals get a glowing completion ring around the button; `active` is the normal full-colour icon. No separate dot element.
- Terminals with no agent label (the `shell` role, or `No agent assigned`) fall back to the neutral default CLI icon (`brand-cli-default.svg`), so the button is never blank.
- The relay carries the resolved icon URI so the shell needs no brand-icon resolution logic of its own (no duplicated `brandIconForCliLabel` table, no shell-side `data-brand-icon-*` injection).

### Verified preconditions (checked against source during the improve pass)

These were confirmed, not assumed — they are the load-bearing facts the plan rests on:

- **The `light` value genuinely changes.** `exited` is reachable: `PtyFleetService.list()` (`src/standalone/ptyFleetService.ts:135-137`) returns *all* handles including exited ones — `onExit` sets `handle.status = 'exited'` (`ptyFleetService.ts:103-111`) and does **not** remove the handle from `this.terminals`. Both hosts surface that field (`bootstrap.ts:1123-1131`; `TaskViewerProvider.ts:428-432` forwards the same payload). `done` is set by `handleAgentCompleted` → `terminalBadges.set(name, 'DONE')` (`terminals.js:1675`) and re-relayed on the same tick. So the state channel is live; the defect really is presentation, not a dead pipe.
- **Every brand SVG is a light/saturated fill on transparent** — no black-on-transparent marks that would vanish on the `#060609` rail. Confirmed across all 18 assets (`icons/brand-*.svg`): the darkest are `zed #084CCF`, `jules #715CD7`, `qwen #6950EF`; the fallback `brand-cli-default.svg` is `#808080`. This is why an `<img>` (baked-in fill) is correct here and the strip's CSS-mask/`currentColor` path (`buildIcon`, `shell.js:151-155`) is not.
- **`/static/icons/` is served by BOTH hosts.** `staticRoutes.icons` is wired in the standalone bootstrap (`bootstrap.ts:546`) and in the extension host (`TaskViewerProvider.ts:2385-2387`), and `LocalApiServer` serves `/static/*` from those roots (`LocalApiServer.ts:849, 3697`). No 404 risk in either host.
- **`agentNames` is populated before every relay.** All six `postFleetStateToShell()` call sites (`terminals.js:551, 565, 773, 1597, 1675, 4805`) run after init; init awaits `fetchAgentNames()` before the first `fetchTerminalList()` (`terminals.js:594`), and `fetchTerminalList` self-heals (`await fetchAgentNames()` when an unseen role appears, `terminals.js:764-766`) *before* it relays. There is no "first frame renders all-default icons" race.
- **`.strip-icon` already declares `border: 1px solid transparent`** (`shell.html:72`). A `done` ring set via `border-color` therefore causes **zero layout shift**, and terminal buttons never receive `.is-active` (that class is panel-selection only, `shell.js:` `selectPanel`), so there is no border-rule collision.

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, ux, refactor
**Project:** Browser Switchboard

> **Superseded:** **Complexity:** 3
> **Reason:** 3 is "routine single-file change". This touches four files (`terminals.js`, `shell.js`, `shell.html`, `shell-terminal-strip.test.js`) and rewrites two *shipped* test contracts — the relay-payload allowlist and the state-encoding assertion. Rewriting an existing green contract is the part an intern gets wrong (the failure mode is loosening the assertion until it passes rather than restating the new invariant).
> **Replaced with:** **Complexity:** 4 — multi-file, moderate logic, two contract rewrites. Routes to Coder rather than Intern.

## User Review Required

None. The one genuine design choice — what colour/salience the `done` ring carries — is decided in this plan (see the Superseded callout in *Proposed Changes §3*): it keeps the shipped `#22c55e` + glow rather than the dim accent, because the whole point of the change is that the completion signal must be *more* noticeable, not less.

## Complexity Audit

### Routine
- The brand-icon resolution machinery already exists panel-side: `brandIconForCliLabel` (`terminals.js:948-973`), `brandIconUri` (`terminals.js:975-998`), and `agentLabelForRole` (`terminals.js:3341-3346`). The relay (`postFleetStateToShell`, `terminals.js:608-628`) already iterates `fleetList` and has all three functions in scope. Adding one resolved `iconUri` field is a three-line addition inside the existing `map`.
- The shell already renders `<img>` icons in `buildIcon` (`shell.js:157-164`) for non-SVG panel icons — the `<img>` + fixed-size pattern is established in this file.
- The shell's CSP permits `img-src 'self' data:` (`shell.html:16`, mirrored in `headlessPanelHtml.ts:162`), and the brand icons are served same-origin at `/static/icons/brand-*.svg` in both hosts. No CSP change.
- The accessible name and tooltip already include `t.light` (`shell.js:328-333`); they continue to do so unchanged.
- `.strip-icon` already carries a 1px transparent border, so the ring is a `border-color` swap with no reflow.

### Complex / Risky
- **Test contract breakage — must be fixed in the same change.** `shell-terminal-strip.test.js:92-113` asserts the relay payload is *exactly* `['light','name','role','worktreePath']`. Adding `iconUri` turns it red. The test must be updated to allow the fifth field. Likewise `shell-terminal-strip.test.js:285-301` ("the three lights differ by shape") asserts the `.strip-term-dot.dot-*` CSS rules exist — those rules are being removed, so the test must be rewritten to assert the new state encoding (dimmed icon / completion ring) instead.
- **Two other test files use `postFleetStateToShell` as a source-block *delimiter***: `terminal-sidebar-role-ordering-contract.test.js:101` (`block(terminalsJs, 'function init() {', 'function postFleetStateToShell() {')`) and `terminal-solo-popout-contract.test.js:139` (`block(terminalsJs, "window.addEventListener('resize'", 'function postFleetStateToShell()')`). They slice on the **function signature line**, not the body, so adding fields inside the body is safe — but the signature `function postFleetStateToShell() {` must not be renamed, reordered, or moved. Do not touch it.
- **State encoding must survive a monochrome screenshot.** The completion-lights plan's accessibility argument was shape, not colour. Replacing the dot with a brand icon loses the dot's shape signal, so the new encoding must not rely on colour alone: `exited` = reduced opacity + desaturation (readable as "faded" in monochrome), `done` = a ring around the button (present/absent — a shape, not a hue). The `active` state is the unmodified icon; the *absence* of a ring/fade is itself the signal.
- **Salience regression is the real hazard, not correctness.** The state signal must not get *quieter* than the dot it replaces — see the Superseded callout in *Proposed Changes §3*. A ring that technically exists but is nearly invisible passes every proposed test and reproduces the exact complaint that opened this plan.
- **Dark-fill brands must not disappear when desaturated.** `filter: grayscale(1)` maps `zed #084CCF` / `jules #715CD7` / `qwen #6950EF` to a *dark* grey; at `opacity: 0.4` over the `#060609` rail that button reads **empty**, not "faded". The exited filter needs a brightness lift so every brand desaturates to a legible mid-grey before the fade is applied.
- **No-agent-label fallback.** `agentLabelForRole` returns `''` for the `NO_ROLE` role and for `No agent assigned` (`terminals.js:3341-3346`); `brandIconForCliLabel('')` returns `null` (`terminals.js:949`). The relay must fall back to the default icon URI (`brandIconUri('default')`) in that case, not send an empty string — an empty `src` renders a broken-image glyph in the rail.

## Edge-Case & Dependency Audit

**Race Conditions**
- The relay is last-write-wins on a whole-fleet snapshot (`terminals.js:610-627`). Adding `iconUri` does not change that — it is computed from the same `fleetList` iteration, so it converges on the same tick as the rest of the snapshot.
- `iconUri` is derived from `agentLabelForRole(t.role)` → `brandIconForCliLabel(...)` → `brandIconUri(...)`. All three are pure functions of panel-side state (`agentNames` map + `document.body.dataset`). Ordering is safe: init awaits `fetchAgentNames()` before the first list fetch (`terminals.js:594`), and `fetchTerminalList` re-awaits it whenever an unseen role appears *before* calling `postFleetStateToShell()` (`terminals.js:764-773`). A mid-session re-dispatch under a different CLI therefore relays the new icon on the same refetch that relays the new role. No stale-URI window beyond the one `role` already has.
- Solo pop-out windows short-circuit at `if (window.parent === window) { return; }`, so the solo path (`terminals.js:590`, which calls `fetchTerminalList()` without awaiting `fetchAgentNames`) never relays at all. Not a race — a no-op.
- The 5s `startFleetPoll` fallback (`terminals.js:2891-2901`) re-relays on every tick, so even a dropped WebSocket push converges the icon within one poll interval.

**Security**
- `iconUri` is a same-origin `/static/icons/brand-*.svg` path resolved from `document.body.dataset` attributes that the server stamps (`headlessPanelHtml.ts:410`). It is not user input and not terminal output. The shell assigns it as `icon.src = t.iconUri` — a property assignment, not `innerHTML`, so there is no injection surface. The existing relay already carries `worktreePath` (a server-derived filesystem string) under the same trust model, and `worktreePath` is the more sensitive of the two.
- The relay targets `location.origin` (`terminals.js:624-627`, tested at `shell-terminal-strip.test.js:79-90`); this change adds a field, not a new message type or origin.
- The "no terminal bytes reach the strip" invariant is preserved: `iconUri` is one of a closed set of 18 server-stamped constants, derived from `role` (already relayed) via a pure lookup. No PTY output can reach it.

**Side Effects**
- Removing `.strip-term-dot` removes the only absolutely-positioned child of `.strip-term-btn`. `.strip-icon` keeps `position: relative` (`shell.html:82`) because the tooltip overlay and other strip machinery rely on it — do not remove it as "now unused".
- `.strip-term-btn { font-weight: 600; font-size: 13px }` (`shell.html:194-197`) stops applying to a primary glyph and applies only to the defensive no-URI letter fallback. Keep it; it is not dead.
- Nothing else reads `t.light` in `shell.js` beyond the aria-label and the new state class, so the added `strip-term-<light>` class is purely additive.

**Dependencies & Conflicts**
- Depends on shipped work only: the brand-icon assets (`icons/brand-*.svg`, present at repo root and served by both hosts), the `brandIconForCliLabel` / `brandIconUri` / `agentLabelForRole` functions, and the `terminalFleetState` relay.
- No database, API, verb-schema, or HTTP-endpoint change. No new WebSocket. No `/panels` manifest change. Nothing in this plan touches a verb arm, so the PRD's return-in-body contract, schema-validation contract, and the `verb-returns:check` ratchet are all untouched — the ceilings do not move.
- Per the PRD's anti-divergence contract, both hosts render byte-identical panel HTML from `headlessPanelHtml.ts`; this change edits only `src/webview/*` assets that both hosts serve, so parity is preserved by construction.
- Only `src/` is edited. Do not hand-edit `dist/`.

## Dependencies

- None. This plan has no blocking predecessor session — every function, asset, and route it consumes is already shipped and was verified present during the improve pass.

## Adversarial Synthesis

**Risk Summary:** The dominant risk is not breakage but **salience regression** — replacing a glowing green completion dot with a dim accent-coloured hairline ring would satisfy every proposed test while making the "lights do nothing" complaint objectively worse; the plan now pins `done` to the shipped `#22c55e` + glow so the ring is strictly louder than the dot it replaces. The secondary risks are the dark-fill brands (`zed`, `jules`, `qwen`) desaturating into the near-black rail (mitigated by a `brightness()` lift on the exited filter) and the two shipped test contracts that go red on the relay-payload and dot-CSS assertions (both must be rewritten to state the *new* invariant, never loosened to pass). Verification is manual-visual against an installed VSIX plus the source-regex contract tests; there is no DB, API, or verb surface in scope.

## Proposed Changes

### 1. `src/webview/terminals.js` — relay the resolved brand-icon URI

In `postFleetStateToShell` (`terminals.js:608-628`), add an `iconUri` field to the snapshot object. Resolve it with the existing helpers so the shell receives a ready-to-render URI and needs no brand-icon logic of its own.

**Do not change the function signature line** — `terminal-sidebar-role-ordering-contract.test.js:101` and `terminal-solo-popout-contract.test.js:139` slice the source on `function postFleetStateToShell() {`.

```js
function postFleetStateToShell() {
    if (window.parent === window) { return; }
    const terminals = fleetList.map(t => {
        let light = 'active';
        if (t.status === 'exited') {
            light = 'exited';
        } else if (terminalBadges.has(t.friendlyName)) {
            light = 'done';
        }
        // Resolve the coloured brand icon URI panel-side so the shell needs no
        // brand-icon table or data-brand-icon-* body attributes of its own.
        // agentLabelForRole returns '' for NO_ROLE / 'No agent assigned';
        // brandIconForCliLabel('') returns null, so fall back to the default icon
        // rather than sending an empty src (a broken-image glyph in the rail).
        const agentLabel = agentLabelForRole(t.role);
        const iconKey = brandIconForCliLabel(agentLabel) || 'default';
        const iconUri = brandIconUri(iconKey) || brandIconUri('default');
        return {
            name: t.friendlyName,
            role: t.role,
            worktreePath: t.worktreePath,
            light,
            iconUri
        };
    });
    window.parent.postMessage({
        type: 'terminalFleetState',
        terminals
    }, location.origin);
}
```

No other call site of `postFleetStateToShell` changes — all six funnel through this one function.

### 2. `src/webview/shell.js` — render the brand icon, drop the dot

In `renderTerminalSection` (`shell.js:316-401`), replace the role-letter glyph span and the `.strip-term-dot` element with a single brand-icon `<img>`. Keep the accessible name and tooltip exactly as they are (they already include `t.light`). Add a state class to the button so CSS can encode `exited` / `done`:

```js
for (const t of terminals) {
    const btn = document.createElement('button');
    btn.className = 'strip-icon strip-term-btn strip-term-' + t.light;
    btn.type = 'button';

    const roleChar = (t.role || 'T').charAt(0).toUpperCase();
    let wtBase = 'Workspace Root';
    if (t.worktreePath) {
        const parts = t.worktreePath.replace(/\\/g, '/').split('/').filter(Boolean);
        wtBase = parts.length > 0 ? parts[parts.length - 1] : t.worktreePath;
    }

    const labelText = `${t.name} · ${t.role || 'Terminal'} · ${wtBase} [${t.light}]`;
    btn.setAttribute('aria-label', labelText);
    btn.dataset.tooltip = t.worktreePath ? `${labelText}\n${t.worktreePath}` : labelText;

    // Coloured brand icon replaces the old role-letter glyph + status dot. The
    // URI is resolved panel-side (terminals.js postFleetStateToShell) from the
    // same brandIconForCliLabel/brandIconUri helpers the Terminals sidebar uses,
    // so the two surfaces show the same icon for the same terminal. An <img> (not
    // the strip's CSS-mask/currentColor path) is deliberate: these are multi-hue
    // brand marks whose baked-in fill IS the identity. Fall back to the role
    // letter only if the relay sent no URI (defensive — the relay always sends at
    // least the default icon unless the dataset attrs are missing entirely).
    if (t.iconUri) {
        const icon = document.createElement('img');
        icon.className = 'strip-term-icon';
        icon.src = t.iconUri;
        // alt='' is correct: the button's aria-label already carries name, role,
        // worktree and light state. A brand name here would double-announce.
        icon.alt = '';
        btn.appendChild(icon);
    } else {
        const glyph = document.createElement('span');
        glyph.textContent = roleChar;
        btn.appendChild(glyph);
    }

    // … click handler unchanged (window.open solo pop-out + clearTerminalBadge) …

    container.appendChild(btn);
}
```

The `roleChar` variable is retained only for the defensive no-URI fallback; it is no longer the primary glyph.

### 3. `src/webview/shell.html` — replace dot CSS with icon + state CSS

Remove the `.strip-term-dot` / `.dot-active` / `.dot-done` / `.dot-exited` rules **and their preceding comment block** (`shell.html:198-224`). Keep `.strip-term-btn`'s font rules (`shell.html:194-197`) — they now serve the fallback letter path. Keep `position: relative` on `.strip-icon` (`shell.html:82`) — the tooltip overlay depends on it.

State is encoded as **presentation, not a separate element**: `exited` fades + desaturates the icon; `done` adds a glowing ring around the button; `active` is the unmodified icon.

> **Superseded:**
> ```css
> /* done: a completion ring around the button. */
> .strip-term-btn.strip-term-done {
>     border-color: var(--accent-dim);
>     box-shadow: 0 0 0 1px var(--accent-dim) inset;
> }
> /* exited */
> .strip-term-btn.strip-term-exited .strip-term-icon {
>     opacity: 0.4;
>     filter: grayscale(1);
> }
> ```
> **Reason:** Two defects that both pass the plan's own tests while defeating its goal.
> (a) **The `done` signal gets *quieter*, not louder.** The shipped dot was `#22c55e` filled + `box-shadow: 0 0 4px #22c55e` — a bright glowing green. `var(--accent-dim)` is `#007a8a` (dark teal) in the default theme and `color-mix(in srgb, #D97757 40%, transparent)` — a 40%-alpha terracotta — under `theme-claudify` (`shell.html:32-33, 44-45`). A 1px hairline in either colour on the `#060609` rail is *less* visible than the glowing dot it replaces. This plan exists because the completion signal reads as dead; shipping a fainter one reproduces the complaint with a green test suite. `--accent` is also wrong on its own terms: it is this rail's *panel-selection* colour (`.strip-icon.is-active`, `shell.html:100-103`), so a done terminal would read as "selected".
> (b) **`grayscale(1)` alone erases the dark-fill brands.** `zed #084CCF`, `jules #715CD7`, `qwen #6950EF` desaturate to a *dark* grey; at `opacity: 0.4` over `#060609` the button reads **empty**, which is a different (and worse) message than "exited".
> **Replaced with:** `done` keeps the shipped `#22c55e` + glow, scaled from a 7px dot to the 36px button ring — strictly more salient than what it replaces. `exited` adds a `brightness()` lift so every brand desaturates to a legible mid-grey before fading, and the opacity floor rises to `0.5`.

```css
.strip-term-icon {
    width: 22px;
    height: 22px;
    object-fit: contain;
    pointer-events: none;
}
/* exited: desaturated, lifted toward mid-grey, then faded. grayscale() ALONE sinks
   the dark-fill brands (zed #084CCF, jules #715CD7, qwen #6950EF) into the near-black
   rail — the button reads EMPTY rather than "faded", which is a worse message than the
   dot ever sent. brightness() sets a contrast floor so every brand lands on a legible
   grey first; the opacity is then what says "gone". Readable in a monochrome
   screenshot, which is the accessibility contract the old shape coding carried. */
.strip-term-btn.strip-term-exited .strip-term-icon {
    opacity: 0.5;
    filter: grayscale(1) brightness(1.7);
}
/* done: the completion ring. Same #22c55e + glow the shipped 7px dot used, scaled up
   to the whole 36px button — strictly MORE salient than the dot it replaces, which is
   the entire point of this change. Hardcoded green, NOT var(--accent)/var(--accent-dim):
   the accent is this rail's panel-SELECTION colour (.strip-icon.is-active), so an accent
   ring would read as "selected", and --accent-dim under theme-claudify is a 40%-alpha
   terracotta that is nearly invisible on #060609. The ring is a SHAPE (present/absent),
   so hue is a bonus channel, not the signal — monochrome and deuteranopic viewers read
   the ring itself. .strip-icon already declares `border: 1px solid transparent`, so this
   is a colour swap with zero layout shift. */
.strip-term-btn.strip-term-done {
    border-color: #22c55e;
    box-shadow: 0 0 0 1px #22c55e inset, 0 0 6px rgba(34, 197, 94, 0.55);
}
/* active: DELIBERATELY no rule. The unmodified full-colour icon in an unringed button
   IS the live state. Never add a fade or a ring here — that absence is precisely what
   makes active distinguishable from done and exited. */
```

### 4. `src/test/shell-terminal-strip.test.js` — update contracts

Three tests need updating; one new test is added. Rewrite each to state the **new** invariant — never loosen an assertion until it passes.

**a. "relay carries only fleet metadata"** (`shell-terminal-strip.test.js:92-113`): the allowed field set gains `iconUri`. The test's purpose — "no terminal bytes reach the strip" — is preserved: `iconUri` is one of 18 server-stamped same-origin SVG paths, not PTY output. Update **both** the `deepStrictEqual` and the per-field `includes` loop below it (the loop has its own hardcoded list and will otherwise fail on the new field).

```js
assert.deepStrictEqual(
    names.slice().sort(),
    ['iconUri', 'light', 'name', 'role', 'worktreePath'],
    'the relay payload must be the five metadata fields; iconUri is a resolved same-origin SVG path, not terminal bytes'
);
for (const n of names) {
    assert.ok(
        ['name', 'role', 'worktreePath', 'light', 'iconUri'].includes(n),
        `relay payload field "${n}" is outside the metadata set the plan allows`
    );
}
```

Also assert the relay resolves a non-empty `iconUri` (the default fallback) so a no-label terminal never ships an empty `src`:

```js
assert.ok(
    /const iconKey = brandIconForCliLabel\(agentLabel\) \|\| 'default'/.test(relay),
    'the relay must fall back to the default icon key when there is no agent label'
);
assert.ok(
    /brandIconUri\(iconKey\) \|\| brandIconUri\('default'\)/.test(relay),
    'an unresolvable key must still yield the default URI — never an empty src'
);
```

**b. "the three lights differ by shape, not by colour alone"** (`shell-terminal-strip.test.js:285-301`): rewrite to assert the new state encoding. The dot rules are gone; the contract is now that `exited` desaturates + fades (with a brightness floor), `done` adds a glowing ring, and `active` stays the null state.

```js
test('terminal state is encoded without a separate dot — exited fades, done rings, active is bare', () => {
    const exited = shellHtml.match(/\.strip-term-btn\.strip-term-exited\s+\.strip-term-icon\s*\{([^}]*)\}/);
    assert.ok(exited, '.strip-term-exited .strip-term-icon rule is missing');
    assert.ok(/grayscale\(1\)/.test(exited[1]), 'exited must desaturate the icon — the monochrome-survivable signal');
    assert.ok(/brightness\(/.test(exited[1]), 'exited must lift brightness — grayscale alone sinks the dark-fill brands into the rail');
    assert.ok(/opacity:\s*0\./.test(exited[1]), 'exited must fade the icon');

    const done = shellHtml.match(/\.strip-term-btn\.strip-term-done\s*\{([^}]*)\}/);
    assert.ok(done, '.strip-term-done rule is missing');
    assert.ok(/border-color:/.test(done[1]) && /box-shadow:/.test(done[1]),
        'done must add a ring AND a glow — a shape plus salience, not a hairline');
    assert.ok(!/var\(--accent/.test(done[1]),
        'done must not borrow the accent — that is the panel-SELECTION colour in this rail, and --accent-dim is near-invisible under theme-claudify');

    // active is the null state: no rule may fade or ring it, or it collapses into exited/done.
    assert.ok(!/\.strip-term-btn\.strip-term-active\b/.test(shellHtml),
        'active must stay unmodified — the absence of a ring/fade IS the live signal');

    // The old dot rules must be fully removed.
    assert.ok(!/\.strip-term-dot/.test(shellHtml), 'no .strip-term-dot CSS may survive — the dot is replaced by the brand icon');
    assert.ok(!/dot-active|dot-done|dot-exited/.test(shellHtml), 'no dot-* state classes may survive in shell.html');
});
```

**c. "the light state is in the accessible name, not only the dot"** (`shell-terminal-strip.test.js:271-283`): still passes as-is — the aria-label line is unchanged, so `/labelText = `[^`]*\$\{t\.light\}/` still matches. No edit required; re-run to confirm rather than assuming.

**d. New test — the strip renders a brand-icon `<img>` from the relayed URI:**

```js
test('the strip renders a coloured brand-icon img from the relayed iconUri', () => {
    const fn = block(shellJs, 'function renderTerminalSection(terminals) {', 'function renderManifest(manifest) {');
    assert.ok(
        /createElement\('img'\)[\s\S]*strip-term-icon[\s\S]*icon\.src = t\.iconUri/.test(fn),
        'the strip must render an <img class="strip-term-icon"> whose src is the relayed t.iconUri'
    );
    assert.ok(
        /strip-term-' \+ t\.light/.test(fn),
        'the button must carry a strip-term-<light> state class so CSS can encode exited/done'
    );
    assert.ok(!/strip-term-dot/.test(fn), 'the strip must no longer create a .strip-term-dot element');
    assert.ok(
        /icon\.alt = ''/.test(fn),
        "alt must be empty — the button's aria-label already carries the identity; a brand name here double-announces"
    );
});
```

## Verification Plan

### Automated Tests

1. `node src/test/shell-terminal-strip.test.js` — all tests green, including the updated relay-payload test (a), the rewritten state-encoding test (b), the unchanged accessible-name test (c), and the new brand-icon test (d).
2. `node src/test/terminal-solo-popout-contract.test.js` and `node src/test/terminal-sidebar-role-ordering-contract.test.js` — both slice `terminals.js` on the `postFleetStateToShell` signature line. They must stay green, proving the signature was not disturbed.
3. No verb, schema, or ratchet gate is in scope — `verb-returns:check`, `parity:check`, and `push-routing:check` are unaffected by this change and their baselines do not move.

*(Not executed during this improve pass — the session was directed to skip test and compilation runs. These are the coder's gates.)*

### Manual — browser cockpit

Manual UAT runs against an **installed VSIX**, not the repo working tree: `getShellHtml` / `getTerminalsHtml` resolve `dist/webview/*` ahead of `src/webview/*` (`headlessPanelHtml.ts:152-155`), so a live server serves the packaged build. Do **not** hand-edit `dist/`; do not audit `dist/` staleness as a review finding.

- Open the standalone browser shell (`/shell` or the cockpit URL). Dispatch or spawn a fleet with at least two different agent CLIs (e.g. one `claude` coder, one `devin` reviewer).
- Confirm each terminal strip button shows the **coloured brand icon** for its CLI (Claude mark for the claude terminal, Devin mark for the devin terminal), not a role letter + dot.
- Confirm a terminal with no agent (e.g. a `NO_ROLE` / unassigned terminal) shows the neutral grey default CLI icon, not a broken-image glyph.
- Trigger an `agentCompleted` (let a coder finish). Confirm the finished terminal's button gets the **glowing green ring** and the icon stays full-colour — and that it is *at least as eye-catching* as the old green dot. This is the plan's actual acceptance criterion; if it is not, the ring is wrong regardless of what the tests say.
- Exit a terminal (let its process die on its own). Confirm its icon goes faded + desaturated **and is still visibly present** — check specifically with a dark-fill brand (`zed`, `jules`, or `qwen`) that the button does not read as empty.
- Repeat the done/exited checks under the **Claudify theme** (toggle it in the strip) to confirm the hardcoded green ring still reads correctly against the terracotta palette.
- Hover a button: confirm the tooltip still shows `name · role · worktree-basename [light]` plus the full worktree path on a second line.
- Confirm the screen-reader accessible name (devtools accessibility pane) still includes the light state, and that the icon contributes no duplicate announcement (`alt=""`).

### Regression — strip layout

Confirm the bottom anchor, the scroll region (`#strip-terminals`), the tooltip overlay, and the pop-out click behaviour are unchanged — those code paths are untouched by this plan, and `position: relative` on `.strip-icon` must remain.

---

**Recommendation:** Send to Coder (complexity 4).

## Completion Report

Implemented the brand-icon replacement end-to-end across all four files. `terminals.js` `postFleetStateToShell` now resolves an `iconUri` panel-side via the existing `agentLabelForRole`/`brandIconForCliLabel`/`brandIconUri` helpers (with a `default` fallback so no empty `src` ever ships) and adds it to the relay payload; the function signature line was left untouched to preserve the sibling contract-test delimiters. `shell.js` `renderTerminalSection` replaces the role-letter span + `.strip-term-dot` with an `<img class="strip-term-icon">` (alt='' since the aria-label carries identity) and adds a `strip-term-<light>` state class, keeping the role-letter only as a defensive no-URI fallback. `shell.html` drops the `.strip-term-dot`/`dot-*` CSS and adds `.strip-term-icon` sizing plus state encoding: `exited` = `grayscale(1) brightness(1.7)` + `opacity:0.5` (lifts dark-fill brands off the near-black rail), `done` = hardcoded `#22c55e` ring + glow (strictly louder than the dot it replaces; no `var(--accent)` to avoid reading as "selected"), `active` = deliberately no rule. The test file updated the relay-payload allowlist to five fields, added the default-fallback regex assertions, rewrote the shape-difference test to assert the new fade/ring/bare encoding and full dot removal, and added a new brand-icon `<img>` render test. Files changed: `src/webview/terminals.js`, `src/webview/shell.js`, `src/webview/shell.html`, `src/test/shell-terminal-strip.test.js`. Verification: `shell-terminal-strip.test.js` 25/25 green, `terminal-solo-popout-contract.test.js` 11/11 green, `terminal-sidebar-role-ordering-contract.test.js` 7/7 green — the `postFleetStateToShell` signature delimiter survived unchanged in both sibling suites. No issues encountered; no compilation or full test-suite run per task directives.

## Review Findings

Reviewed `src/webview/terminals.js` (relay), `src/webview/shell.js`, `src/webview/shell.html`, and `src/test/shell-terminal-strip.test.js`; the implementation matches the plan exactly and no code fixes were required. Verification executed independently: `shell-terminal-strip` 25/25, `terminal-solo-popout` 11/11, `terminal-sidebar-role-ordering` 7/7, plus `panel-runtime-surface`, `loopback-hostname`, and the `parity`/`push-routing`/`verb-returns` ratchets — all green with baselines unmoved; the two red gates in the wider terminal sweep (`terminal-pane-fit-verification` wanting `const DEFAULT_ROLES`, `terminal-focus-affordance` wanting `entry.inputDropNoticed = false`) are red at HEAD and reference identifiers this plan never touched. Gate wiring confirmed: all three plan-named checks are defined at `package.json:864,869,872` and invoked by CI at `.github/workflows/integration-tests.yml:367,407,416`. One design consequence was raised and **accepted by the user — it is not an open risk**: the brand icon identifies the CLI but not the role, so a fleet where every role runs the same CLI renders visually identical strip buttons. Role disambiguation is hover-gated by design, via the existing `data-tooltip` (`shell.js:328-333`, `friendlyName · role · worktree [light]` plus the full path) and the matching aria-label. Both alternatives are explicitly rejected and must not be re-proposed: a role letter (the first character of a role name is not an interpretable mnemonic — that is why it was removed) and a wider rail (the 48px strip width is fixed). Deferred NITs: `box-shadow` is absent from `.strip-icon`'s `transition` list so the done ring's border fades while its glow snaps; `#strip-terminals` has no bottom padding so the last button's outer glow is clipped; and the role-letter fallback guards a falsy `iconUri` but not a failed image load (no `icon.onerror`).
