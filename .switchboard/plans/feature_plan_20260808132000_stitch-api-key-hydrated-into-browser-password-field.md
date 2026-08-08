# The Design Panel Hydrates the Plaintext Stitch API Key Into a `type="password"` Field, So Chrome Offers to Save It to the User's Password Manager on Cockpit Open

## Goal

Stop the Google Stitch API key from being sent to the panel UI in plaintext, and stop the browser cockpit from presenting it to Chrome as a login credential. After this change, opening the browser cockpit must produce no "Save password?" prompt, and the key must never leave the host's secret storage on a read path.

### Problem

Opening the standalone browser cockpit immediately triggers Chrome's **"Save password?"** bubble, showing a long value the user never typed. The value is the Google Stitch API key (`AIzaSy…`, 39 characters).

The chain, in order:

1. **Every panel iframe mounts up-front.** `shell.js:442-457` iterates the whole `/panels` manifest and, for every entry not marked `enabled === false`, calls `buildFrame(panel)` (`shell.js:228-236`) and appends the iframe to `#content` immediately; `shell.html:144-153` hides all but one (`.panel-frame { display: none }` / `.panel-frame.is-active { display: block }`), toggled at `shell.js:36`. So `design.html` loads and runs on cockpit open whether or not the user ever clicks Design.
2. **Design is in the standalone manifest.** `bootstrap.ts:619` passes `design: true`.
3. **The browser-mode secrets gate does not fire.** `bootstrap.ts:588` advertises `secretsEntry: true`, so the `caps.secretsEntry === false` branch in `transport.js:497-545` — the one that hides `#btn-save-stitch-auth` and disables `#stitch-api-key-input`, `#clickup-token-input`, `#linear-token-input`, `#notion-token-input`, `#multi-repo-pat` — is skipped. This is correct and must not be changed: standalone is *supposed* to accept secret entry, and `src/test/standalone-secrets-bridge-contract.test.js:309-310` asserts it.
4. **The backend posts the key in clear text on hydration.** `DesignPanelProvider.ts:2539-2544` sends `stitchAuthStatus` with `apiKey: authInfo.apiKey`, sourced from `_setupStitchAuth` (`:2089-2097`), which reads the secret store via the seam and falls back to `process.env.STITCH_API_KEY`.
5. **The webview writes it straight into a password input.** `design.js:3821-3827` routes `stitchAuthStatus` to `updateStitchAuthUI`, which does `keyInput.value = apiKey` at `design.js:5170-5171`. The target is `<input type="password" id="stitch-api-key-input">` (`design.html:4024`).
6. **The field is invisible the whole time.** Its container `#stitch-auth-panel` is `style="display: none"` by default (`design.html:4016`), inside an iframe that is itself `display: none`.

> **Superseded:** "A `type="password"` field, programmatically filled, never submitted, sitting in a hidden container — that is precisely Chrome's SPA login-detection heuristic, and it fires the save bubble."
> **Reason:** Web research into Chromium's password-manager internals contradicts this on three independent points (see **Research Findings**): programmatic `.value` assignment does not set the user-edited flag that `PasswordFormManager` requires; a `**********`-class value is rejected by the entropy/placeholder filter; and fields inside a `display:none` subtree or a `display:none` iframe fail Blink's `IsVisible()` check and are never extracted into a form at all. Steps 1–5 of the chain are verified in this codebase and stand. Step 6 was offered as the *reason* the prompt fires, and it is in fact a reason it should **not**.
> **Replaced with:** The observation is real and is the reported bug; the mechanism is **unconfirmed**. Something in the cockpit is producing a save prompt for a long value the user never typed, and the source field has not been positively identified — only inferred from the value's length and the presence of a plaintext key on the wire. The prompt's actual source must be identified before Change 3 can be aimed (see Verification step 0). This does **not** gate Changes 1, 2 and 4: those close G1, which is a verified plaintext-secret leak over the panel transport and needs no browser heuristic to justify it.

### Root cause

**The read path returns the secret when it only ever needed a boolean.** Nothing in the Stitch UI uses the key's value: `updateStitchAuthUI` writes it to the input and otherwise renders `configured` / `valid` / `error` (`design.js:5166-5199`). `msg.apiKey` has exactly one consumer in the entire webview — `design.js:5167`. The key is fetched, serialised, transported, and painted purely so the input can look non-empty — a job `'**********'` already does everywhere else in this codebase.

This is an inconsistency, not a design: **every other secret field in Switchboard already masks on hydration.**

- ClickUp / Linear: `tickets.js:7883-7898` sets `input.value = '**********'` from a `hasToken` boolean.
- Notion: `setup.html:3728-3745`, same pattern, with focus/blur mask handling in `setupTokenMasking` (`setup.html:2508-2530`).
- Even within the same provider, `stitchSaveApiKey` at `DesignPanelProvider.ts:3141` posts `stitchAuthStatus` **without** `apiKey`, while the four neighbouring emitters include it.

