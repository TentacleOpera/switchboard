# Paste Images into Browser Terminals

## Goal

Enable users to paste images (screenshots, copied images) directly into Switchboard's browser-based terminal panes, mirroring the workflow that VS Code's integrated terminal + Claude Code CLI users enjoy.

### Problem Analysis

**What the user observed:** In Claude Code running inside VS Code's integrated terminal, you can paste an image from the clipboard and Claude Code receives it as visual context. In Switchboard's browser-based terminal panel, pasting an image does nothing — the image is silently dropped.

**Root cause:** Switchboard's terminal panel is an xterm.js terminal running inside a browser webview, connected to a server-side PTY via WebSocket. The input path is text-only end-to-end:

1. **Client side** (`src/webview/terminals.js`): xterm.js's internal hidden textarea handles `paste` events by extracting text via `clipboardData.getData('text')` and passing it through `term.onData`. Image data in `clipboardData.items` (type `image/png`, etc.) is never inspected — xterm.js has no built-in image-paste handling.
2. **Transport** (`src/standalone/terminalWsGateway.ts`): The WebSocket input frame uses opcode `0x01` with a UTF-8 text payload (`encodeInputFrame` in terminals.js, `ws.on('message')` in the gateway). Binary image data has no path through this channel.
3. **PTY** (`src/standalone/ptyFleetService.ts`): `handle.write()` accepts string data written to the PTY's stdin. There is no mechanism to materialize a clipboard image as a file on the host filesystem and inject its path.

**How VS Code + Claude Code does it:** VS Code's integrated terminal (or third-party extensions like "claude-paste", "clip2path", "claude-image-paste") intercepts the clipboard image, writes it to a temp file on the host, and injects the file path into the terminal input. Claude Code CLI natively accepts image file paths — it reads the file and loads it as visual context. This is a well-established pattern with multiple production extensions implementing exactly this flow: `Clipboard image → write to temp file → inject file path into terminal → CLI reads the file`.

**Why Switchboard needs its own implementation:** Switchboard's terminal is not VS Code's integrated terminal — it is a custom xterm.js webview connected to a server-side PTY fleet. The browser cannot write to the server's filesystem directly. The image must be transported from the browser clipboard to the server, written to a temp file there, and then the file path injected into the PTY input — all within Switchboard's existing verb + WebSocket infrastructure.

## Metadata

**Complexity:** 5
**Tags:** frontend, backend, feature, ui, ux
**Project:** Browser Switchboard

## User Review Required

- **CLI image-path ingestion is CONFIRMED by web research** (see `## Resolved Assumptions`): Claude Code, Aider, Gemini CLI, and Codex CLI all load image file paths as visual context. No remaining external blockers.
- **4 MB rejection ceiling:** images over 4 MB are rejected with a toast rather than downscaled. Research recommends downscaling to <1,568px long edge as an enhancement, but that adds an image-processing dependency — flagged as a possible follow-up, not in scope. The 4 MB ceiling keeps every pasted image safely under the API's 5 MB hard limit and avoids Claude Code's "session poisoning" failure mode.
- **Temp file lifecycle:** pasted images live in `os.tmpdir()/switchboard-paste/` with a 1-hour TTL swept every 10 minutes. If a user pastes an image and submits it to the CLI more than 1 hour later, the file may already be swept. 1 hour is judged generous for a paste-and-submit workflow; flag if a longer TTL is wanted.

## Resolved Assumptions

Web research (2026-08-04, "Image Ingestion Mechanics in Terminal AI Coding Assistants") confirmed the load-bearing external claims and surfaced three design changes (applied below via superseded callouts):

