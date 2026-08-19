# Tickets attach-image opens the file picker in VS Code, not in the browser

## Goal

Make the 🖼️ **Attach image** button in the Tickets ticket-editor work for a user sitting in front of a **browser** — the browser cockpit served by the running extension, and the standalone (`npx switchboard`) host. Today the button acquires its bytes through a **server-side native dialog**, so in a browser the picker either opens on a completely different surface or never opens at all.

### Problem analysis

`src/webview/tickets.js:3158-3175` wires the markdown editor's `onAttachImage` callback to post a `ticketAttachImage` verb and wait for a `ticketImageAttached` push:

```js
onAttachImage: () => new Promise((resolve) => {
    const requestId = Date.now() + Math.random();
    const handler = (event) => { /* resolves on ticketImageAttached */ };
    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'ticketAttachImage', requestId, provider, id: task.id, workspaceRoot: ticketsWorkspaceRoot });
})
```

The verb arm at `src/services/TicketsPanelProvider.ts:3330-3373` acquires the file by asking the **host** for a native dialog:

```ts
const picked = await this._seams().ui.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Attach image',
    filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }
});
```

That is correct in exactly one host — the VS Code webview, where the person clicking the button and the process opening the dialog share a window. It is wrong in both browser hosts:

- **Browser cockpit backed by the running extension.** The browser posts to `POST /tickets/verb/ticketAttachImage` (`LocalApiServer.ts:4434` → `_handleTicketsVerb`, `:2631` → `TicketsPanelProvider.handleServiceVerb`, `:144`). `_seams().ui` is `VscodeHostUI` (`src/services/hostSeams.ts:406`), so a **modal VS Code open-dialog appears in the editor window** — a different application, often on a different screen or behind the browser, and on a remote-viewed cockpit on a different machine entirely. The HTTP request stays open until somebody dismisses that dialog. This is exactly the reported symptom.
- **Standalone (`npx switchboard`).** `bootstrap.ts` injects `createVscodeHostSeams(...)` compiled against the vscode shim, and `src/standalone/vscodeShim.ts:136` makes `showOpenDialog` **reject**: `headlessReject('showOpenDialog')` (`:103`). The arm's `catch` calls `showErrorMessage`, which on this host only writes to the server console (`vscodeShim.ts:135`), then pushes `ticketImageAttached { success: false }`. `markdownEditor.js:379-386` strips the `![Uploading image…]()` placeholder, so the button visibly does **nothing** and no error reaches the browser.

### Root cause

The bytes are acquired **server-side** through a host primitive, while the person choosing the file is **client-side**. In a browser those are not the same surface (and need not be the same machine). Every path downstream of the picker — the `attachments/` directory, the collision-safe filename, the `ticketImageAttached` push, the asset-URL rewrite in `_rewriteLocalImagePaths` (`TicketsPanelProvider.ts:558`) — is already host-neutral and correct. **Only the acquisition step is misplaced.**

### The fix, in one line

In a browser host, the **client** reads the file (`<input type="file">` + `FileReader`) and sends the bytes to a new `ticketAttachImageData` verb, which performs the same validate-and-write the existing arm does after its picker returns. The VS Code webview keeps the native dialog, which works there and is the better experience.

**Deliberately NOT unified onto a single `<input type="file">` path.** The VS Code webview iframe is sandboxed without `allow-modals` (the documented reason `window.confirm()` is a silent no-op in this repo), and whether Chromium's file chooser survives that sandbox is unverified. The native dialog in that host is working today; replacing it with an unverified mechanism to save a five-line branch is a bad trade. Each host has exactly one behaviour; the user never sees a choice.

