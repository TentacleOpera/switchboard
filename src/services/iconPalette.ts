/**
 * Icon palette listing + PNG size guard — shared by the
 * `GET /terminals/icon-palette` HTTP endpoint (LocalApiServer) and the
 * `getIconPalette` kanban verb (KanbanProvider), so the picker grid is
 * populated identically in the browser cockpit and the VS Code webview.
 *
 * The kanban webview cannot fetch the HTTP endpoint directly (VS Code webview
 * CSP + no auth cookie), so it requests the palette via a postMessage verb
 * that routes through `_handleMessage`. Both paths call {@link listIconPalette}.
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';

export interface IconPaletteEntry {
    name: string;
    src: string;
    mtime: number;
    kind: 'agent' | 'team' | 'other';
    /** Present only when an `agent-*`/`team-*` PNG is not 32x32. */
    sizeWarning?: string;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico', '.avif']);

/**
 * Read a PNG's pixel dimensions from its IHDR chunk (bytes 16–23, big-endian
 * uint32 width then height). Returns null for a non-PNG or truncated file.
 * No image library dependency — the size guard only needs width/height.
 */
export function readPngDimensions(file: string): { width: number; height: number } | null {
    let fd: number | undefined;
    try {
        fd = fsSync.openSync(file, 'r');
        const buf = Buffer.alloc(24);
        const n = fsSync.readSync(fd, buf, 0, 24, 0);
        if (n < 24) { return null; }
        // PNG signature: 89 50 4E 47 0D 0A 1A 0A
        if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) { return null; }
        // IHDR chunk type at bytes 12–15; width at 16–19, height at 20–23.
        if (buf[12] !== 0x49 || buf[13] !== 0x48 || buf[14] !== 0x44 || buf[15] !== 0x52) { return null; }
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    } catch {
        return null;
    } finally {
        if (fd !== undefined) {
            try { fsSync.closeSync(fd); } catch { /* ignore */ }
        }
    }
}

/**
 * List image files under the given `icons` root(s). `kind` is derived from the
 * filename prefix: `agent-` → 'agent', `team-` → 'team', otherwise 'other'
 * (the stand-in sci-fi pack and the brand/nav SVGs). The picker groups by
 * `kind` so the stand-in pack can be dropped from the palette as one group
 * once real art lands.
 *
 * `mtime` (unix seconds) is what the picker appends as `?v=<mtime>` to bust
 * the 1-hour static cache after a regenerate. Non-picker render paths accept
 * stale cache within that window.
 *
 * Size guard: an `agent-*` / `team-*` PNG that is not 32x32 gets a
 * `sizeWarning` string. Committing an unresized generator output is the
 * likeliest mistake and it presents as a rendering bug (shimmer) rather than
 * a bad file, so it is flagged for the picker to surface. SVGs and `other`
 * PNGs are not checked — only the convention-bound prefixes carry the size
 * contract.
 *
 * Security: only the supplied root directories are read; entries are never
 * resolved outside them. No caller-supplied path is interpolated into `src`.
 * `src` is URL-encoded so spaced stand-in filenames resolve correctly.
 */
export async function listIconPalette(roots: string[]): Promise<IconPaletteEntry[]> {
    const seen = new Set<string>();
    const icons: IconPaletteEntry[] = [];
    for (const root of roots) {
        let entries: string[];
        try {
            entries = await fs.readdir(root);
        } catch {
            continue;
        }
        for (const name of entries) {
            if (seen.has(name)) { continue; }
            seen.add(name);
            const full = path.join(root, name);
            let st: fsSync.Stats;
            try {
                st = await fs.stat(full);
            } catch {
                continue;
            }
            if (!st.isFile()) { continue; }
            const ext = path.extname(name).toLowerCase();
            if (!IMAGE_EXTS.has(ext)) { continue; }
            const kind: IconPaletteEntry['kind'] = name.startsWith('agent-') ? 'agent'
                : name.startsWith('team-') ? 'team'
                : 'other';
            const entry: IconPaletteEntry = {
                name,
                src: '/static/icons/' + encodeURIComponent(name),
                mtime: Math.floor(st.mtimeMs / 1000),
                kind,
            };
            if ((kind === 'agent' || kind === 'team') && ext === '.png') {
                const dims = readPngDimensions(full);
                if (dims && (dims.width !== 32 || dims.height !== 32)) {
                    entry.sizeWarning = `expected 32x32, got ${dims.width}x${dims.height}`;
                }
            }
            icons.push(entry);
        }
    }
    icons.sort((a, b) => a.name.localeCompare(b.name));
    return icons;
}

/** 64 KB cap on a stored `data:` URI — bounds the bloat on every board-load
 *  read of `terminals.agentGroups` (a DB config blob). A dozen custom icons
 *  stays well under a megabyte. */
export const ICON_DATA_URI_MAX_BYTES = 64 * 1024;

/**
 * Validate a team `icon` value server-side. The webview is not the only
 * writer of `terminals.agentGroups`, so this is the authoritative gate.
 *
 * Accepts (returns null = valid):
 *  - absent/empty/null  → valid (no icon; role portrait fallback)
 *  - `art:<name>`       → valid (resolves to /static/icons/<name>.png)
 *  - `pack:<filename>`  → valid (stand-in pack; encoded at resolve time)
 *  - `data:image/...;base64,...` → valid IF ≤ {@link ICON_DATA_URI_MAX_BYTES}
 *
 * Rejects (returns an error string):
 *  - any other prefix (unrecognised)
 *  - a `data:` URI exceeding the cap
 *  - a non-string value
 *
 * Note: `pack:` filenames are NOT size-checked — they are references to files
 * on disk, not inline payloads. The cap exists to bound the config blob, and a
 * pack ref is a few dozen bytes.
 */
export function validateTeamIcon(icon: unknown): string | null {
    if (icon === undefined || icon === null) { return null; }
    if (typeof icon !== 'string') { return 'icon must be a string'; }
    const v = icon.trim();
    if (v === '') { return null; }
    if (v.startsWith('art:')) {
        const name = v.slice('art:'.length).trim();
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) { return 'art: icon name must be a plain slug'; }
        return null;
    }
    if (v.startsWith('pack:')) {
        const file = v.slice('pack:'.length).trim();
        if (!file || path.basename(file) !== file || file.includes('..')) { return 'pack: icon filename must be a plain filename'; }
        return null;
    }
    if (v.startsWith('data:')) {
        if (!/^data:image\/(?:png|svg\+xml|webp);base64,/i.test(v)) {
            return 'data: icon must be a base64 PNG, SVG, or WebP image';
        }
        if (Buffer.byteLength(v, 'utf8') > ICON_DATA_URI_MAX_BYTES) {
            return `data: icon too large (${Math.round(Buffer.byteLength(v, 'utf8') / 1024)} KB, max ${Math.round(ICON_DATA_URI_MAX_BYTES / 1024)} KB)`;
        }
        return null;
    }
    return 'icon must start with art:, pack:, or data:';
}
