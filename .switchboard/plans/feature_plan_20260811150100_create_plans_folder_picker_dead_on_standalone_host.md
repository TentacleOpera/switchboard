# Create Plans is unreachable on the standalone host — the folder picker is a stubbed native dialog

## Goal

Make the Create Plans docs-zip flow usable from the browser cockpit by giving it a folder source that does not depend on a native OS dialog, and make the pane state its own availability honestly rather than presenting a button that can never proceed.

This plan also **owns the host-capability declaration** for the whole "Standalone Host: Panel Flows Blocked by Stubbed Native Dialogs" feature: it introduces `supportsOpenDialog` **and** `supportsInteractiveDialogs` on the UI seam in one place, so the sibling cloud-database-preset plan only consumes a flag that already exists. See **Dependencies** below.

## Goal — problem analysis and root cause

### What this feature is

Create Plans (Planning panel, wired in `src/webview/connections.js:370-412`) bundles a folder of documentation into a zip the user uploads to an external AI, which returns plans they paste back into Switchboard. The source folder is chosen by the user — Switchboard deliberately does not decide the doc set (`src/services/PlanningPanelProvider.ts:3061-3062`).

### The defect

The folder is chosen through a **native OS dialog**:

```ts
// src/services/PlanningPanelProvider.ts:3060-3074
case 'createPlansPickFolder': {
    const picked = await this._seams().ui.showOpenDialog({
        openLabel: 'Zip this folder', canSelectFiles: false, canSelectFolders: true, canSelectMany: false
    });
    const folder = picked && picked.length > 0 ? picked[0] : '';
    if (folder) { this.postMessageToWebview({ type: 'createPlansFolderPicked', folder }); }
    break;
}
```

On the standalone host that dialog does not exist. In the webview, `chosenFolder` stays empty (`src/webview/connections.js:387`) and the Zip button's guard `if (!chosenFolder) { return; }` (line 405) short-circuits every click. The entire Create Plans zip half of the feature is dead on the browser cockpit — which is why the `revealFileInOS` call further down the `createPlansDownloadZip` arm is not merely a no-op there, it is **unreachable**: execution never gets to it.

This is the standalone-parity shape: the verb is registered and delegates correctly, so every wiring check passes, while the host capability underneath it is a stub.

### Correction — which stub actually runs, and what the user actually sees

> **Superseded:** "On the standalone host that dialog does not exist: `src/standalone/hostServices.ts:432` — `showOpenDialog: async () => undefined`; `src/standalone/vscodeShim.ts:136` — `showOpenDialog` returns `headlessReject('showOpenDialog')`. So `picked` is `undefined`, `folder` is `''`, the `if (folder)` guard fails, and **no message is ever posted back**. … No error, no explanation, no fallback."
> **Reason:** Two errors of fact, both load-bearing for the fix's shape. (1) `createHeadlessHostSeams` in `src/standalone/hostServices.ts` is **not wired**. Its own docstring says so (`src/standalone/hostServices.ts:356-370`: "⚠️ NOT CURRENTLY WIRED"), and `src/standalone/bootstrap.ts:659` injects `createVscodeHostSeams(workspaceRoot, secretStorage)` into every provider instead. A `supportsOpenDialog: false` written into that bundle would be dead code and the picker would keep rendering on standalone — the fix would silently not work. (2) On the live path the seam is `VscodeHostUI.showOpenDialog` (`src/services/hostSeams.ts:406`) calling `vscode.window.showOpenDialog`, which the standalone webpack alias resolves to `src/standalone/vscodeShim.ts:136` — that **rejects**, it does not resolve to `undefined`. The arm has no `try`/`catch`, so the rejection propagates out of `_handleMessage` → `handleServiceVerb` → `LocalApiServer._handlePlanningVerb`'s catch (`src/services/LocalApiServer.ts:2068-2072`) → HTTP 500 with `{success:false,error}` → `transport.js` renders a red toast (`src/webview/transport.js:381-390`).
> **Replaced with:** The live standalone failure is a **rejected promise surfaced as a misleading red toast**, not a silent no-op. The toast reads *"vscode.window.showOpenDialog is not available in the headless standalone host. Run the equivalent flow from the VS Code extension, or set the token directly via the StandaloneHostSecrets file store"* (`src/standalone/vscodeShim.ts:103-107`) — a generic message about **tokens**, which have nothing to do with picking a folder. The flow is still dead and the user is still given no way forward; the difference is that the fix must (a) declare the capability at `createVscodeHostSeams` / `bootstrap.ts`, **not** in the unwired `hostServices.ts` bundle, and (b) also stop the picker arm from throwing an off-topic error on a host that has no dialogs.