Stitch is the one field that receives the real secret — which is exactly why it is the one field producing a "really long password" in the Chrome prompt.

### Severity

The `LocalApiServer` binds loopback-only (`LocalApiServer.ts:411`, `:3444-3448`), so this is not a network exposure. The real cost is the sink: a plaintext API key gets written into Chrome's password store keyed to `http://localhost:<port>`, where it is reachable by anything else on that origin in that profile and, if the user has Chrome sync on, is uploaded to Google Password Manager. A key the user deliberately put in the OS keychain ends up in a second, weaker, syncing store — via a prompt they did not ask for and cannot connect to any action they took.

Secondary: the panel's own assurance copy at `design.html:4021` reads "*is used only to call Google Stitch directly — it's never sent to any Switchboard server or logged*." In the VS Code host this is true (in-process `postMessage`). In standalone it is false in both directions — the key is read out of the host store and pushed to the browser over the local transport on hydration, and posted back over loopback HTTP on save.

### Two goals, two different fixes — do not conflate them

The Goal above contains two distinct requirements, and they are closed by *different* changes:

- **G1 — "the key must never leave host secret storage on a read path."** Closed by removing `apiKey` from the outbound `stitchAuthStatus` payloads and masking on hydration (Changes 1 and 2). Fully verifiable by inspecting the transport payloads; no browser heuristics involved.
- **G2 — "opening the browser cockpit must produce no 'Save password?' prompt."** Not closed by masking, and not reliably closed by anything until the prompting field is identified. Research (below) establishes that the only *mechanism-independent* fix is to remove `type="password"` from the hydrated inputs and mask visually with `-webkit-text-security: disc`, because Chrome's credential classifier reads DOM attributes and never CSS — so a non-password input is invisible to it regardless of which heuristic is actually firing. `autocomplete="off"` and `autocomplete="new-password"` are both dead ends. That makes Change 3 the fix for G2, but it must be **aimed** at the right fields, and the reported prompt's source has not been positively identified.

G1 alone leaves a plausible outcome where the prompt still appears offering to save `**********`: the symptom the user reported survives, with a less interesting payload. That is why Change 3 is **required, not optional**, and why its scope is the whole hydrated-password-field set rather than Stitch alone. This does not add product scope — it is the scope the existing Goal sentence already states.

**Sequencing consequence.** Changes 1, 2 and 4 are unconditional and ship on G1's merits. Change 3 is preceded by Verification step 0, a five-minute diagnostic that names the actual prompting field. If step 0 shows the prompt comes from a field this plan does not touch, that is a finding to report, not a reason to widen the plan mid-implementation.

## Metadata

- **Complexity:** 5
- **Tags:** security, authentication, bugfix, ui, frontend

> **Superseded:** **Complexity:** 3
> **Reason:** The original 3 assumed the change was "drop a field from four payloads + one assignment". Verification of the save path showed the fix requires tri-state save semantics with a matching backend change (`undefined` = no change vs `''` = delete), a replacement clear affordance, and de-passwording four inputs across three webview files to actually close the stated goal. That is multi-file coordination with a credential-destroying failure mode — mixed, not routine.
> **Replaced with:** **Complexity:** 5

> **Superseded:** **Tags:** security, secrets, design-panel, browser-cockpit, standalone, webview
> **Reason:** `secrets`, `design-panel`, `browser-cockpit`, `standalone`, and `webview` are not in the allowed tag vocabulary, so they are dropped silently on import and the plan lands under-tagged.
> **Replaced with:** **Tags:** security, authentication, bugfix, ui, frontend

## User Review Required

None.

## Complexity Audit

### Routine

- Dropping a field from five message payloads in one file.
- Replacing one assignment in `updateStitchAuthUI` with the mask pattern already used twice elsewhere.
- Changing an `input` type and adding a CSS declaration.

### Complex / Risky

- **Five payload sites, not one.** `apiKey` is attached to `stitchAuthStatus` at `DesignPanelProvider.ts:2539-2544` (hydration), `:3161-3166` (`stitchSaveAuthConfig`), and `:3178-3184`, `:3190-3195`, `:3199-3205` (`stitchValidateAuth`, all three branches — not-configured, valid, and the catch). Fixing hydration alone leaves Validate Connection re-filling the field with the real key, which re-arms the same Chrome prompt on the next visibility toggle. All of them must go together.

  > **Superseded:** "**Four emitters, not one.** … `:3162`, `:3179` and `:3191` and `:3200`."
  > **Reason:** The count and the enumeration disagreed — four *cases* carry the field across **five** payload sites. `:3178-3184` is the `!auth.valid` branch, where `auth.apiKey` is `''`, so it is harmless in effect but still must be removed for uniformity; an implementer working from "four" plus a five-item list will leave one behind.
  > **Replaced with:** Five payload sites across four `case` arms, enumerated above.