**Why base64-in-JSON, not raw-binary upload.** The codebase has a precedent for raw-binary image upload: `ptyPasteImage` (`LocalApiServer.ts:2378-2408`) bypasses `_parseJsonBody` for `application/octet-stream`, reads raw chunks, and checks size on the actual bytes — avoiding the 33% base64 inflation. That path is special-cased inside the pty verb handler, not the tickets verb handler. Using it here would require adding a similar content-type branch to `_handleTicketsVerb` (`:2631`), a different code path with different error handling, and a non-JSON body that bypasses the schema-validation rail. The base64-in-JSON approach reuses `_handleAttachFile`'s proven validation (`:3947-4021`), flows through the same `_parseJsonBody` → `validateVerbPayload` → `handleServiceVerb` pipeline as every other tickets verb, and the 8 MB client-side pre-check keeps the inflated body under the 10 MB ceiling. The 33% bandwidth overhead is acceptable for image attachments.

## Metadata

- **Complexity:** 5
- **Tags:** bugfix, frontend, backend, ui
- **Project:** Browser Switchboard

## User Review Required

The deliberate non-unification decision (keep the native dialog in the VS Code webview, use `<input type="file">` only in browser hosts) is a design trade-off that the user should confirm before implementation. The plan's reasoning — that the VS Code webview iframe sandbox may block Chromium's file chooser, and the native dialog works today — is sound but unverified. If the user prefers a single code path, the VS Code path would need a separate spike to confirm `<input type="file">` survives the sandbox. No other aspect requires user review; the security, validation, and edge-case handling are fully specified.

## Complexity Audit

**Routine**

- Adding a `case` to `TicketsPanelProvider._handleMessage` — the file has ~90 such arms.
- Adding a `verbSchemas.ts` entry and regenerating `protocol-catalog.json` + `src/generated/verbAllowlist.ts` via `npm run catalog:generate`.
- Base64 decode + extension allowlist + size cap: `LocalApiServer._handleAttachFile` (`:3947-4021`) is a working reference implementation of exactly this validation, including the strict `/^[A-Za-z0-9+/]*={0,2}$/` check that exists because `Buffer.from` silently ignores invalid base64.
- The collision-safe destination-name loop, `attachments/` mkdir, and the `ticketImageAttached` push shape are lifted verbatim from the existing arm.

**Complex / Risky**

1. **`fileName` is now attacker-controllable input.** The existing arm derives the name from a path the *host* dialog returned; the new arm takes a string from an HTTP client. It must be reduced with `path.basename()`, stripped of separators, and extension-checked against an allowlist before any `path.join`. A raw `path.join(attachmentsDir, msg.fileName)` with `../../` writes outside the workspace. This is the single highest-risk line in the change.
2. **Transient user activation.** `input.click()` must be reached **synchronously** from the toolbar click. `markdownEditor.js:362-374` calls `onAttachImage()` with no intervening `await`, so activation is intact — but any `await` added ahead of `input.click()` inside the new browser path silently kills the picker in Safari and Chrome. Verified there is no `sandbox` attribute on the shell's panel iframes (`shell.js:377-385`), so the picker is not otherwise blocked.
3. **A cancelled pick must resolve the promise.** `markdownEditor.js:367` inserts `![Uploading image…]()` *before* awaiting, and only removes it once the promise settles. `change` does not fire on cancel, so a naive implementation leaves that placeholder permanently welded into the user's description. Needs the `cancel` event plus a window-refocus fallback.
4. **Body-size ceiling.** `_parseJsonBody` (`LocalApiServer.ts:1120-1129`) destroys the request above `_MAX_FILE_SIZE_BYTES` (10 MB) — measured on the **base64** body, which is ~4/3 of the file. The transport's `fetch` then rejects and no `ticketImageAttached` ever arrives, so the promise hangs and the placeholder sticks. A client-side 8 MB pre-check keeps the request under the ceiling for every file that has a chance of succeeding.
5. **The verb-return-contract ratchet.** `scripts/check-verb-return-contract.js` caps `Tickets` at 55 `break;` statements and only ever lowers the ceiling. The new arm must `return` a value on **every** path — including its error paths — never `break`.

## Edge-Case & Dependency Audit

**Edge cases**