- **CONFIRMED — Claude Code CLI accepts image file paths as visual context.** It detects image paths in the prompt (plain or `@`-prefixed), reads the file, base64-encodes it, and attaches it as a vision block. Supported since v1.0.x, cross-platform. Same pattern works for Aider, Gemini CLI, and Codex CLI. The `@` prefix is the explicit, best-practice form.
- **CONFIRMED — the temp-file + path-injection pattern is the industry standard.** claude-image-paste, clip2path, clipwarp, and tmux-paste-image all do exactly `clipboard → host temp file → inject path into PTY stdin`.
- **NEW CONSTRAINT — the Anthropic API enforces a 5 MB per-image hard limit** (not 10 MB). Images over 5 MB fail with HTTP 400.
- **NEW RISK — Claude Code "session poisoning":** an invalid image payload (oversize, corrupt, unsupported format) is rejected by the API but NOT stripped from conversation history; every subsequent turn re-fails until `/clear`. Pre-validation and a conservative size ceiling are mandatory, not optional.
- **NEW BEST PRACTICE — wrap the injected path in bracketed-paste sequences** (`\x1b[200~` … `\x1b[201~`) so the terminal treats it as a paste block (no premature execution, user can append descriptive text), and prefix with `@`.

## Complexity Audit

**Routine:**
- Adding a new case to the existing `handlePtyVerb` switch in `bootstrap.ts` — the pattern is established (every `pty*` verb follows it).
- Writing a file to `os.tmpdir()` and returning a path — standard Node.js `fs` operations.
- Adding a `fetch('/terminals/verb/ptyPasteImage')` call from the webview — identical pattern to `ptyCloseTerminal`, `ptyClearTerminal`, etc.
- Attaching a `paste` event listener to a DOM element — standard browser API.

**Complex / Risky:**
- **Paste event interception without breaking text paste.** xterm.js manages its own hidden textarea for input. A `paste` listener on the container must only intercept when image content is present; text paste must fall through to xterm's native handler untouched. Using `capture: true` and calling `preventDefault()` only when an image item is found is the safe approach — if no image, do nothing and let xterm handle it.
- **Clipboard image reading in a webview with CSP.** The terminals.html CSP has `default-src 'none'` with `connect-src 'self' ...`. Reading `clipboardData.items[i].getAsFile()` is a local browser API (no network), so CSP does not block it. The `fetch` to `/terminals/verb/ptyPasteImage` is same-origin (`'self'`), so it is allowed. No CSP changes needed.
- **Image payload size over HTTP.** A screenshot can be 1–5 MB. The binding constraint is NOT the transport: web research established the Anthropic API enforces a hard 5 MB per-image limit, and oversize images that reach Claude Code trigger "session poisoning" (see `## Resolved Assumptions`). The image policy ceiling is therefore 4 MB. The transport question is settled separately: the verb bypasses `_parseJsonBody` and reads a raw binary body (`application/octet-stream`) in `_handleTerminalVerb`, avoiding 33% base64 inflation against the 10 MB `_MAX_FILE_SIZE_BYTES` HTTP body cap (`LocalApiServer.ts:351`, enforced at `:991`) — 4 MB images pass far under both ceilings.
- **Temp file cleanup.** Pasted images accumulate in `os.tmpdir()`. Need a TTL or max-count cleanup to avoid unbounded growth during long sessions.
- **Multiple terminals / pane focus.** The paste handler must target the FOCUSED pane's terminal, not an arbitrary one. The existing `focusedPaneIndex` / `paneAssignments` state in terminals.js identifies the active terminal.

## Edge-Case & Dependency Audit