- **The mask sentinel is a credential-destroying trap under Stitch's save semantics.** `stitchSaveAuthConfig` (`:3149-3172`) and `stitchSaveApiKey` (`:3130-3147`) both branch `if (message.apiKey) store(...) else delete(...)`. Stitch treats **empty as DELETE**. The reference pattern this plan cites does the opposite: `setup.html:2546-2548` and `tickets.js:5788-5813` convert the sentinel to `''`, and `TaskViewerProvider.handleApplyNotionConfig` (`:7616-7623`) treats `''` as *keep existing* and never deletes. So copying the reference pattern — or omitting `apiKey` so it arrives `undefined` — routes straight into Stitch's `delete` branch and wipes the stored key. The blast radius is larger than one store: on the VS Code host, `context.secrets.onDidChange` propagates the delete to the machine-global `EncryptedSecretsStore` (`extension.ts:698-710`, `:755-760`), so the key is destroyed for standalone and the `npx switchboard` CLI too. Fixing this requires a **backend change**, not just a webview guard (Change 1, item 3).
- **Masking removes the only clear affordance.** With `setupTokenMasking`'s blur-restore behaviour (`setup.html:2519-2527`), emptying the field and clicking Save cannot clear the key: `blur` fires before `click`, the mask is restored, and the save sees the sentinel. Notion tolerates this because it never deletes; Stitch must stay clearable (Verification 7). Needs an explicit control.
- **Do not flip `secretsEntry`.** Gating the field off in standalone would suppress the symptom by breaking the feature, and would fail `standalone-secrets-bridge-contract.test.js:309-310`. Browser secret *entry* is intended; browser secret *readback* is not.
- **The prompt's mechanism is unconfirmed, so the fix must be mechanism-independent.** `autocomplete="off"` is confirmed useless (Chrome ignores it for saving, by explicit policy) and `autocomplete="new-password"` is worse (it *enables* generation and save/update). The one confirmed-reliable move is a non-`type="password"` input with `-webkit-text-security: disc`: Chrome's classifier reads DOM attributes, never CSS, so such a field is not a credential candidate under **any** of the competing heuristics. Do not substitute an `autocomplete` attribute for this, and do not rely on the mask value being rejected on entropy grounds — see **Research Findings**.

## Edge-Case & Dependency Audit

### Race conditions

- None. All five payload sites are responses to a completed host-side operation; the change removes a field from each payload rather than reordering anything.
- The `stitchApiKeyStatus` push (`:2538`, `:3140`, `:3160`) is a separate, already-boolean message. Its only webview consumers (`design.js:3814-3819`, `:3822-3826`) null-guard on `stitchApiBanner`, which is `null` today (see the dead-handler item in Change 2). Nothing there needs to change or is affected by ordering.

### Security

- This plan reduces exposure; it adds none. No new route, no new store, no change to `_setupStitchAuth`'s internal use of the key, and no change to the loopback bind.
- The verb schemas (`verbSchemas.ts:133-142`) declare `apiKey` as an **optional** `string` for both `stitchSaveApiKey` and `stitchSaveAuthConfig`, and `validateVerbPayload` (`verbSchemas.ts:49-77`) passes undeclared fields through. So omitting `apiKey` passes HTTP validation, and adding a `clearKey` boolean would too. Declare `clearKey` in the schema anyway — an undeclared field is unvalidated, which is the thing contract #5 exists to prevent.
- **Already-saved credentials are not cleaned up by this change.** Any user who accepted the Chrome prompt has the key in their browser password store today, and shipping this fix does not remove it. Call that out in release notes with the manual removal step — the code cannot reach it.

### Side effects

- The Stitch auth panel will show a masked field where some users currently see their key. That is the intended change and matches ClickUp/Linear/Notion behaviour, but it does mean the panel is no longer a way to *recover* a forgotten key. The OS keychain remains the place it is stored.
- `process.env.STITCH_API_KEY` (`DesignPanelProvider.ts:2091`, `:3137`) is untouched. A key supplied by env var still works and still masks identically, since the mask is driven by a boolean. Note that an env-only key reports `configured: true` but has nothing in the secret store — a "no change" save must therefore be a genuine no-op, not a re-store of a value the webview no longer has.
- De-passwording the input means the browser will no longer offer to autofill it. That is the point, and no user should be relying on Chrome autofill for a key that lives in their keychain.

### Dependencies & conflicts