- **Cancelled picker** → resolve `null`, placeholder removed, nothing sent. Handled by the `cancel` listener + refocus fallback.
- **File over 8 MB** → rejected client-side with a visible message; no request is sent. (Without this the request is destroyed mid-flight and the promise never settles.)
- **Non-image extension** (a user typing `*` into the picker filter, or a hand-crafted POST) → server rejects against the same `png/jpg/jpeg/gif/webp` set the native dialog filters on.
- **Malicious `fileName`** (`../../.ssh/authorized_keys.png`, `C:\x.png`, `.png` with no stem, an empty string) → `path.basename` + separator strip + `stem || 'image'` fallback. Every one lands inside `attachments/`.
- **Corrupt / truncated base64** → strict charset+length check rejects before `Buffer.from`, so a silently-truncated file is never written to disk.
- **Name collision** → existing `stem-1.png`, `stem-2.png` loop, unchanged.
- **Ticket never saved locally** → `_findTicketFilePath` (`:352`) returns null; the existing arm's message ("Save the ticket once before attaching images.") must now travel to the browser in the push payload, because `showErrorMessage` is invisible there.
- **Two browser tabs open on the same ticket** → `ticketImageAttached` is broadcast to every Tickets surface (`postMessageToWebview` → `_pushTo` → `BroadcastHub`, `:199-207`), and both tabs' handlers filter on `requestId`, so the non-originating tab ignores it. Unchanged behaviour.
- **VS Code webview unaffected** → `window.__switchboardVscodeShim` is undefined there (set only at `transport.js:429`), so the existing native path runs bit-for-bit as today.

**Dependencies**

- `src/webview/markdownEditor.js` — consumer contract only: `onAttachImage()` resolves `{path}` or `null`. Not modified.
- `scripts/generate-protocol-catalog.js` + `scripts/generate-verb-allowlist.js` — `npm run catalog:generate` must run, or `handleServiceVerb`'s `TICKETS_VERBS.has(verb)` gate (`:148`) throws `Unknown Tickets verb` for every browser request.
- `validateVerbPayload('tickets', …)` (`:151`) — a missing schema entry means "no declared shape", which passes everything; declare it so `fileName`/`fileDataBase64` are type-checked at the rail.
- **No dependency on the unlanded `supportsOpenDialog` / `supportsInteractiveDialogs` capability flags.** The *Standalone Host: Panel Flows Blocked by Stubbed Native Dialogs* feature proposes them but they do not exist in `src/` yet (verified: zero occurrences). That feature's approach is to *disclose* the missing dialog honestly; this plan removes the need for a dialog on the browser path altogether. The two do not collide — this plan touches neither `hostSeams.ts` nor `bootstrap.ts`.

**Explicitly out of scope**

- The Tickets panel's three **folder** pickers (`addTicketsFolder` `:1409`, `browseTicketsFolder` `:1452`, `browseIntegrationTicketSaveLocation` `:4189`). A browser file input cannot name a directory on the server's filesystem, so they are a genuinely different problem with a different answer.
- The identical attach-image defect in the Planning/Project panels (`PlanningPanelProvider.ts:3063`). Same shape, separate surface, separate report. The verb added here is a directly reusable template.
- Drag-and-drop and clipboard-paste image attach. Not reported, not implied by the picker fix.
- **No migration.** No persisted state, settings key, or file layout changes shape; the new verb only adds a second way to produce a file in the `attachments/` directory that already exists.

## Dependencies

- None. This plan is self-contained — it adds a new verb arm, a schema entry, a client-side picker, and a contract test. No other plan must land first.

## Adversarial Synthesis

Key risks: (1) `fileName` is now attacker-controllable HTTP input — path traversal via `../../` must be blocked by `path.basename()` + separator strip before any `path.join`; the contract test pins this guard. (2) A cancelled file picker must resolve the promise or the `![Uploading image…]()` placeholder is permanently welded into the user's ticket description — the `cancel` listener plus window-refocus fallback covers this. (3) The 10 MB `_parseJsonBody` ceiling is measured on the base64 body (~4/3 of the file), so a 7.5 MB image silently destroys the request and hangs the promise — the client-side 8 MB pre-check prevents this. Mitigations are coded into the plan and pinned by the contract test.

## Proposed Changes