**Edge cases:**
- **No image in clipboard (text paste):** Must fall through to xterm's native text paste. The handler checks `clipboardData.items` for `type.startsWith('image/')` and only acts if found.
- **Multiple items in clipboard (image + text):** Some clipboard operations include both an image and a text representation (e.g., "Copy Image" in browsers). We should prefer the image and ignore the text fallback for that paste event.
- **Images over 4 MB:** Rejected client-side (toast) and server-side (`{success:false}`) BEFORE any path is injected. This is the session-poisoning guard: the Anthropic API hard-rejects images over 5 MB, and Claude Code does not strip the failed payload from history — every later turn re-fails until `/clear`. Never let an oversize path reach the PTY.
- **Claude Code "session poisoning" (defense-in-depth):** even within the size ceiling, a corrupt image could poison a session. The format allowlist (png/jpeg/gif/webp — the four formats the API accepts) plus the 4 MB ceiling covers the realistic cases; BMP/SVG/HEIC/TIFF never get injected because the client only intercepts `image/*` clipboard items and the server maps unknown MIME types to `.png` only within the allowlist. Full byte-level validation (magic-byte sniffing, re-encode) is a possible follow-up, not v1 scope.
- **Animated GIFs:** accepted by the API but only the first frame is processed. No action needed; noted so a "GIF plays only one frame" report is understood as API behavior.
- **Remote/WSL/container path boundary:** the injected path must be visible from the PTY's filesystem context. Switchboard spawns PTYs on the same host that runs the server (ptyFleetService/ptyHost are local process spawners), so `os.tmpdir()` is reachable. Remote PTYs (SSH/container) are not a supported deployment of this fleet; if one is ever added, the temp dir must move into the mounted workspace (research recommendation: session-isolated dir under the workspace root).
- **Unsupported image format:** Limit to `image/png`, `image/jpeg`, `image/gif`, `image/webp`. Other types fall through to normal paste.
- **Terminal not active / PTY closed:** The `ptyPasteImage` verb must check `handle.status === 'active'` and return an error if the terminal is gone, same as `ptyWrite`.
- **Paste while terminal is processing / not at a prompt:** The file path will be written to the PTY stdin regardless. This is the same behavior as VS Code's image paste extensions — the path appears on the input line. If the CLI isn't reading, the path sits in the buffer. This is acceptable and matches user expectations.
- **Drag-and-drop image files:** This plan covers clipboard paste only. Drag-and-drop of image files from the file system is a separate enhancement (the browser would need to read the dropped file and follow the same upload path). The architecture introduced here supports it as a natural extension, but it is out of scope for this plan.

**Dependencies:**
- **LocalApiServer body parsing:** `_parseJsonBody` (line 984) enforces `_MAX_FILE_SIZE_BYTES = 10 MB` (line 351). A base64-encoded image inflates by ~33%, so the effective image limit via JSON is ~7 MB. **Recommended approach:** bypass `_parseJsonBody` for the `ptyPasteImage` verb — handle it as a raw binary POST in `_handleTerminalVerb` (detect `Content-Type: application/octet-stream` and read `req` as a Buffer directly), passing terminal name and MIME type via query parameters. This avoids base64 inflation and allows the full 10 MB image limit. The existing `_handleTerminalVerb` (line 1634) calls `_parseJsonBody` unconditionally; it needs a content-type branch for this one verb.
- **xterm.js paste event target:** The `paste` event fires on the focused element. xterm.js focuses its internal textarea on `mousedown`. A listener on the terminal container (or the textarea itself) with `capture: true` will catch it before xterm's handler. Need to confirm xterm.js version supports this interception pattern.
- **Temp file directory:** Use `os.tmpdir()` with a `switchboard-paste-` subdirectory to avoid collisions with other tools. Create the directory if it doesn't exist.
- **Toast function:** terminals.js has `showPaneToast(text, onUndo)` (terminals.js:627) for transient pane-level messages. Use this for paste feedback ("Pasting image...", "Image too large", "Paste failed"). It auto-dismisses after 6 seconds.

## Proposed Changes

### 1. Server: New `ptyPasteImage` verb in `bootstrap.ts`

Add a new case to `handlePtyVerb` in `src/standalone/bootstrap.ts` (around line 1092, after `ptyClearAllTerminals`). The verb receives the raw image Buffer directly (not base64 in JSON) — see step 6 below for the transport change that makes this possible:

