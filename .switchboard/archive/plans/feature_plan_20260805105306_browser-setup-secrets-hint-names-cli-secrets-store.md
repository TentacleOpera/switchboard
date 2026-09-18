# Browser Setup/Tickets Panels: "Set This in the Editor" Hint Ignores the Encrypted Secrets Store

## Goal

Stop the extension-served browser panels telling the user their only option is to open VS Code, and make the encrypted secrets store a genuine second path for the editor host — so the hint the user reads is both clearer and true.

### Problem Analysis & Root Cause

When the browser board is served **by the VS Code extension**, every API-token input in the Tickets and Setup panels is disabled and annotated with this text (`src/webview/transport.js:534`):

> Keys are entered in the editor and used from there — open this workspace in VS Code to set it.

and each input's placeholder is rewritten to `Set this in the editor...` (`transport.js:530`). The gating block runs when the host advertises `secretsEntry === false` (`transport.js:496`) and covers `#clickup-token-input`, `#linear-token-input`, `#notion-token-input`, `#multi-repo-pat`, `#stitch-api-key-input`.

**The gating itself is correct and deliberate.** It is a security posture with a test pinning it (`src/test/standalone-secrets-bridge-contract.test.js:290-315`):

- Extension host: `secretsEntry: false` (`TaskViewerProvider.ts:2254`) and **no** `allowSecretWritesOverHttp`, because the extension's `getAuthToken()` returns nothing, which puts `_checkAuth` into loopback-trust mode (`LocalApiServer.ts:527-530`). Opening HTTP secret writes there would let any local process store credentials.
- Standalone host: `secretsEntry: true` (`bootstrap.ts:506`) and `allowSecretWritesOverHttp: true` (`bootstrap.ts:1514`), safe only because standalone authenticates every request with `sb_session` (`SameSite=Strict`).

So the *disabled inputs* stay. What is wrong is the **claim the hint makes**, and — more importantly — the fact that the claim is currently accurate for the wrong reason.

There **is** an encrypted secrets store, and there **is** a CLI to write it:

- `npx switchboard secrets set clickup <token>` → `StandaloneHostSecrets.store()` into `secrets.enc` under the machine-global state home (`cli.ts:174`, `hostServices.ts:131`, alias table at `cli.ts:32-38`).
- Files are written `0600` with atomic replace, git-ignored by name via `WorkspaceExcludeService.TARGETED_RULES`, and legacy per-workspace stores are migrated to `*.migrated.bak` (`standalone-secrets-bridge-contract.test.js` sections 1, 7, 9).

But the extension host's relationship to that store is **one-way, write-only** (`src/extension.ts:650-702`):

```js
const syncSecretToGlobalStore = async (key, allowDelete) => {
    if (!globalSecrets || !MIRRORED_SECRET_KEYS.has(key)) { return; }
    const val = await context.secrets.get(key);      // reads the KEYCHAIN
    if (val && val.trim().length > 0) { await globalSecrets.store(key, val); }
    else if (allowDelete) { await globalSecrets.delete(key); }
};
```

`globalSecrets` is referenced in exactly five places in `extension.ts` (declaration, construction, and the three lines above) — it is **never read**. So a token set with `npx switchboard secrets set` is invisible to the extension, and the hint's "open VS Code" instruction is, today, the literal truth: it is the only path that works for the editor host.