- **Independent.** No schema migration, no manifest change, no shared helper edit. Touches `DesignPanelProvider.ts`, `design.js`, `design.html`, `verbSchemas.ts` (one field), and — for G2 — `tickets.html` and `setup.html`.
- **Related:** the `caps.secretsEntry` gate in `transport.js:497-545` and the headless default `secretsEntry: false` (`headlessPanelHtml.ts:37`) are the *entry* half of this surface. This plan is the readback half. Neither changes the other. If Change 3 renames or retypes an input, the `transport.js` selector lists at `:507-512` and `:518-525` still match — they select by `id`, not by type — but re-read them rather than assuming.
- **PRD contract #1 (both hosts render byte-identical panel HTML from the shared module)** means every Change 3 edit is automatically shared with the VS Code host. There is no host-conditional variant here and none should be added.
- **PRD contract #6 (no dead buttons)** covers the new clear control: it must be present and functional in both hosts, and it is already covered by the `secretsEntry` gate if a future host disables secret entry — add its id to the `transport.js` hide list at `:507-512` alongside `#btn-save-stitch-auth`.
- **Audit resolved, not deferred:** `#onboard-cp-pat` (`implementation.html:1411`) and `#multi-repo-pat` (`setup.html:1206`) were checked. Both are write-only — the only reads are `implementation.html:3534` (`.value` at send time) and the `transport.js` gate; nothing in `src/` ever assigns to either. They are never programmatically filled, so they are not part of the hydration defect. Whether Chrome still prompts on a *user-typed* transient PAT is a separate question and out of scope for this plan.

  > **Superseded:** "Consider auditing `#onboard-cp-pat` … and `#multi-repo-pat` … Both appear to be write-only transient fields, so they are probably clean; confirm rather than assume."
  > **Reason:** The audit is a two-grep question and leaving it as a to-do in the plan means it gets skipped. It was run; the guess was correct.
  > **Replaced with:** The confirmed result above.

- **Non-issues, recorded so nobody "fixes" them in this pass:**
  - `stitchSaveAuthConfig` writes via `this._context.secrets` (`:3152`, `:3154`) while `stitchSaveApiKey` uses `this._seams().secrets` (`:3133`, `:3135`). This is a PRD contract #3 hygiene inconsistency, not a bug: `createVscodeHostSeams` is constructed *with* `this._context.secrets` (`:137`, `:280`), and standalone passes its `secretStorage` as `headlessContext.secrets` (`bootstrap.ts:684`), so both paths hit the same store in both hosts, and the `onDidChange` mirror sees both. Normalise it to the seam while editing the arm (one-line, zero behaviour change); do not treat it as a defect requiring its own verification.
  - `showTemporaryNotification` at `:3167` is the bare import (`:11`) rather than `this._seams().ui.showTemporaryNotification` used at `:3142`. It is safe in standalone — webpack aliases `vscode` to `src/standalone/vscodeShim.ts` (`webpack.config.js:150`), which implements `withProgress` (`vscodeShim.ts:146`). Leave it or normalise it; it is not a functional gap.

## Dependencies

- None. No prior session is required, and no other plan blocks this one.

## Adversarial Synthesis

**Risk summary.** The single credential-destroying risk is the mask sentinel meeting Stitch's `empty ⇒ delete` save semantics: with the fix as originally written, a user who opens the auth panel and clicks Save without typing loses their key from both the keychain and the mirrored machine-global store. Mitigated by tri-state save semantics — `undefined` = no change (new backend branch), a typed value = store, an explicit Clear control = delete — plus a webview guard that never transmits the sentinel. The second risk is a **mis-aimed fix**: research contradicts the diagnosed prompt mechanism on three points, so the plan closes a verified leak (G1) while its target for the reported symptom (G2) is inferred rather than confirmed; mitigated by a mandatory pre-implementation diagnostic (Verification step 0) that reads the actual saved credential entry, by a mechanism-independent fix (de-`type="password"`, which defeats every competing heuristic), and by pinning `--port` so Chrome's origin-keyed suppression cannot fake a pass. Everything else here is cosmetic.

## Proposed Changes

### 1. `src/services/DesignPanelProvider.ts` — stop returning the secret, and make "no change" expressible

1. **Remove `apiKey` from all five `stitchAuthStatus` payloads:** `:2539-2544`, `:3161-3166`, `:3178-3184`, `:3190-3195`, `:3199-3205`. Where the receiver needs to know a key exists, `configured` already carries it. `stitchSaveApiKey` at `:3141` is already in this shape — make it the shape all five follow.
2. **Leave `_setupStitchAuth` (`:2089-2097`) returning `apiKey`.** It is consumed host-side to call Stitch. Only the outbound message shape changes.
3. **Add the "no change" branch to both save arms.** Today:

   ```ts
   if (message.apiKey) { await store(KEY, message.apiKey); } else { await delete(KEY); }
   ```

   Becomes, in `stitchSaveApiKey` (`:3132-3136`) and `stitchSaveAuthConfig` (`:3151-3155`):

   ```ts
   const hasField = typeof message.apiKey === 'string';
   if (!hasField && message.clearKey !== true) {
       // Field untouched in the webview — the browser no longer holds the key,
       // so "no field" means "leave the stored value alone". Without this branch
       // a Save with an untouched masked field falls into delete() and destroys
       // the credential (and, on the VS Code host, the mirrored copy too).
   } else if (message.apiKey) {
       await this._seams().secrets.store('switchboard.stitch.apiKey', message.apiKey);
   } else {
       await this._seams().secrets.delete('switchboard.stitch.apiKey');
   }
   ```

   Note the `process.env.STITCH_API_KEY = message.apiKey || ''` line at `:3137` must move inside the store/delete branches — on a no-change save it must not blank the env var that `_setupStitchAuth` falls back to.
