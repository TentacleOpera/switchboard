#!/usr/bin/env node
/**
 * CLI Banner Art Generator
 *
 * Reads `icons/switchboard-ufo-static.svg` and emits `src/generated/bannerArt.ts`
 * — the terminal render of the product's own pixel-art UFO, in three tiers
 * (24-bit colour, xterm-256, plain ASCII). The CLI prints the generated
 * constant; it never parses SVG at runtime. Same contract as
 * `scripts/generate-verb-allowlist.js`: `--write` overwrites the checked-in
 * module, and a bare run is the CI drift check.
 *
 * Usage: node scripts/generate-banner-art.js [--write]
 *
 * ── GRID FACTS (measured from the SVG, not assumed) ──────────────────────────
 *
 * Every shape in `<g class="ufo">` was scanned:
 *   X coordinates : all multiples of 4      → X divides by 4 exactly.
 *   widths/heights: all multiples of 4      → extents divide by 4 exactly.
 *   Y coordinates : all EVEN, but mixed mod 4 — 42/46/50/54/58/66/70/78/82/86/
 *                   90/98/102 are 2 mod 4, while y="88" (the two inner cyan
 *                   ports) is 0 mod 4.
 *
 * So there is NO free "divide Y by 4" mapping: a constant offset cannot align a
 * set that is {0, 2} mod 4. The vertical strategy is therefore explicit.
 *
 * ── VERTICAL STRATEGY (the judgement call, stated so it is auditable) ────────
 *
 *   Pixel cell = 4x4 SVG units, with the grid ORIGIN AT THE ART'S OWN BOUNDING
 *   BOX (x=72, y=42) rather than at the SVG origin. Anchoring at y=42 puts
 *   every 2-mod-4 Y coordinate exactly on a cell boundary — which is all of
 *   them but one.
 *
 *   Shape edges snap with Math.round((edge - origin) / 4), i.e. round-half-up
 *   (toward increasing y). That is exact for every shape except the two y=88
 *   cyan ports, which snap 88->90 and 96->98. The snap preserves their 2-cell
 *   height AND keeps the port arc monotonically descending (rows 10, 11, 12 for
 *   the three symmetric pairs), which a round-half-down rule would flatten.
 *   This snap IS resampling; it affects exactly those two rects.
 *
 *   A 4x4 cell keeps the source's square-pixel aspect: the craft is 176x64 SVG
 *   units -> 44x16 pixels -> 44 columns x 8 terminal rows of half-blocks
 *   (U+2580/U+2584), a half-block sub-cell being roughly square. Rendering Y at
 *   2px would be exact everywhere but would stretch the saucer 2x vertically
 *   and double the banner height.
 *
 * ── ALPHA / FILTER RULES ─────────────────────────────────────────────────────
 *
 *   Shapes paint in document order. `filter=` (the cyan glow) is ignored — a
 *   Gaussian blur has no meaning on a 4px grid. `opacity`:
 *     - opacity >= 1                -> paint solid.
 *     - opacity < 1 over a PAINTED  -> alpha-composite over the existing cell
 *                                      (this is the cockpit's opacity=".55"
 *                                      cyan over #0b0f0f).
 *     - opacity < 1 over an EMPTY   -> painted only if opacity >= 0.5, else
 *                                      dropped; there is no backdrop to
 *                                      composite against. This drops the
 *                                      opacity=".35" glow group, which the
 *                                      opaque hull covers anyway.
 *
 * ── DETERMINISM ──────────────────────────────────────────────────────────────
 *
 *   No randomness, no float accumulation across shapes, no Map/Set iteration
 *   order in the output. Same SVG in -> byte-identical file out.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SVG_PATH = path.join(REPO_ROOT, 'icons', 'switchboard-ufo-static.svg');
const OUTPUT_PATH = path.join(REPO_ROOT, 'src', 'generated', 'bannerArt.ts');

const CELL = 4;                      // SVG units per pixel cell, both axes.
const UPPER_HALF = '▀';         // ▀ UPPER HALF BLOCK
const LOWER_HALF = '▄';         // ▄ LOWER HALF BLOCK
const ESC = '\u001b';
const RESET = ESC + '[0m';

// ── SVG reading ──────────────────────────────────────────────────────────────

function parseAttrs(raw) {
    const out = {};
    const re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(raw))) { out[m[1]] = m[2]; }
    return out;
}

/** Every rect/path inside `<g class="ufo">`, in document order, with inherited fill/opacity. */
function readUfoShapes(svg) {
    const start = svg.indexOf('<g class="ufo">');
    if (start < 0) { throw new Error('icons/switchboard-ufo-static.svg has no <g class="ufo"> group'); }

    const tagRe = /<(\/?)([\w:-]+)([^>]*?)\/?>/g;
    tagRe.lastIndex = start;

    const stack = [];
    const shapes = [];
    let depth = 0;
    let m;
    while ((m = tagRe.exec(svg))) {
        const closing = m[1] === '/';
        const name = m[2];
        if (closing) {
            if (name === 'g') {
                stack.pop();
                depth -= 1;
                if (depth === 0) { break; }
            }
            continue;
        }
        const attrs = parseAttrs(m[3]);
        const inherited = stack[stack.length - 1] || { fill: null, opacity: 1 };
        const fill = attrs.fill || inherited.fill;
        const opacity = inherited.opacity * (attrs.opacity !== undefined ? Number(attrs.opacity) : 1);

        if (name === 'g') {
            stack.push({ fill, opacity });
            depth += 1;
            continue;
        }
        if (name === 'rect') {
            shapes.push({ x: Number(attrs.x), y: Number(attrs.y), w: Number(attrs.width), h: Number(attrs.height), fill, opacity });
        } else if (name === 'path') {
            for (const band of pathToBands(attrs.d)) {
                shapes.push({ x: band.x, y: band.y, w: band.w, h: band.h, fill, opacity });
            }
        }
    }
    if (shapes.length === 0) { throw new Error('<g class="ufo"> contained no rect/path shapes'); }
    return shapes;
}