### 1. `src/services/TicketsPanelProvider.ts` — new `ticketAttachImageData` arm

Add module-level constants near the other file-scope constants, then insert the arm immediately after the existing `ticketAttachImage` case (ends `:3373`) so the two acquisition paths read together.

```ts
// Client-supplied bytes: the browser hosts cannot use the native picker (it
// opens in the editor window, or rejects outright on standalone), so the
// panel reads the file and posts it here. The name arrives from an HTTP
// client and is NEVER trusted as a path.
const TICKET_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
// Under LocalApiServer._MAX_FILE_SIZE_BYTES (10MB), which is measured on the
// base64 body (~4/3 of the file). The webview enforces the same number so an
// oversize pick is refused before the request is built.
const TICKET_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
```

```ts
case 'ticketAttachImageData': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    const provider = msg.provider as 'clickup' | 'linear';
    const id = msg.id;
    const requestId = msg.requestId;
    // Every failure returns AND pushes: the return feeds the HTTP rail, the
    // push feeds the waiting onAttachImage promise. showErrorMessage is not
    // used — it is invisible in a browser and a console line on standalone.
    const fail = (error: string) => {
        this.postMessageToWebview({ type: 'ticketImageAttached', requestId, success: false, error });
        return { success: false, error };
    };
    if (!workspaceRoot || !provider || !id) { return fail('Missing workspaceRoot, provider or id.'); }
    try {
        const filePath = await this._findTicketFilePath(workspaceRoot, provider, id);
        if (!filePath) { return fail('Save the ticket once before attaching images.'); }

        // basename() first, then strip any separator the platform's basename
        // did not treat as one (a Windows path arriving at a posix server).
        const safeName = path.basename(String(msg.fileName || '')).replace(/[/\\]/g, '');
        const ext = path.extname(safeName).toLowerCase();
        if (!TICKET_IMAGE_EXTENSIONS.has(ext)) {
            return fail(`Unsupported image type — use ${[...TICKET_IMAGE_EXTENSIONS].join(', ')}.`);
        }

        // Buffer.from silently drops invalid base64 characters, so a corrupt
        // payload would otherwise be written to disk as a truncated image.
        const b64 = String(msg.fileDataBase64 || '').replace(/\s/g, '');
        if (!b64 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
            return fail('Invalid image data.');
        }
        if ((b64.length * 3) / 4 > TICKET_IMAGE_MAX_BYTES) {
            return fail(`Image is larger than ${TICKET_IMAGE_MAX_BYTES / 1024 / 1024}MB.`);
        }

        const attachmentsDir = path.join(path.dirname(filePath), 'attachments');
        fs.mkdirSync(attachmentsDir, { recursive: true });
        const stem = path.basename(safeName, ext) || 'image';
        let destName = `${stem}${ext}`;
        let counter = 1;
        while (fs.existsSync(path.join(attachmentsDir, destName))) {
            destName = `${stem}-${counter}${ext}`;
            counter++;
        }
        fs.writeFileSync(path.join(attachmentsDir, destName), Buffer.from(b64, 'base64'));

        const relativePath = `attachments/${destName}`;
        this.postMessageToWebview({ type: 'ticketImageAttached', requestId, success: true, relativePath });
        return { success: true, relativePath };
    } catch (err: any) {
        return fail('Failed to attach image: ' + (err?.message || String(err)));
    }
}
```

Also add `error` to the failure pushes in the **existing** `ticketAttachImage` arm (`:3336`, `:3343`, `:3352`, `:3370`) so both arms emit the same payload shape and the webview has one message renderer.

### 2. `src/services/verbSchemas.ts` — declare the payload

Beside the existing `ticketAttachImage` entry (`:1166-1173`):

```ts
ticketAttachImageData: {
    fields: {
        workspaceRoot: { type: 'string' },
        provider: { type: 'string', required: true },
        id: { type: 'string', required: true },
        requestId: { type: ['string', 'number'] },
        fileName: { type: 'string', required: true },
        fileDataBase64: { type: 'string', required: true },
    },
},
```

### 3. `protocol-catalog.json` + `src/generated/verbAllowlist.ts` — regenerate