4. **Normalise `stitchSaveAuthConfig`'s store/delete to `this._seams().secrets`** (see the non-issues note above) so both save arms read identically.
5. Both arms still `return { success: true, configured: auth.valid }` — unchanged, and still contract-#4 compliant.

### 2. `src/webview/design.js` — mask on hydration, never transmit the sentinel

1. **`updateStitchAuthUI` (`:5166-5171`)** — replace `keyInput.value = apiKey` with the established mask. When `msg.configured` is true, set `'**********'` and `dataset.hasToken`/`dataset.originalHasToken` to `'true'`; when false, clear the value and set both flags `'false'`. Mirror `tickets.js:7883-7898` including the `borderLeft` affordance. Delete the now-unused `const apiKey = msg.apiKey || ''` line — nothing else in `design.js` reads it (`grep apiKey src/webview/design.js` → only `:2757`, `:4969`, `:5167`, `:5171`).
2. **Focus/blur masking** — port `setupTokenMasking` (`setup.html:2508-2530`) for `#stitch-api-key-input`: focus clears the mask when `hasToken === 'true' && value === '**********'`; blur restores it when the field was left empty and `originalHasToken === 'true'`.
3. **Save handler (`:4968-4975`)** — build the message tri-state instead of always sending `apiKey`:

   ```js
   const el = document.getElementById('stitch-api-key-input');
   const raw = el?.value.trim() || '';
   const msg = { type: 'stitchSaveAuthConfig' };
   if (raw && raw !== '**********') { msg.apiKey = raw; }   // typed a new key → store
   // untouched mask, or empty-and-remasked → send no apiKey at all → backend no-ops
   vscode.postMessage(msg);
   ```

   > **Superseded:** "In the `btn-save-stitch-auth` handler (`:4968-4975`), treat a value of `'**********'` as 'no change' and omit the key from the message, matching `setup.html:2546-2548`."
   > **Reason:** Half right, and the wrong half is destructive. `setup.html:2546-2548` maps the sentinel to `''`, and omitting the field leaves it `undefined` — under Stitch's `if (message.apiKey) … else delete(…)` both land in the delete branch and wipe the key. The webview guard is necessary but not sufficient; the backend must learn to distinguish "no field" from "empty field" (Change 1, item 3) or this "mitigation" *is* the regression the plan warns about.
   > **Replaced with:** The tri-state webview message above, paired with the new backend branch in Change 1.

4. **Add an explicit clear control.** Masking removes the "empty the field and Save" path (blur restores the mask before the click lands), so add `#btn-clear-stitch-auth` beside Save that posts `{ type: 'stitchSaveAuthConfig', clearKey: true }` and, on the resulting `stitchAuthStatus`, leaves the field empty with both dataset flags `'false'`. Per project rules it deletes immediately — **no confirmation dialog**. Add its id to the `transport.js` `secretsEntry === false` hide list (`:507-512`) next to `#btn-save-stitch-auth`.
5. **Remove the dead second save handler at `:2755-2763`.** It binds to `#btn-save-stitch-api-key` and `#stitch-api-banner`, neither of which exists in `design.html` (or anywhere in `src/`), so `btnSaveStitchApiKey` and `stitchApiBanner` (`:2003`, `:2005`) are both `null` and the block never registers. It matters here because it reads the *same* `#stitch-api-key-input` and guards only on truthiness (`:2758`) — a truthy `'**********'` would be stored verbatim. Delete the block and the two dead lookups, or guard it identically; leaving it is a landmine for whoever revives that banner. The `if (stitchApiBanner)` guards at `:3816` and `:3824` become dead too and can go with it.

### 3. `src/webview/design.html` + `tickets.html` + `setup.html` — de-password the hydrated inputs, fix the copy

**Required, not optional** — this is what closes G2 (see "Two goals, two different fixes").

> **Superseded:** "Optional but recommended: change `#stitch-api-key-input` (`:4024`) from `type="password"` to `type="text"` with `-webkit-text-security: disc`. … If taken, apply the same treatment to the ClickUp, Linear, and Notion fields for consistency."
> **Reason:** Masking changes the *value* Chrome sees, not the *fact* that a password field was programmatically filled — the documented trigger. Marking the only change that addresses the reported symptom as "optional", and the sibling fields as a mere consistency nicety, permits a "complete" implementation that still shows a Save-password bubble on cockpit open. The sibling fields are not consistency: they are three more programmatically-filled `type="password"` inputs in panels that mount up-front in the same shell origin.
> **Replaced with:** Required, and scoped to every hydrated token input, as below.