/** Minimal M/L/H/V/Z path parser — the one path in this SVG is rectilinear. */
function pathToPoints(d) {
    const tokens = d.match(/[A-Za-z]|-?\d+(?:\.\d+)?/g) || [];
    const pts = [];
    let x = 0, y = 0, cmd = null, i = 0;
    while (i < tokens.length) {
        if (/[A-Za-z]/.test(tokens[i])) {
            cmd = tokens[i];
            i += 1;
            if (cmd === 'Z' || cmd === 'z') { cmd = null; continue; }
            if (cmd === 'M') { x = Number(tokens[i++]); y = Number(tokens[i++]); pts.push([x, y]); cmd = 'L'; continue; }
            if (cmd === 'm') { x += Number(tokens[i++]); y += Number(tokens[i++]); pts.push([x, y]); cmd = 'l'; continue; }
        }
        switch (cmd) {
            case 'L': x = Number(tokens[i++]); y = Number(tokens[i++]); break;
            case 'l': x += Number(tokens[i++]); y += Number(tokens[i++]); break;
            case 'H': x = Number(tokens[i++]); break;
            case 'h': x += Number(tokens[i++]); break;
            case 'V': y = Number(tokens[i++]); break;
            case 'v': y += Number(tokens[i++]); break;
            default: throw new Error(`unsupported path command '${cmd}' in ${d}`);
        }
        pts.push([x, y]);
    }
    return pts;
}