Do not hand-edit either file (`verbAllowlist.ts` carries an AUTO-GENERATED banner). Run:

```
npm run catalog:generate
```

Confirm `ticketAttachImageData` lands in `TICKETS_VERBS`; without it `handleServiceVerb` throws `Unknown Tickets verb: 'ticketAttachImageData'` for every browser request.

### 4. `src/webview/tickets.js` — browser-side pick, then post the bytes

Add a module-scope helper (near the other detail-pane helpers) and branch inside `onAttachImage` (`:3158`).

```js
// Mirrors TICKET_IMAGE_MAX_BYTES in TicketsPanelProvider. Enforced here as
// well because LocalApiServer destroys a request whose body exceeds its 10MB
// ceiling — the fetch then rejects with no push, and the markdown editor's
// "Uploading image…" placeholder would never be cleaned up.
const TICKET_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Read an image from the USER's machine via the browser's own picker.
 *
 * Only used when the browser transport shim is present. Resolves
 * {name, base64} on success and null on cancel/oversize/read error — never
 * rejects, because the caller's placeholder is only removed once this settles.
 *
 * MUST reach input.click() synchronously: an await here spends the transient
 * user activation and the picker silently never opens.
 */
function pickTicketImageInBrowser() {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.png,.jpg,.jpeg,.gif,.webp,image/*';
        input.style.display = 'none';
        document.body.appendChild(input);

        let settled = false;
        const finish = (value) => {
            if (settled) { return; }
            settled = true;
            input.remove();
            resolve(value);
        };

        input.addEventListener('change', () => {
            const file = input.files && input.files[0];
            if (!file) { finish(null); return; }
            if (file.size > TICKET_IMAGE_MAX_BYTES) {
                showTicketsError(`"${file.name}" is larger than ${TICKET_IMAGE_MAX_BYTES / 1024 / 1024}MB.`);
                finish(null);
                return;
            }
            const reader = new FileReader();
            reader.onerror = () => { showTicketsError(`Could not read "${file.name}".`); finish(null); };
            reader.onload = () => {
                const dataUrl = String(reader.result || '');
                const comma = dataUrl.indexOf(',');
                finish(comma === -1 ? null : { name: file.name, base64: dataUrl.slice(comma + 1) });
            };
            reader.readAsDataURL(file);
        });

        // 'change' does not fire on cancel. Without a cancel path the caller's
        // promise never settles and "![Uploading image…]()" is welded into the
        // user's description permanently. 'cancel' covers current browsers;
        // the refocus timer covers the rest.
        input.addEventListener('cancel', () => finish(null));
        window.addEventListener('focus', () => {
            setTimeout(() => { if (!input.files || input.files.length === 0) { finish(null); } }, 500);
        }, { once: true });

        input.click();
    });
}
```

> **Superseded:** `showTicketsAttachError` is a one-line wrapper over the panel's existing inline status/toast helper.
> **Reason:** The panel already exports `showTicketsError(text)` (`tickets.js:378`), which calls `showTicketsStatus(text, true)` (`:365`) and renders to the tickets status footer. Creating a separate wrapper duplicates an existing function for no gain.
> **Replaced with:** Use `showTicketsError(...)` directly in every browser-path failure branch. No new function is added.

Then the branch in `onAttachImage`:

```js
onAttachImage: () => new Promise((resolve) => {
    const requestId = Date.now() + Math.random();
    const listen = () => {
        const handler = (event) => {
            const msg = event.data;
            if (msg.type === 'ticketImageAttached' && msg.requestId === requestId) {
                window.removeEventListener('message', handler);
                if (!msg.success && msg.error) { showTicketsError(msg.error); }
                resolve(msg.success ? { path: msg.relativePath } : null);
            }
        };
        window.addEventListener('message', handler);
    };

    // Browser host (cockpit or standalone): the native dialog would open in
    // the VS Code window running the server, or reject outright — neither is
    // visible to whoever clicked. Read the bytes here instead. The shim
    // global is set only by transport.js, so this is false in the webview.
    if (window.__switchboardVscodeShim) {
        // Called synchronously — see the activation note on the helper.
        pickTicketImageInBrowser().then((picked) => {
            if (!picked) { resolve(null); return; }
            listen();
            vscode.postMessage({
                type: 'ticketAttachImageData',
                requestId, provider, id: task.id,
                workspaceRoot: ticketsWorkspaceRoot,
                fileName: picked.name,
                fileDataBase64: picked.base64
            });
        });
        return;
    }

    listen();
    vscode.postMessage({
        type: 'ticketAttachImage',
        requestId, provider, id: task.id,
        workspaceRoot: ticketsWorkspaceRoot
    });
})
```