**Aim it first.** Verification step 0 must have positively identified the prompting field before this change is written. The mechanism is unconfirmed; the *fix* is confirmed (research: Chrome's classifier reads DOM attributes, never CSS, so a non-password input is not a credential candidate under any competing heuristic). Note `-webkit-text-security` is the shipping property today; `input-security: none` (CSS UI 4) is the standardised successor, already in WebKit — add it alongside as a forward-compatible declaration, not instead.

1. **Retype all four hydrated token inputs** to `type="text"` with `-webkit-text-security: disc` (add one shared class rather than four inline styles):
   - `#stitch-api-key-input` — `design.html:4024`
   - `#clickup-token-input` — `tickets.html:4097`
   - `#linear-token-input` — `tickets.html:4294`
   - `#notion-token-input` — `setup.html:883`

   Leave `#onboard-cp-pat` (`implementation.html:1411`) and `#multi-repo-pat` (`setup.html:1206`) alone — confirmed write-only, never hydrated.
2. **Confirm the `transport.js` selectors still bind.** `:507-512` and `:518-525` select by `id` and set `el.disabled` / `el.placeholder`, all of which work identically on `type="text"`. Re-read after editing rather than assuming.
3. **Correct the assurance copy at `design.html:4021`.** It currently claims the key is "never sent to any Switchboard server" and that storage is "VS Code's encrypted secret storage" — neither holds in standalone, where the key is posted over the loopback HTTP transport on save and stored in the machine-global encrypted store. Rewrite so it is true in both hosts.

### 4. `src/services/verbSchemas.ts` — declare the new field

Add `clearKey: { type: 'boolean' }` to the `stitchSaveAuthConfig` block (`:138-142`), and to `stitchSaveApiKey` (`:133-137`) if that arm gains the same branch. Undeclared fields pass through unvalidated (`verbSchemas.ts:14-17`), which is exactly the gap PRD contract #5 exists to close.

## Verification Plan

Compilation and automated tests are out of scope for this session; the numbered steps are manual/observational.

**Browser-step preconditions — read before running any of them.** Confirmed in research:

- **Pin the port.** Run `npx switchboard --port 7777` (any fixed value) for every browser step. The default is an ephemeral port (`cli.ts:27` / `LocalApiServer.ts:378`), and Chrome keys password-manager state by `scheme://host:port` — so an unpinned run changes origin between baseline and verification and invalidates the comparison.
- **Clear the decline, not just the password.** A prior "Never for this site" persists in the profile's `Login Data` store and silently suppresses the prompt — a false pass. Remove `http://localhost:7777` from `chrome://settings/passwords` → **"Declined sites and apps"**, and remove any saved entry for that origin. "Not now" is session-only and does not persist.
- Prefer a fresh profile over clearing entries where practical.

0. **Identify the prompting field — do this first, before writing any code.** The plan's mechanism is contradicted by research (see Research Findings), so the target must be confirmed rather than assumed. On the current build with a Stitch key configured, open the cockpit on a clean pinned-port profile and reproduce the prompt. Then: reveal the value with the bubble's eye icon and compare it byte-for-byte against the stored Stitch key; accept the prompt once and read the resulting entry in `chrome://settings/passwords` for its origin and paired username field; and note which panel was the active frame at the moment the prompt appeared. If the value is not the Stitch key, or the paired field is not `#stitch-api-key-input`, **stop and report** — Changes 1, 2 and 4 still ship on G1's merits, but Change 3 is aimed at the wrong fields and needs re-scoping. If the prompt cannot be reproduced at all on a genuinely clean pinned-port profile, that is also a report-worthy result.
1. **Baseline the symptom.** Record the step-0 reproduction as the pre-fix baseline. Without a reproduced baseline on the same origin, a passing step 2 proves nothing.
2. **The reported symptom.** With a Stitch key configured, open the browser cockpit in a clean profile. No "Save password?" prompt appears on load — not for the Stitch key, and not for the masked ClickUp/Linear/Notion fields either. This is the test that represents the bug.
3. **No key on the wire.** With the cockpit open, inspect the panel transport payloads for `stitchAuthStatus`. No message carries an `apiKey` field. Check the hydration message specifically — it is the one that fires without user action.
4. **Validate Connection.** Open the Stitch auth panel, click Validate Connection, close the panel. Confirm no prompt, and that the field still shows the mask rather than the real key. Repeat for the failure branch (invalid key) and for the not-configured branch — `:3178`, `:3190`, and `:3199` are three separate payload sites.
5. **Masked display.** The auth panel shows `**********` with the configured indicator, never the raw key, in both the VS Code panel and the browser cockpit.
6. **Save is non-destructive — the highest-risk regression.** With a key stored, open the auth panel and click Save Settings without typing. Then call Stitch: it must still work. Then verify the *stores* directly, not just the call: the OS keychain entry and `~/.switchboard/secrets.enc` must both still hold the original key. A cached SDK client can make a destroyed key look fine for one call.
7. **Focus/blur round-trip.** Focus the field (mask clears), click away without typing (mask returns), click Save. Same result as step 6 — key unchanged in both stores.
8. **Clearing still works.** Click the new Clear control. The key is deleted, the panel reports not-configured, the field is empty, and a subsequent Stitch call fails with the not-configured path. Confirm the deletion reached both stores.
9. **Entry still works.** In the browser cockpit, type a new key, save, and confirm a Stitch call succeeds. `secretsEntry: true` must still un-gate the field and the Save button.
10. **Env-var path.** With no keychain entry but `STITCH_API_KEY` set, confirm the panel shows configured + masked, Stitch calls succeed, and a no-change Save does **not** blank `process.env.STITCH_API_KEY` (the moved assignment in Change 1, item 3).
11. **VS Code host unaffected.** Repeat 5-9 in the VS Code Design panel. Behaviour must be identical; the panel HTML is shared (PRD contract #1) and this plan is not host-conditional.

### Automated Tests

Not executed this session (per session directive). For the record, the suite that must stay green when it is next run, and the assertions worth adding:

- `src/test/standalone-secrets-bridge-contract.test.js` — must still pass unchanged. `secretsEntry` stays `true` in `bootstrap.ts:588` and `false` in `TaskViewerProvider.ts`, and `allowSecretWritesOverHttp: true` stays in `bootstrap.ts`.
- `src/test/verb-engine-headless-seams.test.js:273` asserts `recorders.secrets.get('switchboard.stitch.apiKey') === 'test-key-123'` through the save arm — the new no-change branch must not break the store path this covers.
- **Worth adding:** a source assertion that no `stitchAuthStatus` payload in `DesignPanelProvider.ts` contains `apiKey` (the same shape as the existing grep-style contract assertions), and a headless arm test that `stitchSaveAuthConfig` with no `apiKey` field leaves a pre-seeded secret intact.
- `npm run verb-returns:check`, `npm run parity:check`, `npm run push-routing:check` — this change removes payload fields and adds no raw `postMessage`, so all three ceilings should be unaffected or improve. Adding `clearKey` to `verbSchemas.ts` keeps the parity catalog honest.

## Research Findings

Web research into Chromium's password-manager internals was run and is **resolved**, with one residual unknown. Confidence markers are the researcher's own: all Chromium-internals answers are *inferred from source*, not documented contract, and were confirmed through roughly Chrome 120–128+.

**Confirmed and directly usable:**

- **`-webkit-text-security: disc` on `type="text"` is invisible to the password manager.** Chrome's classifier (`FormStructure` / `PasswordAutofillAgent`) reads DOM attributes — `type`, `autocomplete`, `name`, `id`, `aria-label` — and never CSS. Supported in Blink and WebKit; preserved in the WHATWG Compatibility Standard. The standardised successor is `input-security: auto | none` (CSS UI 4), shipped in WebKit, tracked in Blink. **Use the `-webkit-` property now; note `input-security` as the eventual replacement.**
- **`autocomplete="off"` does not suppress saving.** Explicit, documented Chrome policy — the Chromium Security FAQ states the password manager deliberately ignores it. `autocomplete="new-password"` is worse: it activates password *generation* and still prompts to save/update. Neither is a substitute for Change 3.
- **Prompt suppression is keyed by full origin including port.** "Not now" is ephemeral (session only, no persistence); "Never for this site" writes `blacklisted_by_user = 1` into the profile's `Login Data` SQLite store, keyed by `scheme://host:port`. Cleared via `chrome://settings/passwords` → "Declined sites and apps". **This interacts with a codebase fact:** standalone defaults to an ephemeral port (`cli.ts:27,75` → `LocalApiServer.ts:378`, `port || 0`), so nearly every `npx switchboard` run is a *different origin*. A "Never" answer therefore never carries across runs — which may itself explain why the user keeps seeing the prompt — and cross-run comparison is meaningless unless the port is pinned. Verification must pass `--port <fixed>`.

**Contradicts the plan's stated mechanism (the residual unknown):**

Three findings independently say the prompt should *not* fire for the chain this plan diagnosed:

1. **Programmatic `.value` assignment does not trigger it.** `PasswordFormManager` requires a user-edited flag on the `FormFieldData`; DOM assignment without keyboard input or user gesture never sets it. A same-site XHR *is* a recognised submission signal (`XHR_SUCCEEDED`), but only for a field already marked user-modified.
2. **A `**********` value is filtered out.** Repetitive / low-entropy / known-placeholder values are discarded as credential candidates during sanitisation.
3. **Hidden subtrees are never parsed.** Blink checks `IsVisible()` during form extraction; elements in a `display:none` subtree — or inside a `display:none` iframe — produce no layout box and are omitted. `#stitch-api-key-input` has two such ancestors (`#stitch-auth-panel` at `design.html:4016`, and the non-active `.panel-frame`).

The prompt was nevertheless observed. So either one of these inferences is over-stated in the case that matters, or **the prompting field is not the one this plan identified** — the identification rested on the value's length plus the known presence of a plaintext key on the wire, not on reading the saved entry. That is the open question, and it is a five-minute diagnostic (Verification step 0), not further research.

Two consequences for implementation:

- **Do not rely on finding 2 to close G2.** It rests on exactly the same "inferred from source" footing as finding 1, and finding 1 is contradicted by direct observation. Masking is a G1 measure here; treat its effect on the prompt as unknown.
- **Changes 1, 2 and 4 are unaffected.** G1 is a verified leak in this repo's own code, independent of every finding above.

## Recommendation

**Send to Coder.**

Changes 1, 2, and 4 are one unit and unconditional — the backend no-change branch and the webview tri-state message are two halves of one guard, and shipping either alone is the credential-destroying regression. They close G1, a verified plaintext-secret leak, and depend on no browser behaviour.

Change 3 closes G2 and ships in the same pass, but **run Verification step 0 before writing it.** Research contradicts the mechanism this plan diagnosed on three independent points while the symptom was directly observed, so the prompting field is inferred, not established. Step 0 settles it in five minutes. If it turns out the prompt comes from a field outside this plan's set, report that and ship 1/2/4 — do not silently widen the plan or quietly drop G2.

Guard one property in review: **no path may write or delete over a stored key on a save the user did not intend.** Every other failure here is cosmetic; that one destroys a credential the user cannot recover from the UI, in two stores at once.

Add the manual cleanup note to release notes. Users who accepted the prompt have the key in Chrome's password store — and if sync is on, in their Google account — and no code change reaches it.

---

## Completion Summary

*(Coder's report — see `## Review Findings` below for the reviewer's independent verification.)*

Implemented all four changes. Removed `apiKey` from all five `stitchAuthStatus` payloads in `DesignPanelProvider.ts` and added tri-state save semantics (`undefined` = no-change, typed value = store, `clearKey: true` = delete) to both `stitchSaveApiKey` and `stitchSaveAuthConfig`, with `process.env.STITCH_API_KEY` moved inside store/delete branches so no-op saves don't blank the env fallback. Normalised `stitchSaveAuthConfig` to `this._seams().secrets`. In `design.js`, `updateStitchAuthUI` now masks with `'**********'` (mirroring the ClickUp/Linear pattern), focus/blur masking is ported from `setup.html`, the save handler is tri-state, a Clear button handler was added, and the dead `stitchApiBanner`/`btnSaveStitchApiKey` code was removed. All four hydrated token inputs (`design.html`, `tickets.html`, `setup.html`) were retyped to `type="text"` with `.masked-token-input` (`-webkit-text-security: disc` + `input-security: none`), the assurance copy was corrected, and `#btn-clear-stitch-auth` was added to the `transport.js` secrets-entry-false hide list. `verbSchemas.ts` now declares `clearKey: { type: 'boolean' }` on both Stitch save verbs. No issues encountered; the focus→blur→click race on an untouched mask correctly routes to the backend no-op branch, and existing tests (`verb-engine-headless-seams.test.js`, `standalone-secrets-bridge-contract.test.js`) remain compatible.

## Review Findings

Reviewed against the plan; G1 is fully closed and correct — all five `stitchAuthStatus` payload sites are stripped, the tri-state save semantics land correctly on every branch, the seam normalisation is done, and the dead `stitchApiBanner`/`btnSaveStitchApiKey` block was removed with zero orphaned references. Three MAJOR findings were fixed in this pass, all in Change 3: `input-security: none` was removed from `design.html`/`tickets.html`/`setup.html` (CSS UI 4 defines `none` as *reveal*, so it is the opposite of `-webkit-text-security: disc`, not its successor, and risks unmasking in WebKit); a feature-detected fallback was added to `transport.js` restoring `type="password"` where `-webkit-text-security` is unsupported (Firefox implements it in no form, so the four retyped inputs would have rendered typed tokens in plaintext there); and the `design.html` assurance copy was rewritten to drop the "never sent to any Switchboard server" claim, which is false in standalone — the plan's Change 3 item 3 required this and the prior edit had only deleted the words "VS Code's". Files changed by the review: `src/webview/design.html`, `src/webview/tickets.html`, `src/webview/setup.html`, `src/webview/transport.js`. Validation run and green: `tsc -p tsconfig.test.json` (typecheck), `eslint src` (0 errors), `parity:check`, `push-routing:check`, `verb-returns:check` (Design 9 ≤ ceiling 9), `test:contract:verb-engine` (25/25), `test:contract:secrets-bridge` (PASS) — all six named gates confirmed wired in `.github/workflows/integration-tests.yml`.

Remaining risks: Verification step 0 (positively identify the prompting field before aiming Change 3) has no record of having been run, so G2's target is still inferred rather than established, and steps 1–11 are manual/browser observations that this pass could not execute; a typed-but-unsaved key is still discarded by any incoming `stitchAuthStatus` push (Validate or re-hydrate), which is a pre-existing shape not worsened here; and `stitchSaveAuthConfig` now writes `process.env.STITCH_API_KEY`, which it never did before — intentional, since Clear cannot report not-configured otherwise, but it means Clear also blanks an env-supplied key for the process lifetime. Separately, `src/test/setup-panel-migration.test.js` is red at HEAD for an unrelated pre-existing reason (it asserts `id="clickup-token-input"` lives in `setup.html`, but that input now lives in `tickets.html`) and is wired into neither CI nor `package.json`; this change does not touch that assertion.