/** Scanline-decompose a rectilinear closed polygon into axis-aligned bands. */
function pathToBands(d) {
    const pts = pathToPoints(d);
    const edges = [];
    for (let k = 0; k < pts.length; k += 1) {
        const [x1, y1] = pts[k];
        const [x2, y2] = pts[(k + 1) % pts.length];
        if (x1 === x2 && y1 !== y2) { edges.push({ x: x1, top: Math.min(y1, y2), bottom: Math.max(y1, y2) }); }
        else if (y1 !== y2) { throw new Error(`non-rectilinear edge in path: ${d}`); }
    }
    const ys = Array.from(new Set(edges.flatMap(e => [e.top, e.bottom]))).sort((a, b) => a - b);
    const bands = [];
    for (let k = 0; k < ys.length - 1; k += 1) {
        const top = ys[k];
        const bottom = ys[k + 1];
        const xs = edges.filter(e => e.top <= top && e.bottom >= bottom).map(e => e.x).sort((a, b) => a - b);
        for (let j = 0; j + 1 < xs.length; j += 2) {
            bands.push({ x: xs[j], y: top, w: xs[j + 1] - xs[j], h: bottom - top });
        }
    }
    return bands;
}

// ── Colour helpers ───────────────────────────────────────────────────────────

function toRgb(hex) {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex(rgb) {
    return '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

function composite(dstHex, srcHex, alpha) {
    const dst = toRgb(dstHex);
    const src = toRgb(srcHex);
    return toHex([0, 1, 2].map(k => src[k] * alpha + dst[k] * (1 - alpha)));
}

function luminance(hex) {
    const [r, g, b] = toRgb(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Nearest xterm-256 index, restricted to 16..255 (0..15 are theme-dependent). */
function toXterm256(hex) {
    const [r, g, b] = toRgb(hex);
    let best = 16;
    let bestDist = Infinity;
    for (let i = 16; i < 256; i += 1) {
        let cr, cg, cb;
        if (i < 232) {
            const n = i - 16;
            const step = v => (v === 0 ? 0 : 55 + v * 40);
            cr = step(Math.floor(n / 36) % 6);
            cg = step(Math.floor(n / 6) % 6);
            cb = step(n % 6);
        } else {
            cr = cg = cb = 8 + (i - 232) * 10;
        }
        const dist = (cr - r) ** 2 + (cg - g) ** 2 + (cb - b) ** 2;
        if (dist < bestDist) { bestDist = dist; best = i; }
    }
    return best;
}

/**
 * ASCII glyph for one colour. Cyan-family pixels get 'o' so the ports and
 * cockpit stay legible; everything else rides a luminance ramp (dark -> light).
 */
function asciiGlyph(hex) {
    const [r, g, b] = toRgb(hex);
    if (g > 100 && b > 100 && r < g / 2) { return 'o'; }
    const lum = luminance(hex);
    if (lum < 16) { return '.'; }
    if (lum < 45) { return ':'; }
    if (lum < 75) { return '='; }
    if (lum < 130) { return '+'; }
    return '#';
}

// ── Rasteriser ───────────────────────────────────────────────────────────────

function rasterise(shapes) {
    const originX = Math.min(...shapes.map(s => s.x));
    const originY = Math.min(...shapes.map(s => s.y));
    const cols = Math.round((Math.max(...shapes.map(s => s.x + s.w)) - originX) / CELL);
    const rows = Math.round((Math.max(...shapes.map(s => s.y + s.h)) - originY) / CELL);

    const grid = new Array(rows * cols).fill(null);
    for (const shape of shapes) {
        if (!shape.fill || shape.fill.startsWith('url(')) { continue; }
        const c0 = Math.round((shape.x - originX) / CELL);
        const c1 = Math.round((shape.x + shape.w - originX) / CELL);
        const r0 = Math.round((shape.y - originY) / CELL);
        const r1 = Math.round((shape.y + shape.h - originY) / CELL);
        for (let r = Math.max(0, r0); r < Math.min(rows, r1); r += 1) {
            for (let c = Math.max(0, c0); c < Math.min(cols, c1); c += 1) {
                const idx = r * cols + c;
                const dst = grid[idx];
                if (shape.opacity >= 1) { grid[idx] = shape.fill; }
                else if (dst) { grid[idx] = composite(dst, shape.fill, shape.opacity); }
                else if (shape.opacity >= 0.5) { grid[idx] = shape.fill; }
            }
        }
    }
    return { grid, rows, cols, originX, originY };
}

// ── Tier renderers ───────────────────────────────────────────────────────────

function renderBlocks(raster, sgr) {
    const { grid, rows, cols } = raster;
    const at = (r, c) => (r < rows ? grid[r * cols + c] : null);
    const lines = [];
    for (let r = 0; r < rows; r += 2) {
        const cells = [];
        for (let c = 0; c < cols; c += 1) { cells.push([at(r, c), at(r + 1, c)]); }
        let last = cells.length - 1;
        while (last >= 0 && !cells[last][0] && !cells[last][1]) { last -= 1; }

        let line = '';
        let dirty = false;
        for (let c = 0; c <= last; c += 1) {
            const [top, bottom] = cells[c];
            if (!top && !bottom) {
                if (dirty) { line += RESET; dirty = false; }
                line += ' ';
            } else if (top && !bottom) {
                line += sgr(top, null) + UPPER_HALF;
                dirty = true;
            } else if (!top && bottom) {
                line += sgr(bottom, null) + LOWER_HALF;
                dirty = true;
            } else {
                line += sgr(top, bottom) + UPPER_HALF;
                dirty = true;
            }
        }
        if (dirty) { line += RESET; }
        lines.push(line);
    }
    return lines.join('\n');
}

function truecolorSgr(fgHex, bgHex) {
    const [fr, fg, fb] = toRgb(fgHex);
    if (!bgHex) { return `${RESET}${ESC}[38;2;${fr};${fg};${fb}m`; }
    const [br, bg, bb] = toRgb(bgHex);
    return `${ESC}[38;2;${fr};${fg};${fb};48;2;${br};${bg};${bb}m`;
}

function x256Sgr(fgHex, bgHex) {
    const fg = toXterm256(fgHex);
    if (!bgHex) { return `${RESET}${ESC}[38;5;${fg}m`; }
    return `${ESC}[38;5;${fg};48;5;${toXterm256(bgHex)}m`;
}

/**
 * ASCII tier — the SAME raster, one character per terminal cell (a full cell
 * already matches the source's square-pixel aspect, so this is 8 rows like the
 * block tiers, not 16). Where the two stacked pixels differ, cyan wins so the
 * ports survive; otherwise the brighter pixel wins so the silhouette reads.
 */
function renderAscii(raster) {
    const { grid, rows, cols } = raster;
    const at = (r, c) => (r < rows ? grid[r * cols + c] : null);
    const lines = [];
    for (let r = 0; r < rows; r += 2) {
        let line = '';
        for (let c = 0; c < cols; c += 1) {
            const top = at(r, c);
            const bottom = at(r + 1, c);
            let pick;
            if (top && bottom) {
                const topCyan = asciiGlyph(top) === 'o';
                const bottomCyan = asciiGlyph(bottom) === 'o';
                if (topCyan !== bottomCyan) { pick = topCyan ? top : bottom; }
                else { pick = luminance(top) >= luminance(bottom) ? top : bottom; }
            } else { pick = top || bottom; }
            line += pick ? asciiGlyph(pick) : ' ';
        }
        lines.push(line.replace(/\s+$/, ''));
    }
    return lines.join('\n');
}

// ── Emit ─────────────────────────────────────────────────────────────────────

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

function buildModule() {
    const svg = fs.readFileSync(SVG_PATH, 'utf8');
    const shapes = readUfoShapes(svg);
    const raster = rasterise(shapes);
    const { grid, rows, cols, originX, originY } = raster;

    // Stable palette: first-appearance order over the raster (row-major), so the
    // indices in BANNER_PIXEL_ROWS are deterministic.
    const palette = [];
    for (const cell of grid) {
        if (cell && !palette.includes(cell)) { palette.push(cell); }
    }
    if (palette.length > BASE36.length) { throw new Error(`palette of ${palette.length} exceeds the base36 index alphabet`); }

    const pixelRows = [];
    for (let r = 0; r < rows; r += 1) {
        let line = '';
        for (let c = 0; c < cols; c += 1) {
            const cell = grid[r * cols + c];
            line += cell ? BASE36[palette.indexOf(cell)] : '.';
        }
        pixelRows.push(line);
    }

    const lines = [];
    lines.push('// AUTO-GENERATED — do not edit; run `npm run banner:generate`.');
    lines.push('// Source: icons/switchboard-ufo-static.svg, group <g class="ufo">.');
    lines.push('// The CLI banner renders the product\'s own pixel-art UFO. The rasteriser, its');
    lines.push('// 4x4 SVG-unit cell, the round-half-up edge snap (exact for every shape except');
    lines.push('// the two y=88 cyan ports) and the alpha rules are documented in');
    lines.push('// scripts/generate-banner-art.js. Regenerating is the only way to change this.');
    lines.push('');
    lines.push('/* eslint-disable */');
    lines.push('');
    lines.push(`// Art bounding box in SVG units: x=${originX}, y=${originY}, ${cols * CELL}x${rows * CELL}, at ${CELL}px/cell.`);
    lines.push(`export const BANNER_ART_COLUMNS = ${cols};`);
    lines.push(`export const BANNER_ART_ROWS = ${Math.ceil(rows / 2)};`);
    lines.push('');
    lines.push('/** Distinct colours in the raster, in first-appearance (row-major) order. */');
    lines.push(`export const BANNER_PALETTE: readonly string[] = ${JSON.stringify(palette)};`);
    lines.push('');
    lines.push('/** One string per PIXEL row (two per terminal row); each char indexes BANNER_PALETTE in base36, `.` = empty. */');
    lines.push('export const BANNER_PIXEL_ROWS: readonly string[] = [');
    for (const row of pixelRows) { lines.push(`    ${JSON.stringify(row)},`); }
    lines.push('];');
    lines.push('');
    lines.push('/** 24-bit colour half-block render. */');
    lines.push(`export const BANNER_ART_TRUECOLOR: string = ${JSON.stringify(renderBlocks(raster, truecolorSgr))};`);
    lines.push('');
    lines.push('/** xterm-256 half-block render (palette quantised to the 6x6x6 cube + greys). */');
    lines.push(`export const BANNER_ART_256: string = ${JSON.stringify(renderBlocks(raster, x256Sgr))};`);
    lines.push('');
    lines.push('/** Plain-ASCII fallback — no escape sequences, no code point above 0x7E. */');
    lines.push(`export const BANNER_ART_ASCII: string = ${JSON.stringify(renderAscii(raster))};`);
    lines.push('');

    return lines.join('\n');
}

function main() {
    const write = process.argv.slice(2).includes('--write');
    const output = buildModule();

    if (write) {
        fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
        fs.writeFileSync(OUTPUT_PATH, output);
        console.error(`[banner] wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)}`);
        return;
    }

    let existing = null;
    try { existing = fs.readFileSync(OUTPUT_PATH, 'utf8'); }
    catch { /* not generated yet */ }

    if (!existing) {
        console.error(`[banner] ${path.relative(REPO_ROOT, OUTPUT_PATH)} not found — run \`npm run banner:generate\` first`);
        process.exit(1);
    }
    if (existing.trim() !== output.trim()) {
        console.error(`[banner] DRIFT — ${path.relative(REPO_ROOT, OUTPUT_PATH)} does not match icons/switchboard-ufo-static.svg. Run \`npm run banner:generate\` to regenerate.`);
        process.exit(1);
    }
    console.log(`[banner] OK — ${path.relative(REPO_ROOT, OUTPUT_PATH)} matches icons/switchboard-ufo-static.svg`);
}

main();