### 5. `src/test/` — contract test

New file `src/test/tickets-attach-image-data-contract.test.js`, following the existing tickets contract tests:

- `ticketAttachImageData` is present in `TICKETS_VERBS` (guards a forgotten `catalog:generate`).
- Source assertion: the `ticketAttachImageData` arm contains `path.basename(` and does **not** contain a `path.join(attachmentsDir, msg.fileName` style raw join — the traversal guard, pinned so a later refactor cannot quietly drop it.
- Source assertion: `tickets.js` posts `ticketAttachImageData` only under a `window.__switchboardVscodeShim` guard, and still posts `ticketAttachImage` on the other branch (both hosts stay wired).
- Source assertion: `pickTicketImageInBrowser` registers a `cancel` listener (pins the stuck-placeholder fix).

## Verification Plan

**Automated**

1. `npx tsc --noEmit -p tsconfig.json` — clean.
2. `npm run catalog:check` — passes, i.e. the committed `protocol-catalog.json` / `verbAllowlist.ts` match the source after `catalog:generate`.
3. `node scripts/check-verb-return-contract.js` — `Tickets` break count still ≤ 55 (the new arm returns on every path).
4. `node scripts/check-push-routing.js` — still zero raw `webview.postMessage` in `TicketsPanelProvider.ts`.
5. `node --test src/test/tickets-attach-image-data-contract.test.js` plus the existing tickets suites — green.

**Manual — browser cockpit against the running extension (the reported case)**

6. Open the Tickets panel in the browser cockpit. Open an imported ticket, click **Edit**, click 🖼️ **Attach image**.
7. **The browser's own file picker opens. No dialog appears in the VS Code window.** This is the fix.
8. Pick a PNG → the `![Uploading image…]()` placeholder is replaced by `![](attachments/<name>.png)`; the live preview renders the image (via the `_rewriteLocalImagePaths` asset URL); the file exists on disk next to the ticket markdown in `attachments/`.
9. Re-attach the same filename → lands as `<name>-1.png`, both files present.
10. Click 🖼️ and **cancel** the picker → the placeholder disappears and the description is byte-identical to before the click. Repeat 3× — no accumulated placeholders, no orphan `<input>` nodes in the DOM.
11. Pick a >8 MB image → an in-page error names the file and the limit; nothing is written; the placeholder is removed.
12. Save the ticket, reload the browser tab, reopen the ticket → the image still renders.

**Manual — standalone (`npx switchboard`)**

13. Same flow. Previously the button did nothing and the only trace was a `showOpenDialog is not available in the headless standalone host` line on the server console. Now the browser picker opens and the attach completes.

**Manual — VS Code webview (regression)**

14. Open the Tickets panel in the editor, Edit → 🖼️ → the **native VS Code open-dialog** appears exactly as before, filtered to images, and the attach completes. Cancel → placeholder removed. Unchanged behaviour is the requirement here.

**Security**

15. With the board running, `POST /tickets/verb/ticketAttachImageData` by hand with `fileName: "../../../../tmp/pwned.png"` and valid base64 → the file lands in the ticket's `attachments/` directory as `pwned.png`; nothing is written outside it.
16. Same with `fileName: "x.sh"` → `400`-equivalent `{success:false}` naming the allowed types; no file written.
17. Same with `fileDataBase64: "not!valid!base64"` → `{success:false, error:'Invalid image data.'}`; no file written.