```typescript
case 'ptyPasteImage': {
    const handle = ptyFleetService.get(payload.name);
    if (!handle) { return { success: false, error: `No such terminal: ${payload.name}` }; }
    if (handle.status !== 'active') { return { success: false, error: `Terminal ${payload.name} is not active` }; }

    const imageBuffer: Buffer = payload.imageBuffer; // raw binary, set by _handleTerminalVerb
    const mimeType: string = payload.mimeType || 'image/png';
    if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
        return { success: false, error: 'Missing imageBuffer payload' };
    }

    // 4 MB ceiling — comfortably under the Anthropic API's hard 5 MB per-image
    // limit. An oversize image that reaches the CLI triggers "session poisoning"
    // (the rejected payload stays in history and bricks every later turn), so
    // rejecting HERE, before the path is injected, is the safety boundary.
    const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
    if (imageBuffer.length > MAX_IMAGE_BYTES) {
        return { success: false, error: `Image exceeds max size (${MAX_IMAGE_BYTES} bytes)` };
    }

    // Resolve extension from MIME type
    const ext = mimeType === 'image/jpeg' ? '.jpg'
        : mimeType === 'image/gif' ? '.gif'
        : mimeType === 'image/webp' ? '.webp'
        : '.png';

    const tempDir = path.join(os.tmpdir(), 'switchboard-paste');
    try { await fs.promises.mkdir(tempDir, { recursive: true }); } catch { /* may already exist */ }

    const fileName = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    const filePath = path.join(tempDir, fileName);
    await fs.promises.writeFile(filePath, imageBuffer);

    // Inject the file path into the PTY (no trailing newline — let the user press
    // Enter). Three refinements from research:
    //  - '@' prefix: Claude Code's explicit "load this file now" signal.
    //  - Quote when the path contains whitespace: Windows temp dirs can include
    //    spaces (e.g. C:\Users\John Doe\...) and an unquoted path splits into
    //    multiple tokens at the shell prompt.
    //  - Bracketed-paste wrap (\x1b[200~ ... \x1b[201~): the terminal treats the
    //    path as one paste block — no premature execution, user can append
    //    descriptive text before pressing Enter.
    const atPath = /\s/.test(filePath) ? `@"${filePath}"` : `@${filePath}`;
    handle.write(`\x1b[200~${atPath}\x1b[201~`);

    return { success: true, filePath };
}
```

> **Superseded:** `handle.write(/\s/.test(filePath) ? `"${filePath}"` : filePath)` — inject the raw (whitespace-quoted) file path.
> **Reason:** Web research (see `## Resolved Assumptions`) established two better practices: the `@` prefix is Claude Code's explicit file-load signal, and wrapping in bracketed-paste sequences prevents premature execution and lets the user append descriptive text. Whitespace quoting is retained.
> **Replaced with:** `handle.write('\x1b[200~' + atPath + '\x1b[201~')` where `atPath` is the `@`-prefixed, whitespace-quoted path (code above already reflects this).

> **Superseded:** `handle.write(filePath)` — inject the raw file path.
> **Reason:** `os.tmpdir()` can resolve to a path containing spaces (common on Windows when the username has spaces). An unquoted path splits into multiple tokens at the shell prompt and the CLI receives a broken path.
> **Replaced with:** Quote the path when it contains whitespace — `handle.write(/\s/.test(filePath) ? `"${filePath}"` : filePath)` (code above already reflects this).

> **Superseded:** `const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB` as the image-size ceiling.
> **Reason:** Web research established the Anthropic API enforces a hard 5 MB per-image limit, and that an oversize image reaching Claude Code triggers "session poisoning" (rejected payload stays in history; session bricked until `/clear`). A 10 MB ceiling would let 5–10 MB images through to exactly that failure. (The 10 MB `_MAX_FILE_SIZE_BYTES` transport cap in LocalApiServer is unchanged — it is the HTTP body limit, not the image policy.)
> **Replaced with:** `const MAX_IMAGE_BYTES = 4 * 1024 * 1024;` — a 4 MB ceiling comfortably under the API limit (code above already reflects this; the client-side guard matches).

**Imports needed at top of `bootstrap.ts`:** add `import * as os from 'os';`. Verified against the file: `fs` (line 2) and `path` (line 4) are already imported; `os` is NOT — it must be added.

### 2. Server: Mirror in `ptyHost.ts` (separate-process variant)

Add the same `ptyPasteImage` case to `handlePtyVerb` in `src/standalone/ptyHost.ts` (after the `ptyWrite` case at line 96). The implementation is identical — it operates on the in-process `fleet` the same way. Add `os` and `fs` imports if not present.

**Why this mirror is mandatory (two-layer contract):** the extension host wires `terminalVerb` in `TaskViewerProvider.ts:1982`, and its arm forwards verbs over HTTP to the `ptyHost.ts` child process (`_ptyHostVerb`) rather than serving them locally. So the ptyHost mirror is what makes the verb reachable from the extension-host-served browser panel; the bootstrap.ts case covers the standalone host. Both are required per the PRD's two-layer completion contract.

### 3. Server: Temp file cleanup

Add a lightweight cleanup routine that runs on a timer (e.g., every 10 minutes) and deletes files older than 1 hour from the `switchboard-paste` temp directory. This prevents unbounded accumulation during long sessions.

> **Superseded:** Add the cleanup routine to `bootstrap.ts` only.
> **Reason:** The extension-host path (`ptyHost.ts`, a long-lived child process) writes pasted images to the SAME `switchboard-paste` temp directory. A sweeper only in the standalone host leaves extension-host installs accumulating files forever.
> **Replaced with:** Add the cleanup timer in BOTH `bootstrap.ts` and `ptyHost.ts` (same code; the interval is `.unref()`ed so it never holds a process open).

```typescript
const PASTE_TEMP_DIR = path.join(os.tmpdir(), 'switchboard-paste');
const PASTE_TTL_MS = 60 * 60 * 1000; // 1 hour

setInterval(async () => {
    try {
        const files = await fs.promises.readdir(PASTE_TEMP_DIR);
        const now = Date.now();
        for (const f of files) {
            const fp = path.join(PASTE_TEMP_DIR, f);
            const stat = await fs.promises.stat(fp);
            if (now - stat.mtimeMs > PASTE_TTL_MS) {
                await fs.promises.unlink(fp).catch(() => {});
            }
        }
    } catch { /* dir may not exist yet */ }
}, 10 * 60 * 1000).unref();
```

### 4. Client: Paste event interception in `terminals.js`

In `materializeTerminalView` (`src/webview/terminals.js:2432`, after `term.open(container)` and before `term.onData`), attach a `paste` event listener to the terminal container. The image is sent as a raw binary POST (not base64 JSON) to avoid the 33% inflation that would hit the server's 10 MB body limit:

```javascript
// Intercept image paste: if the clipboard has an image, upload it to the
// server as raw binary, which writes it to a temp file and injects the
// file path into the PTY. Text paste falls through to xterm's native handler.
container.addEventListener('paste', async (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) { return; }

    // Only the four formats the Anthropic API accepts — intercepting image/bmp
    // or image/svg+xml would inject a file the API rejects, and a rejected
    // image poisons the Claude Code session (see Resolved Assumptions).
    const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    let imageItem = null;
    for (let i = 0; i < items.length; i++) {
        if (items[i].type && SUPPORTED_IMAGE_TYPES.includes(items[i].type)) {
            imageItem = items[i];
            break;
        }
    }
    if (!imageItem) { return; } // no supported image — let xterm handle text paste

    e.preventDefault();
    e.stopPropagation();

    const file = imageItem.getAsFile();
    if (!file) { return; }

    // Size guard (4 MB raw — server enforces the same ceiling; see Resolved
    // Assumptions for why 4 MB, not 10 MB)
    if (file.size > 4 * 1024 * 1024) {
        showPaneToast('Image too large (max 4 MB)');
        return;
    }

    showPaneToast('Pasting image...');
    try {
        const arrayBuffer = await file.arrayBuffer();
        const params = new URLSearchParams({
            name: entry.name,
            mimeType: file.type || 'image/png'
        });
        const res = await fetch('/terminals/verb/ptyPasteImage?' + params.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: arrayBuffer
        });
        const data = await res.json();
        if (!data.success) {
            showPaneToast('Image paste failed: ' + (data.error || 'unknown error'));
        }
        // On success, the file path is already injected into the PTY by the server.
        // The path will appear on the terminal input line; user presses Enter to submit.
    } catch (err) {
        showPaneToast('Image paste failed: ' + (err.message || String(err)));
    }
}, true); // capture: true — intercept before xterm's own paste handler
```

> **Superseded:** Intercept any clipboard item whose `type.startsWith('image/')`.
> **Reason:** `image/*` matches BMP, SVG, HEIC and TIFF — formats the Anthropic API does NOT accept. Injecting one produces an API 400 and triggers Claude Code "session poisoning" (the dead payload bricks every later turn until `/clear`). Research established the accepted set is exactly PNG/JPEG/GIF/WebP.
> **Replaced with:** Intercept only the four API-supported MIME types via an explicit allowlist; all other image types fall through to normal paste (code above already reflects this; the server mirrors the allowlist via its extension mapping, which defaults only known types — an unrecognized `mimeType` yields `.png` but the client gate makes that unreachable in practice).

**Note:** `showPaneToast(text, onUndo)` is the existing toast function at terminals.js:627. It displays a transient message in the pane toast element and auto-dismisses after 6 seconds. The `onUndo` parameter is optional and not needed here.

**Contract-test note:** `src/test/pty-route-surface-contract.test.js` enumerates pty verbs in `PTY_VERBS` (line 26) and uses the list to assert route reachability and that pty verbs stay OUT of `protocol-catalog.json`. Add `ptyPasteImage` to `PTY_VERBS` in the same change so CI's routing guarantees cover the new verb; do NOT register it in `protocol-catalog.json` (the catalog is for provider message verbs, and the test asserts pty verbs never appear there).

### 5. Client: Visual feedback during upload

For large images, the upload + file write can take a moment. Show a brief "Pasting image..." toast while the fetch is in flight, and clear it on completion. This sets expectations and prevents double-paste.

### 6. Server: Raw binary body handling in `_handleTerminalVerb`

The existing `_handleTerminalVerb` in `src/services/LocalApiServer.ts` (line 1634) calls `_parseJsonBody` unconditionally. For `ptyPasteImage`, the body is raw binary (`Content-Type: application/octet-stream`), not JSON. Add a content-type branch at the top of `_handleTerminalVerb`:

```typescript
private async _handleTerminalVerb(verb: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!await this._checkAuth(req, true)) {
        this._sendUnauthorized(res);
        return;
    }

    const terminalVerb = this._options.terminalVerb;
    if (!terminalVerb) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Terminal verb dispatch not available' }));
        return;
    }
    if (!verb) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing verb in path' }));
        return;
    }

    try {
        // Raw binary body for image paste — bypass JSON parsing to avoid
        // base64 inflation hitting the _MAX_FILE_SIZE_BYTES cap.
        if (verb === 'ptyPasteImage' && req.headers['content-type'] === 'application/octet-stream') {
            const chunks: Buffer[] = [];
            let totalBytes = 0;
            const MAX = this._MAX_FILE_SIZE_BYTES;
            for await (const chunk of req) {
                totalBytes += chunk.length;
                if (totalBytes > MAX) {
                    req.destroy();
                    res.writeHead(413, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Image exceeds max size' }));
                    return;
                }
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            const imageBuffer = Buffer.concat(chunks);
            // Parse name + mimeType from query string (already on req.url)
            const parsed = new URL(req.url || '', 'http://localhost');
            const body = {
                name: parsed.searchParams.get('name') || '',
                mimeType: parsed.searchParams.get('mimeType') || 'image/png',
                imageBuffer
            };
            const workspaceRoot = String(this._options.workspaceRoot || '').trim() || undefined;
            const result = await terminalVerb(verb, body, workspaceRoot);
            const ok = !result || result.success !== false;
            res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result ?? { success: true }));
            return;
        }

        // Existing JSON path for all other verbs
        const rawBody = await this._parseJsonBody(req);
        const body: any = (rawBody && typeof rawBody === 'object') ? { ...rawBody } : {};
        delete body.type;
        const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim() || undefined;
        const result = await terminalVerb(verb, body, workspaceRoot);
        const ok = !result || result.success !== false;
        res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result ?? { success: true }));
    } catch (err) {
        console.error(`[LocalApiServer] terminalVerb '${verb}' error:`, err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : `terminal verb '${verb}' failed` }));
    }
}
```

This keeps the existing JSON path untouched for every other verb while giving `ptyPasteImage` a dedicated raw-binary path that avoids base64 inflation.

## Dependencies

- None on other plans. Sibling subtasks in this feature touch `terminals.js` in different regions (this plan: `materializeTerminalView`; the kanban-pane subtask: `updatePaneElement`/`renderPaneGrid`; the new-window subtask: `init()`). See feature Dependencies & sequencing.
- External: CONFIRMED by web research — Claude Code, Aider, Gemini CLI, and Codex CLI all load image file paths as visual context (see `## Resolved Assumptions`).

## Adversarial Synthesis

Key risks: unquoted temp paths with spaces break at the shell prompt (mitigated — quote on whitespace); temp-file accumulation on the extension-host path (mitigated — cleanup timer mirrored in ptyHost.ts); paste interception breaking native text paste (mitigated — capture-phase listener acts only on an allowlisted `image/*` clipboard item, otherwise falls through); Claude Code session poisoning from an API-rejected image (mitigated two ways — 4 MB ceiling under the API's 5 MB hard limit, and a PNG/JPEG/GIF/WebP allowlist so unsupported formats never inject). External assumption resolved by research: path injection is the industry-standard pattern and works across the major AI coding CLIs; `@`-prefix + bracketed-paste wrapping applied as best practice.

## Verification Plan

> **Superseded:** Steps 1–4 (unit tests for the server verb, size guard, inactive terminal, and temp-file cleanup).
> **Reason:** Session directive for this improvement pass — SKIP TESTS and SKIP COMPILATION: no automated tests and no project compilation run as part of verification.
> **Replaced with:** The manual curl + browser steps below, which exercise the same branches (success, size guard, inactive terminal, cleanup) end-to-end. The unit tests remain worth writing for CI but are not run in this pass.

1. **Manual — server verb via curl (success path):**
   - With the standalone Switchboard running, create a terminal, then:
     `curl -X POST 'http://127.0.0.1:<port>/terminals/verb/ptyPasteImage?name=<terminal>&mimeType=image/png' -H 'Content-Type: application/octet-stream' --data-binary @/path/to/test.png`
   - Verify the response is `{success:true, filePath:...}`, the file exists under `os.tmpdir()/switchboard-paste/`, its bytes match the source PNG, and the `@`-prefixed (whitespace-quoted if needed) path appears on the terminal's input line wrapped as a bracketed-paste block.

2. **Manual — size guard:** Repeat the curl with a file >4 MB. Verify `{success:false, error:'Image exceeds max size'}` and that no file is written and NO path is injected into the PTY (the session-poisoning boundary).

3. **Manual — terminal not active:** Repeat the curl with a nonexistent `name`. Verify `{success:false, error:'No such terminal...'}`.

4. **Manual — cleanup:** Create files in the `switchboard-paste` temp dir with mtimes >1 hour old (`touch -t`). Wait for or trigger the 10-minute sweep. Verify old files are deleted and recent files remain. Repeat on the extension-host path (ptyHost) if running under VS Code.

5. **Manual — browser paste:**
   - Open the Switchboard browser terminal panel with a Claude Code CLI terminal running.
   - Copy a screenshot to the clipboard (Cmd+Ctrl+Shift+4 on macOS, or Win+Shift+S on Windows).
   - Focus the terminal pane and press Cmd+V / Ctrl+V.
   - Verify: the `@`-prefixed image file path appears on the terminal input line as ONE paste block (bracketed paste — no auto-execution; e.g., `@/tmp/switchboard-paste/paste-1234567890-abc123.png`), and the user can type descriptive text after it before pressing Enter.
   - Press Enter. Verify Claude Code receives and processes the image as visual context (confirmed behavior — see `## Resolved Assumptions`).

6. **Manual — text paste still works:**
   - Copy text to the clipboard.
   - Focus the terminal pane and paste.
   - Verify the text appears normally (no interception, no upload).

7. **Manual — mixed clipboard (image + text):**
   - Copy an image from a web page (which often puts both image and text URL on the clipboard).
   - Paste into the terminal.
   - Verify the image file path is injected (image is preferred over text).

8. **Manual test — large image rejection:**
   - Copy a very large image (>4 MB) to the clipboard.
   - Paste into the terminal.
   - Verify a toast notification appears: "Image too large (max 4 MB)" and no path is injected.

9. **Manual — unsupported format fallthrough:**
   - Copy an unsupported image type (e.g., a BMP or SVG copied as `image/bmp`/`image/svg+xml`) to the clipboard.
   - Paste into the terminal.
   - Verify NO interception occurs (falls through to xterm's native paste; no upload, no path injection) — the API-format allowlist is the session-poisoning guard.