### The second defect this plan must close: the validation is bypassable where it matters

`createPlansSetFolder` validating a typed path does **not** make the flow safe, because the folder the server actually reads is the one the webview sends to `createPlansDownloadZip`:

```ts
// src/services/PlanningPanelProvider.ts:3081-3088
const folder = typeof msg.folder === 'string' ? msg.folder.trim() : '';
…
const sources = await this._collectFolderDocSources(folder);   // recursive read, unvalidated
```

Over HTTP, `createPlansDownloadZip` is a POST any client can make directly with any `folder` — the setter is not on the path. Validating only the setter produces a plan that **passes its own security tests while leaving the hole open**. The validation must live where the filesystem is touched.

## Metadata

- **Complexity:** 6
- **Tags:** bugfix, frontend, backend, ux, security, reliability
- **Project:** Browser Switchboard

## User Review Required

None. Every decision below is made in the plan: typed paths are constrained to the open workspace roots, the native picker keeps its unrestricted behaviour in the editor, validation is enforced in `createPlansDownloadZip` (not only in the setter), and the capability flags are declared at the standalone composition root.

## Complexity Audit

### Routine

- A text input, a `Use folder` button, and a conditional render in `src/webview/connections.js`.
- A new verb arm that trims, expands, resolves and validates a path string.
- Adding two boolean members to an existing interface and its one concrete implementation.

### Complex / Risky

1. **Path validation is a security boundary, and it must sit on the read path.** `_collectFolderDocSources` walks the folder recursively, so an unvalidated path is an arbitrary-directory read reachable over the local API. Validation must: expand `~`, resolve relative input against the workspace root, resolve the real path (`fs.realpathSync.native`, defeating symlink escapes and Windows 8.3 / mapped-drive aliases), require it to exist and be a directory, and require it to sit within an allowed root. **It must be applied in `createPlansDownloadZip` as well as in `createPlansSetFolder`** — see the second defect above.

   The codebase's existing traversal guards — `_buildLocalAssetUrl` (`src/services/TicketsPanelProvider.ts:483-501`) and `downloadAttachment` (`src/services/TaskViewerProvider.ts`) — use realpath-then-**prefix-check**. This plan follows their *shape* (resolve first, then contain) but **not** their comparison: a `startsWith` prefix check is bypassable on Windows via a cross-drive path, and case-blind on macOS. Use `_isContainedIn` as written below. See "Path containment: resolved" for the evidence and for why the existing sites are left alone here.