**Root cause:** the mirror was built for one direction (keychain → file, so standalone can reuse an editor user's tokens) and the reverse direction was never implemented, so the extension has no read-through to the store the CLI writes. The hint text then hardcoded that limitation as if it were the design, naming a UI location instead of the two mechanisms that actually exist.

### What this plan changes

1. **Add the read-through**: on activation, for each mirrored key the keychain does **not** hold, import the value from the encrypted store into `context.secrets`. This makes `npx switchboard secrets set` work for the editor host, and makes a token entered in the standalone browser Setup panel visible after the user next opens VS Code.
2. **Rewrite the hint** to name both real paths and stop implying the browser is a dead end.

## Metadata

- **Complexity:** 5
- **Tags:** frontend, backend, security, ux
- **Project:** Browser Switchboard
- **Files touched:** `src/extension.ts`, `src/webview/transport.js`, `src/test/standalone-secrets-bridge-contract.test.js`
- **Risk:** Medium — touches credential flow. The existing write-only mirror has a documented history of destroying tokens (three distinct regressions recorded in the contract test's header), so the new read direction must not create a resurrection or clobber path.

## User Review Required

None. The gating stays (a security contract with a test behind it); the copy becomes true and the CLI path becomes real. Neither is a product decision.

## Complexity Audit

### Routine
- Replace two strings in `transport.js` with accurate copy.

### Complex / Risky
- **Delete-resurrection.** The `onDidChange` listener propagates deletes into the store (`extension.ts:698-702`). If a delete ever fails (store unavailable, passphrase missing), the next activation's import would restore the token the user just cleared. Guard: import **only** when the keychain has no value for that key, and never import on a key that the *current session* deleted.
- **Ordering against the existing write-only sweep.** The activation backfill (`extension.ts:690-695`) writes keychain → store with `allowDelete: false`. The import must run **before** it, or the sweep sees an empty keychain, writes nothing, and the import is a no-op race. Both must be sequenced, not fired as two detached promises.
- **Decrypt failures must not condemn the store.** The contract test's regression #3 records that a decrypt failure once renamed the store to `.corrupt-*.bak`, and that one process lacking `SWITCHBOARD_MASTER_PASSPHRASE` was enough to destroy a healthy store shared with standalone and the CLI. The import path must swallow read failures and log, never rename or delete.
- **Activation must not be able to fail.** `globalSecrets` construction is already wrapped because `stateFile()` throws in an unsandboxed test process (`extension.ts:658-666`). The import inherits that guard.

## Edge-Case & Dependency Audit

1. **Keychain already holds the key.** Import skips it. The keychain is authoritative for the editor host; the store is the cross-host carrier.
2. **Store holds an empty/whitespace value.** Treated as absent — never write an empty secret into the keychain (that would trip the `onDidChange` delete propagation and wipe the store entry).
3. **Store unreadable** (missing `.master-key`, no passphrase, decrypt error). Log once, skip the import, leave the file untouched. No rename, no delete.
4. **Key not in `MIRRORED_SECRET_KEYS`.** Ignored, exactly as the write path does.
5. **User clears a token in VS Code.** `onDidChange` fires with an empty read and `allowDelete: true` → store entry deleted. Because the import only fills *absent* keychain entries and runs at activation (not on change), the cleared token does not come back within the session; on the next activation the store entry is already gone, so it does not come back at all. This is the property to test.
6. **`secretsEntry` stays `false` for the extension host.** No change to `TaskViewerProvider.ts:2254`, no `allowSecretWritesOverHttp` in the extension path — both pinned by the contract test, both correct.
6a. **Default caps block in `headlessPanelHtml.ts:37` also sets `secretsEntry: false`.** Both hosts override it (`TaskViewerProvider.ts:2254` for the extension, `bootstrap.ts:506` for standalone). Confirm the standalone override is what `transport.js` actually receives when `npx switchboard` serves the panels; do not change the safe default.
6b. **Import fires `onDidChange` — invariant, not bug.** `context.secrets.store(key, fromStore)` inside the import triggers the existing listener (`extension.ts:697-702`), which calls `syncSecretToGlobalStore(key, true)` with `allowDelete: true`. Today this is a harmless round-trip (it reads back the value just written and re-stores it). It MUST stay harmless: the import and the listener share the invariant that a store-write never produces an empty read. If the listener is ever refactored, this path becomes a potential delete — record the invariant here so the contract test can pin it.
7. **Inputs stay disabled in the extension-served browser.** The change is copy plus a local import path; nothing opens HTTP secret writes.
8. **Standalone is unaffected.** It already advertises `secretsEntry: true`, so `transport.js`'s gating block never runs there and its inputs are live.
9. **Copy must not promise an instant effect.** An import that happens at activation means a token set via the CLI while VS Code is running is picked up on the next window reload, not immediately. The hint must say so rather than implying live pickup.
10. **The hint is injected into five inputs across two panels** (`tickets.html:4082`, `:4288`, `setup.html`, plus `#multi-repo-pat` and `#stitch-api-key-input`). One string change covers all of them — do not fork per-provider copy.
11. **Neighbouring static copy is now half-true.** `tickets.html:4085` and `:4291` say *"Your key is stored in VS Code's encrypted secret storage (your OS keychain)"*. That remains correct for the editor host; leave it, and let the injected hint carry the browser-specific guidance. Do not duplicate the storage explanation.

## Dependencies

None — no external session dependencies. The encrypted store, the CLI `secrets set` command, and the write-only mirror are all merged, tested code that this plan reads and extends in place.

## Adversarial Synthesis

Key risks: the new import fires the existing `onDidChange` delete-propagation listener (a harmless round-trip today, but an undocumented invariant that a future listener refactor could turn into a delete path); a wrong sequencing against the write-only backfill sweep would make the import a no-op race; and any read-failure handling harsher than log-and-skip repeats regression #3 (condemning a healthy shared store). Mitigations: fill-only semantics with the keychain authoritative, import strictly before the backfill sweep in one ordered IIFE, swallowed read failures with no rename/delete, and contract-test assertions pinning fill-only, ordering, and the unchanged HTTP-write gate.

## Proposed Changes

### `src/extension.ts`

Add the read direction beside the existing mirror (after `syncSecretToGlobalStore`, around line 688), and sequence it ahead of the backfill sweep:

```ts
/**
 * Import from the machine-global store into VS Code SecretStorage.
 *
 * The mirror was write-only (keychain → file), so a token stored with
 * `npx switchboard secrets set …` or entered in the standalone browser Setup
 * panel was invisible to the editor host — which is why the browser panels'
 * hint could only ever say "open VS Code".
 *
 * Fill-only, never overwrite: the keychain is authoritative here. Overwriting
 * would let a stale file value clobber a token the user just entered in the
 * Setup panel, and combined with the onDidChange delete-propagation it would
 * resurrect tokens the user deliberately cleared.
 *
 * Read failures are swallowed. A missing .master-key or absent
 * SWITCHBOARD_MASTER_PASSPHRASE must never rename, delete, or otherwise
 * condemn a store that standalone and the CLI also depend on.
 */
const importSecretFromGlobalStore = async (key: string) => {
    if (!globalSecrets) { return; }
    try {
        const existing = await context.secrets.get(key);
        if (existing && existing.trim().length > 0) { return; }   // keychain wins
        const fromStore = await globalSecrets.get(key);
        if (!fromStore || fromStore.trim().length === 0) { return; }
        await context.secrets.store(key, fromStore);
        outputChannel?.appendLine(`[Switchboard] Imported ${key} from the machine-global secrets store`);
    } catch (err) {
        console.warn(`[Switchboard] Secrets import failed for ${key}:`, err);
    }
};
```

Replace the detached backfill IIFE (lines 689-695) with an ordered sequence:

```ts
// Import BEFORE the write-only backfill: the sweep reads the keychain, so if it
// ran first it would see nothing to mirror and the import would be a no-op race.
(async () => {
    for (const key of MIRRORED_SECRET_KEYS) { await importSecretFromGlobalStore(key); }
    for (const key of MIRRORED_SECRET_KEYS) { await syncSecretToGlobalStore(key, false); }
})().catch(err => console.warn('[Switchboard] Secrets activation sweep error:', err));
```

Leave the `onDidChange` listener (lines 697-702) exactly as it is — it is the only path allowed to propagate deletes.

### `src/webview/transport.js`

Replace the placeholder and hint inside the `secretsEntry === false` block (lines 528-537):

```js
el.disabled = true;
el.placeholder = 'Set in VS Code, or via the switchboard CLI...';
if (el.parentNode && !el.parentNode.querySelector('.host-secrets-hint')) {
    const hint = document.createElement('div');
    hint.className = 'host-secrets-hint';
    hint.style.cssText = 'font-size: 11px; color: var(--text-secondary, #888); margin-top: 4px; font-style: italic;';
    // Two real paths, not one dead end. This host (the VS Code extension) does
    // not accept secret writes over HTTP by design — its auth token is empty,
    // so every loopback caller would be trusted. Entering the key in the editor
    // or writing it to the machine-global encrypted store both work; the store
    // is imported into the keychain when the extension next activates.
    hint.textContent = 'Read-only here. Set this key in the VS Code Setup panel, '
        + 'or run: npx switchboard secrets set <clickup|linear|notion|stitch> <token> '
        + '— then reload the VS Code window to pick it up.';
    el.parentNode.appendChild(hint);
}
```

### `src/test/standalone-secrets-bridge-contract.test.js`

Extend section 8 (the HTTP secret-write gate) with the properties this plan adds, so the read direction cannot regress into a resurrection bug:

```js
// ── 10. The mirror reads as well as writes, and cannot resurrect a delete ──
{
    const extSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');
    assert.ok(/importSecretFromGlobalStore/.test(extSrc),
        'the editor host must import from the machine-global store, or `secrets set` is invisible to it');
    // Fill-only: an unconditional store() would clobber a freshly-entered token
    // and, with delete-propagation, resurrect cleared ones.
    assert.ok(/if \(existing && existing\.trim\(\)\.length > 0\) \{ return; \}/.test(extSrc),
        'the import must skip keys the keychain already holds');
    // Ordering: import must precede the write-only backfill sweep.
    assert.ok(extSrc.indexOf('importSecretFromGlobalStore(key)') < extSrc.indexOf('syncSecretToGlobalStore(key, false)'),
        'import must run before the backfill sweep');
    // The gating itself must NOT be relaxed by this change.
    assert.ok(!extSrc.includes('allowSecretWritesOverHttp'), 'the editor host must not open HTTP secret writes');
}
```

Also assert the copy no longer names the editor as the sole path:

```js
{
    const t = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'transport.js'), 'utf8');
    assert.ok(!/open this workspace in VS Code to set it/.test(t),
        'the secrets hint must name the CLI store path, not only the editor');
    assert.ok(/switchboard secrets set/.test(t), 'the hint must name the CLI command');
}
```

## Verification Plan

1. **Build & tests:** *Deferred per dispatch directive — no project compilation step and no automated test runs in this verification plan.* The contract-test assertions added under Proposed Changes are validated by the coder's normal gates and CI, not by this plan's verification.
2. **UAT — copy.** Open the extension-served browser board → Tickets → ClickUp setup. The token input is still disabled, its placeholder reads `Set in VS Code, or via the switchboard CLI...`, and the italic hint names `npx switchboard secrets set` and the reload requirement. Repeat for Linear, Notion, Stitch and the multi-repo PAT.
3. **UAT — CLI → editor import.** With no ClickUp token in the keychain: run `npx switchboard secrets set clickup pk_TEST`, then reload the VS Code window. The Setup panel shows ClickUp as configured, and the Tickets panel can fetch (confirms the value reached `context.secrets`, not just the file).
4. **UAT — keychain wins.** Set `clickup` to `pk_EDITOR` in the VS Code Setup panel, then write `pk_FILE` into the store with the CLI, then reload the window. The effective token stays `pk_EDITOR` — the import must not overwrite.
5. **UAT — delete is not resurrected.** With a token present in both places, clear it in the VS Code Setup panel (which propagates the delete to the store via `onDidChange`), then reload the window twice. It must stay cleared.
6. **UAT — store unreadable.** Temporarily rename `.master-key` in the state home and reload the window. The extension activates normally, logs one import-failure line per key, leaves `secrets.enc` and its backups untouched (`ls` the state home to confirm no `.corrupt-*.bak` appears), and existing keychain tokens keep working.
7. **UAT — standalone unchanged.** `npx switchboard`: the Setup panel's token inputs are enabled, no hint text is injected, and applying a token still works over HTTP.
8. **Static check:** `grep -rn "open this workspace in VS Code to set it" src/` returns nothing; `grep -n "globalSecrets" src/extension.ts` now shows a read call alongside the writes.

## Review Findings

Cleanest of the three subtasks: no CRITICAL or MAJOR. One MINOR fixed — `importSecretFromGlobalStore` omitted the `MIRRORED_SECRET_KEYS.has(key)` gate that the write direction carries (plan edge case 4); no live defect since the only call site iterates that set, but an import path that would pull *any* key out of a machine-global store into the workspace keychain should not depend on its caller, so the guard was added to `src/extension.ts`. One NIT left deliberately: the uniform hint tells `#multi-repo-pat` users to run `npx switchboard secrets set`, but that input is a transient clone PAT (`setup.html:1206`) never written to SecretStorage and absent from the alias table — edge case 10 explicitly forbids forking per-provider copy, so the copy stands. Verified clean: the import's `store()` *does* fire `onDidChange` because the listener is registered synchronously before the async IIFE's first `await` resolves (edge case 6b holds as an invariant, and the round-trip re-stores the same non-empty value through a synchronous atomic-rename write, so nothing interleaves); a read failure cannot condemn the store (`_candidateKeys()` empty ⇒ `_unreadable`, no rename, no delete); import-before-backfill ordering is real and pinned; and `secretsEntry: false` plus the absence of `allowSecretWritesOverHttp` on the extension host are unchanged. `test:contract:secrets-bridge` PASSes and is wired in CI at `integration-tests.yml:230`. Remaining risk: the delete-not-resurrected property is pinned only as source text, so UAT steps 4–6 (keychain-wins, delete survives two reloads, unreadable store) still carry the real assurance.