2. **Deciding the allowed root.** The editor path lets the user pick *any* folder via the OS dialog, so a typed path is not a privilege escalation in the editor host. But the browser cockpit may be reached from another machine, where "any folder on the server" is a materially different exposure. **Decision: restrict typed paths to within the workspace roots.** This covers the real use case (bundling the project's own docs) and keeps the remote-viewer case safe. The native picker keeps its existing unrestricted behaviour in the editor — that is an explicit, local user action.

   **Consequence that must be handled, not discovered at runtime:** if `createPlansDownloadZip` enforces the same workspace-root constraint unconditionally, it breaks the editor host, where the user is *allowed* to pick an outside folder through the dialog. The zip arm must therefore accept a folder that is **either** inside a workspace root **or** one the picker itself returned this session. See Proposed Changes §3 for the mechanism (a server-side set of picker-approved paths — never a client-supplied "I was picked" flag, which the client could forge).

3. **Capability detection, and where it is declared.** The webview must know whether a native picker is available so it can render the right control. Do not sniff the user agent. Have the host answer it — but note that **both** hosts construct their seams with `createVscodeHostSeams`, so a constant `true` on `VscodeHostUI` is wrong. The flag has to be overridable at the composition root that knows it is headless: `src/standalone/bootstrap.ts`.

   **Landmine — do not copy the existing override idiom verbatim.** `bootstrap.ts:665-668` overrides the watcher seam with `headlessSeams.watcher = { ...headlessSeams.watcher, watchFolder: createStandaloneFolderWatcher }`. `VscodeHostFileWatcher` is a **class** (`src/services/hostSeams.ts:552`), and spreading a class instance copies only own enumerable properties — its prototype methods are lost. `watchPattern`/`watchFile` on the standalone watcher seam are therefore `undefined`, not "stubbed" as the comment there claims. That is latent today (no standalone caller), but `VscodeHostUI` has twelve methods and the standalone host calls several of them (`showTemporaryNotification`, `showErrorMessage`) constantly. **A `headlessSeams.ui = { ...headlessSeams.ui, supportsOpenDialog: false }` would blank the entire UI seam and crash the host.** Use the typed constructor-option route in §4 instead.

**Migration:** none. No persisted state, no settings key, no schema. The typed-path input is new UI over an existing verb, and the new verb writes nothing.

## Edge-Case & Dependency Audit

### Security

| Case | Required behaviour |
| --- | --- |
| Path outside the workspace roots, typed (standalone) | Rejected with an explicit message naming the constraint, not a silent no-op. |
| Symlink inside the workspace pointing outside an allowed root | Rejected — validation resolves with `realpathSync` **before** the prefix check. |
| `createPlansDownloadZip` POSTed directly with an arbitrary `folder` | Rejected by the same validation. The setter is not a gate; the read path is. |
| Sibling directory sharing a prefix (`/repo-evil` vs `/repo`) | Rejected — containment is `path.relative` + `!isAbsolute` + no `..` prefix, which has no prefix-overlap failure mode. |
| Case-variant path on macOS (`/USERS/x/repo/docs`) | Accepted only if it resolves inside a root — the comparison case-folds on `darwin`. `realpathSync` does **not** canonicalise case there, so a case-sensitive compare would reject a legitimate path and, worse, make containment inconsistent for two spellings of one directory. |
| Case-variant path on Linux | `/app/Uploads` and `/app/uploads` are **distinct directories**. Comparison must stay case-sensitive; folding here would be a hole, not a convenience. |
| Windows cross-drive path (`D:\etc` against root `C:\repo`) | Rejected — `path.relative` returns an absolute `D:\etc`, which does not start with `..`; the `isAbsolute` clause is what catches it. |
| Windows 8.3 short name (`C:\PROGRA~1\…`) or mapped network drive | Expanded/resolved by `fs.realpathSync.native` before comparison. |
| Child equals the workspace root exactly | Accepted — `path.relative` returns `''`, which the check allows explicitly. |
| Editor host picking an outside folder via the dialog | Still allowed. The zip arm accepts it via the picker-approved set, not via a client-supplied flag. |

### Side Effects

| Case | Required behaviour |
| --- | --- |
| Editor host | Native picker unchanged. The typed input is not shown. |
| Standalone host | Typed-path input shown; native picker button hidden (not shown-and-broken). |
| Native picker invoked on a host without one (e.g. a stale page) | The arm must catch the seam rejection and return `{success:false, error}` naming the real constraint — never let the `showOpenDialog is not available … set the token directly` message reach the user. |
| Path does not exist | Verb returns a specific error: `Folder not found: <path>`. Never a generic failure. |
| Path is a file, not a directory | Rejected with `Not a folder: <path>`. |
| Relative path typed (`./docs`) | Resolved against the workspace root, then validated like any other. |
| `~` typed | Expanded before resolution. Must not be passed through as a literal directory name. |
| Path with trailing slash / whitespace | Trimmed and normalised before validation. |
| Folder exists but contains no `.md`/`.txt` | Existing behaviour — `That folder has no docs (.md / .txt) to bundle`. Unchanged. |
| Empty input, Zip clicked | Button stays disabled, as today. |
| Windows path typed on a posix host or vice versa | Validation fails naturally on existence; the error names the path. No special-casing. |
| `showOpenDialog` later implemented for standalone | Flip `supportsOpenDialog` at the bootstrap override; the native button returns with no further change. |

### Race Conditions

- The picker-approved set is per-provider-instance and additive; a second pick before the first zip completes simply adds a second entry. No ordering hazard.
- `createPlansCapabilities` is folded into the existing `createPlansState` push (§2), so it cannot arrive before the pane is wired — `createPlansInit` is the pane's own first message.

## Dependencies

- `sess_none — no new package or service dependencies.` Reuses `_resolveWorkspaceRoot`, `_getWorkspaceRoots` and the existing `_collectFolderDocSources`. `os` and `path` are already imported in `PlanningPanelProvider.ts` (lines 17-18); `fs` there is `stateFs` (line 20), which spreads `node:fs` and therefore exposes `realpathSync`/`statSync`.
- **This plan is the seam owner for its feature.** It introduces both `supportsOpenDialog` and `supportsInteractiveDialogs`. The sibling plan *"Cloud database presets silently abort on the standalone host"* consumes `supportsInteractiveDialogs` and must land **after** this one — it will not compile before the flag exists.
- The sibling plan *"Create Plans: disclose the docs-zip path"* must also land after this one: until the picker is replaced, the Create Plans pane cannot be reached on the browser cockpit to verify the disclosure through the real UI.

**Out of scope**, flagged rather than folded in:

- Disclosing the built zip's path — tracked in its own plan. This plan unblocks *reaching* the zip build; that one makes its result findable.
- `showOpenDialog` is stubbed for every other caller in the codebase too. A host-wide replacement (a server-side directory browser) would fix all of them at once and is the better long-term answer; it is a much larger piece of work and is not attempted here.
- The `{ ...classInstance }` seam-override bug in `bootstrap.ts:665-668` (watcher). Named in the Complexity Audit so this plan does not reproduce it; fixing the watcher itself belongs elsewhere.
- `VscodeHostCommands.executeCommand`'s blanket `catch { return undefined; }` (`src/services/hostSeams.ts:333-335`).

## Adversarial Synthesis

**Key risks:** (1) declaring the capability in the unwired `createHeadlessHostSeams` bundle, which compiles, tests green, and does nothing on the real host; (2) validating the typed-path setter while `createPlansDownloadZip` still accepts an arbitrary folder over HTTP — a security fix that passes its own tests and leaves the hole open; (3) a `startsWith(root + sep)` containment check, which the repo's existing guards use but which a Windows cross-drive path walks straight through and which is case-blind on macOS; (4) overriding the UI seam by spreading a class instance, which silently drops every prototype method. **Mitigations:** the flags are declared on `HostUI` and set through a typed `createVscodeHostSeams` capability option applied at `bootstrap.ts:659`; validation is extracted to one private helper called from **both** verb arms; containment is `path.relative` + `!isAbsolute` + no-`..`, case-folded on `darwin`/`win32` only, over `realpathSync.native`; the bootstrap override passes options into the constructor rather than spreading the instance, and a test asserts the standalone seam still answers `showTemporaryNotification`.

## Proposed Changes

### 1. `src/services/hostSeams.ts` — declare the capability on the seam

Two flags, not one. They are genuinely separable: a host could implement a two-choice message modal (a webview round-trip) long before it implements a server-side directory browser, and the two stubs even fail differently today — `showWarningMessage`/`showInformationMessage` resolve to `undefined` (`src/standalone/vscodeShim.ts:133-134`) while `showOpenDialog` rejects (line 136).

```ts
export interface HostUI {
    /** True when the host can show message dialogs with choice buttons and get an answer back. */
    readonly supportsInteractiveDialogs: boolean;
    /** True when the host can show a native file/folder open dialog. */
    readonly supportsOpenDialog: boolean;
    showWarningMessage(message: string, ...items: string[]): Promise<string | undefined>;
    // …existing members unchanged…
}

export interface HostUiCapabilities {
    supportsInteractiveDialogs?: boolean;
    supportsOpenDialog?: boolean;
}

export class VscodeHostUI implements HostUI {
    readonly supportsInteractiveDialogs: boolean;
    readonly supportsOpenDialog: boolean;
    // Defaults describe the EDITOR host, which is what this class is. The standalone
    // composition root overrides them — see bootstrap.ts. Do not infer the host from a
    // user-agent string or an appName.
    constructor(caps?: HostUiCapabilities) {
        this.supportsInteractiveDialogs = caps?.supportsInteractiveDialogs ?? true;
        this.supportsOpenDialog = caps?.supportsOpenDialog ?? true;
    }
    // …existing methods unchanged…
}

export function createVscodeHostSeams(
    workspaceRoot: string,
    secrets?: vscode.SecretStorage,
    options?: { ui?: HostUiCapabilities }
): HostSeams {
    return {
        // …unchanged…
        ui: new VscodeHostUI(options?.ui),
        // …unchanged…
    };
}
```

The third parameter is optional, so all existing `createVscodeHostSeams(root, secrets)` call sites compile unchanged and keep editor semantics.

### 2. `src/standalone/bootstrap.ts:659` — override at the composition root

```ts
// The standalone bundle's webpack alias resolves `vscode` to vscodeShim, whose
// showOpenDialog REJECTS (vscodeShim.ts:136) and whose showWarningMessage /
// showInformationMessage resolve to undefined (lines 133-134). Declare that here,
// where the host is known — never by sniffing a user agent, and never in
// createHeadlessHostSeams, which bootstrap does not use (hostServices.ts:356-370).
const headlessSeams: HostSeams = createVscodeHostSeams(workspaceRoot, secretStorage as any, {
    ui: { supportsInteractiveDialogs: false, supportsOpenDialog: false }
});
```

Do **not** write `headlessSeams.ui = { ...headlessSeams.ui, supportsOpenDialog: false }`. `VscodeHostUI` is a class; spreading the instance drops every prototype method and the host loses `showTemporaryNotification`, `showErrorMessage` and the rest. (That is exactly what the adjacent `headlessSeams.watcher = { ...headlessSeams.watcher, … }` at lines 665-668 already does to `watchPattern`/`watchFile` — latent because nothing calls them, and not this plan's to fix.)

### 3. `src/services/PlanningPanelProvider.ts` — one validator, called from both arms

Add a private helper and a per-instance set of picker-approved paths:

```ts
/** Folders the NATIVE picker returned this session. The editor host lets the user
 *  pick anywhere, so those paths bypass the workspace-root constraint on the zip
 *  arm. Server-side only — a client-supplied "the picker chose this" flag would be
 *  forgeable over HTTP, which is the whole exposure this constraint exists for. */
private _pickerApprovedFolders = new Set<string>();

/** Resolve + validate a user-supplied folder. Returns the realpath or an error string.
 *  `allowOutsideRoots` is true only for a path this provider's own native picker
 *  returned. Called by BOTH createPlansSetFolder and createPlansDownloadZip — the
 *  setter is not a gate, the read path is. */
private _validateDocsFolder(raw: string, cpRoot: string): { folder: string } | { error: string } {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed) { return { error: 'Enter a folder path.' }; }
    const expanded = trimmed.startsWith('~') ? path.join(os.homedir(), trimmed.slice(1)) : trimmed;
    const resolved = path.resolve(cpRoot || '', expanded);
    let real: string;
    try { real = fs.realpathSync(resolved); }           // realpath FIRST — defeats symlink escape
    catch { return { error: `Folder not found: ${resolved}` }; }
    try { if (!fs.statSync(real).isDirectory()) { return { error: `Not a folder: ${real}` }; } }
    catch { return { error: `Folder not found: ${real}` }; }
    if (this._pickerApprovedFolders.has(real)) { return { folder: real }; }
    const roots = this._getWorkspaceRoots().map(r => { try { return fs.realpathSync.native(r); } catch { return r; } });
    if (!roots.some(r => this._isContainedIn(r, real))) {
        return { error: 'Folder must be inside an open workspace.' };
    }
    return { folder: real };
}

/** Containment test for an already-realpath'd child against an already-realpath'd
 *  root. Uses path.relative + isAbsolute rather than a `startsWith(root + sep)`
 *  prefix match, and case-folds only on the two case-insensitive platforms.
 *  Every clause here is load-bearing — see "Path containment: resolved". */
private _isContainedIn(realRoot: string, realChild: string): boolean {
    const p = process.platform === 'win32' ? path.win32 : path.posix;
    const fold = (s: string) => (process.platform === 'win32' || process.platform === 'darwin')
        ? p.normalize(s).toLowerCase()      // realpath does NOT case-canonicalise on darwin
        : p.normalize(s);                   // linux is case-SENSITIVE — folding here is a hole
    const rel = p.relative(fold(realRoot), fold(realChild));
    // rel === ''  → child IS the root (allowed).
    // '..' prefix → escapes upward.
    // isAbsolute  → cross-drive / UNC escape on Windows: path.relative('C:\\a','D:\\b')
    //               returns 'D:\\b', which does NOT start with '..' and would pass a
    //               '..'-only check.
    return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}
```

Use `fs.realpathSync.native` (not plain `realpathSync`) throughout. On Windows it routes to `GetFinalPathNameByHandleW`, which expands 8.3 short names (`C:\PROGRA~1\` → `C:\Program Files\`) and resolves mapped network drives to their UNC form — both are traversal vectors a JS-side resolve would miss. `stateFs` spreads `node:fs`, so `.native` is present on the copied function reference.

**`createPlansPickFolder` — stop throwing an off-topic error:**

```ts
case 'createPlansPickFolder': {
    if (!this._seams().ui.supportsOpenDialog) {
        // The seam REJECTS here (vscodeShim.ts:136) and the rejection surfaces as a
        // toast about setting a token, which has nothing to do with folders.
        return { success: false, type: 'createPlansFolderPicked', folder: '',
                 error: 'This host has no native folder picker — type the folder path instead.' };
    }
    let picked: string[] | undefined;
    try {
        picked = await this._seams().ui.showOpenDialog({
            openLabel: 'Zip this folder', canSelectFiles: false, canSelectFolders: true, canSelectMany: false
        });
    } catch (err) {
        return { success: false, type: 'createPlansFolderPicked', folder: '',
                 error: `Folder picker unavailable: ${err instanceof Error ? err.message : String(err)}` };
    }
    const folder = picked && picked.length > 0 ? picked[0] : '';
    if (!folder) { break; }                       // user cancelled — not an error
    try { this._pickerApprovedFolders.add(fs.realpathSync(folder)); } catch { this._pickerApprovedFolders.add(folder); }
    this.postMessageToWebview({ type: 'createPlansFolderPicked', folder });
    return { success: true, type: 'createPlansFolderPicked', folder };
}
```

Returning the result **and** pushing it satisfies the PRD's return-in-body contract (#4) while keeping the editor push additive: in the browser, `transport.js` re-dispatches the response body as a message (`src/webview/transport.js:405-412`), so one handler serves both hosts.

**New `createPlansSetFolder` arm:**

```ts
case 'createPlansSetFolder': {
    const cpRoot = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
    const outcome = this._validateDocsFolder(msg.folder, cpRoot);
    if ('error' in outcome) {
        this.postMessageToWebview({ type: 'createPlansFolderPicked', folder: '', error: outcome.error });
        return { success: false, type: 'createPlansFolderPicked', folder: '', error: outcome.error };
    }
    this.postMessageToWebview({ type: 'createPlansFolderPicked', folder: outcome.folder });
    return { success: true, type: 'createPlansFolderPicked', folder: outcome.folder };
}
```

**`createPlansDownloadZip` — validate before reading (replace lines 3081-3088's folder handling):**

```ts
const outcome = this._validateDocsFolder(msg.folder, cpRoot);
if ('error' in outcome) {
    this._seams().ui.showTemporaryNotification(outcome.error);
    return { success: false, error: outcome.error };
}
const sources = await this._collectFolderDocSources(outcome.folder);
```

> **Superseded:** the original plan's §2, which put the whole validation body inline in `createPlansSetFolder` and left `createPlansDownloadZip` reading `msg.folder` unvalidated.
> **Reason:** `createPlansDownloadZip` is an HTTP-reachable verb that takes a folder path and walks it recursively. Validating only the setter closes nothing — a direct POST skips the setter entirely — while making the plan's own security tests pass. That is the "green metric, unmet goal" failure mode.
> **Replaced with:** one `_validateDocsFolder` helper called from both arms, with a server-side picker-approved set so the editor host's unrestricted dialog still works.

### 4. Register the verb

Add `createPlansSetFolder` to the Planning verb catalogue and regenerate: `npm run catalog:generate` (`node scripts/generate-protocol-catalog.js --write && node scripts/generate-verb-allowlist.js --write`). Do **not** hand-edit `src/generated/verbAllowlist.ts`. Add its schema block to `verbSchemas.ts` — permissive and field-accurate per PRD contract #5: require only `folder` (string), which is the sole field the arm dereferences.

### 5. `src/services/PlanningPanelProvider.ts` — report availability on the existing state push

Fold the capability into the pane's existing init push rather than adding a new message type. `createPlansInit` (line 3019) already fires on pane load and already round-trips correctly on both hosts:

```ts
this.postMessageToWebview({
    type: 'createPlansState',
    hasDocs,
    nativeFolderPicker: this._seams().ui.supportsOpenDialog,
    publicUrl: …, platform: …, platformRef: …
});
```

> **Superseded:** a dedicated `createPlansCapabilities` push plus a `_hasNativeFolderPicker()` helper reading `(this._seams().ui as any)?.supportsOpenDialog`.
> **Reason:** the `as any` cast exists only because the original plan declared the flag on an object literal instead of the `HostUI` interface — with §1 the cast is unnecessary and actively harmful (it would silently read `undefined` if the member were ever renamed). A separate push also adds a second ordering surface for one boolean that the pane's existing first message already carries.
> **Replaced with:** the flag rides `createPlansState`, typed, no cast.

Note for the implementer: the panel HTML also carries a `data-host-capabilities` attribute (`src/services/headlessPanelHtml.ts:16-43`, read at `src/webview/transport.js:451`). **Do not use it here.** It is injected only on the headless serving path — the editor's own `getHtmlForWebview` does not set it — so a webview keying off it would hide the native picker in VS Code, which is exactly backwards.

### 6. `src/webview/connections.js` — render the right control and surface errors

```js
// Capability-driven: hide the native button where the dialog does not exist, rather
// than presenting a control that fails with an off-topic error about tokens.
case 'createPlansState': {
    // …existing handling…
    const typedRow = document.getElementById('cp-folder-input-row');
    if (btnFolder) btnFolder.style.display = msg.nativeFolderPicker ? '' : 'none';
    if (typedRow) typedRow.style.display = msg.nativeFolderPicker ? 'none' : '';
    break;
}
```

Extend the existing `createPlansFolderPicked` handler to render `msg.error` into `statusEl` when present, and to set `chosenFolder` (and re-run the Zip button's enable gate) only when `msg.folder` is non-empty. Add the input row to `src/webview/connections.html`'s Create Plans markup with a `Use folder` button posting `createPlansSetFolder`.

**Do not use `escapeHtml` in this file.** `src/webview/connections.html:554` loads only `connections.js`; `sharedUtils.js` is not on the page in either host (`src/services/headlessPanelHtml.ts:459-461` injects only the transport shim and `connections.js`). Set the path and error strings with `textContent`, which needs no escaping.

## Verification Plan

*(Compilation and automated test execution are out of scope for this planning pass per session directive; the steps below are what the implementer runs.)*

**Automated**
1. `npm run catalog:check` — passes, confirming the new verb was added by regeneration and not by hand.
2. `npm run parity:check` — allowlists ≡ catalogs.
3. New test `src/test/create-plans-folder-source.test.js` — the validation table, since this is the security-relevant part:
   - a real in-workspace directory → `createPlansFolderPicked` with the realpath, no error, and a `{success:true}` body;
   - a non-existent path → `folder: ''` and a `Folder not found:` error;
   - a path to a **file** → rejected with `Not a folder:`;
   - a path outside the workspace roots → rejected with the workspace-constraint error;
   - a **symlink inside the workspace pointing outside it** → rejected (proves realpath runs before the containment check, not after);
   - a **sibling-prefix** path (`<root>-evil`) → rejected;
   - the workspace root **itself** → accepted (proves the `rel === ''` clause);
   - `~` and relative inputs → expanded/resolved, then validated;
   - trailing whitespace and a trailing separator → normalised, accepted;
   - **case-variance behaviour, asserted per platform** (skip the non-applicable ones): on `darwin`, an all-caps spelling of an in-workspace path → **accepted**; on `linux`, a case-variant of an in-workspace path that does not exist → **rejected** at the realpath step, and a genuinely distinct `Uploads` vs `uploads` pair → treated as two separate directories, never merged;
   - on `win32` only: a path on **another drive** (`D:\…` against a `C:\…` root) → rejected. This is the case a `..`-prefix-only check lets through, so it is the test that proves `_isContainedIn` rather than merely exercising it.
4. New test asserting **`createPlansDownloadZip` enforces the same validation** — POST it directly with a folder outside every workspace root and assert `{success:false}` and that `_collectFolderDocSources` was never called. This is the test that distinguishes a real fix from a decorative one.
5. Assert a seam built by `createVscodeHostSeams(root, secrets)` reports `supportsOpenDialog: true`, and one built with `{ ui: { supportsOpenDialog: false } }` reports `false`.
6. Assert the standalone seam bundle still answers `showTemporaryNotification` and `showErrorMessage` after the bootstrap override — the guard against reintroducing the class-spread bug.
7. Assert `createPlansPickFolder` on a seam with `supportsOpenDialog: false` returns `{success:false}` with the folder-specific message and **does not** call `showOpenDialog`.

**Manual — browser cockpit** (the case that is dead today)
8. Open Create Plans. The native "choose folder" button must be **absent**; a typed-path input must be present.
9. Type the workspace's docs folder, click `Use folder`. The Zip button enables. Click it — a zip is produced.
10. Type a path outside the workspace. A visible error names the constraint. The Zip button stays disabled.
11. Type a nonexistent path. The error names the path. No silent no-op, and no toast mentioning tokens.

**Manual — VS Code editor panel**
12. The native picker must still be present and still work exactly as before — pick a folder **outside** the workspace and confirm it is still accepted and still zips (this plan does not restrict the picker; the picker-approved set is what preserves it).
13. Confirm the pane does not show the typed-path input in this host.

**Regression guard**
14. `createPlansPasteBack` and `createPlansCopyPrompt` must be unaffected on both hosts.

## Path containment: resolved

This was the plan's one open uncertainty. Web research settled it, and the answer **changed the design** — the original `startsWith(root + path.sep)` boundary is not sufficient. Findings, with the decision each drives:

| Platform | Does `realpathSync` canonicalise case? | Comparison decision |
| --- | --- | --- |
| `darwin` (APFS/HFS+) | **No.** Node delegates to libuv `uv_fs_realpath` → POSIX `realpath(3)`, which resolves symlinks and `.`/`..` but does not query filesystem metadata to rewrite non-symlink segments to their on-disk casing. `/USERS/alice/documents` comes back unchanged. | Case-fold. **Load-bearing** — without it, two spellings of one directory get different containment verdicts. |
| `win32` (NTFS) | **Yes**, via `GetFinalPathNameByHandleW` — canonical casing, 8.3 short names expanded, drive letters uppercased, mapped drives resolved to UNC. But divergence still occurs: JS-fallback paths on some virtual mounts retain caller casing, and a root string may carry a differently-cased drive letter. | Case-fold anyway. Cheap; closes the fallback gap. |
| `linux` (ext4/xfs/btrfs) | Case-sensitive filesystem; the question does not arise. | **Must NOT fold.** `/app/Uploads` and `/app/uploads` are different directories; folding would merge two distinct boundaries. |

**`path.relative` beats `startsWith`, and the reason is a real bypass, not style.** On Windows, `path.relative('C:\\app\\uploads', 'D:\\etc\\passwd')` returns `'D:\\etc\\passwd'` — an absolute path that does **not** begin with `..`. A containment check testing only for a `..` prefix passes it. The `!isAbsolute(rel)` clause is what closes that; it is not defensive padding. `startsWith` additionally fails on separator mismatch (a root stored with `/` against a `realpath` result with `\`) and on prefix overlap if the trailing separator is ever dropped (`/var/app/data` vs `/var/app/data-secret`).

**Also adopted:** `fs.realpathSync.native` rather than `fs.realpathSync`, so Windows 8.3 short names and mapped network drives are expanded before comparison rather than after.

**Precedent check.** The two in-repo patterns this plan was told to follow — `_buildLocalAssetUrl` (`src/services/TicketsPanelProvider.ts:483-501`) and `downloadAttachment` (`src/services/TaskViewerProvider.ts`) — use prefix-style checks. This plan deliberately does **not** copy them on this point; they predate the finding above. Bringing them into line is out of scope here and worth its own plan.

**Related CVE context** (background for the implementer, not a claim about this codebase): CVE-2025-27210 (Windows reserved DOS device names bypassing Node path-traversal guards), CVE-2023-30584 / CVE-2023-32002 (Node permission-model boundary bypasses via trailing-character and symlink edge cases), and CVE-2026-44705 / CVE-2026-24884 (path traversal in `tmp` / `compressing` caused by incomplete `startsWith` prefix checks and failure to resolve intermediate symlinks before validating). The last pair is precisely the failure mode this section exists to avoid.

Everything else in this plan was verified directly against the source files cited.

## Recommendation

Complexity 6 → **Send to Coder.**
