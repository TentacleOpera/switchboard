#!/usr/bin/env node
/**
 * Icon parity gate for the masked-SVG icon primitive.
 *
 * `icons/icon-<name>.svg` is canonical; the base64 `data:` URI inlined into each
 * panel's CSS is the shipped copy. Two representations can drift, and every drift
 * mode is silent on screen:
 *
 *   - a corrupted payload fails to decode  -> transparent mask -> INVISIBLE icon
 *   - a missing `.sb-icon-<name>` rule     -> mask-image never set, but
 *     `background-color: currentColor` still paints -> SOLID BLOCK
 *
 * So this script enforces three things, not one:
 *
 *   1. ASSET PARITY   — each inlined base64 equals `readFileSync(svg).toString('base64')`
 *                       EXACTLY. Full-string compare, no normalisation, no prefix
 *                       sampling: every asset shares a `<!-- source: icons/ico…`
 *                       header, so a prefix compare passes for any icon and gates
 *                       nothing.
 *   2. ASSET EXISTS   — every `.sb-icon-<name>` mask rule names a real asset.
 *   3. RULE COVERAGE  — every `sb-icon-<name>` class token used by a panel (in its
 *                       own markup/inline script, or in a companion `*.js` it loads
 *                       via a `{{X_JS_URI}}` placeholder) has a matching mask rule
 *                       declared in that panel's CSS. This is the solid-block class.
 */
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const iconsDir = path.join(repoRoot, 'icons');
const webviewDir = path.join(repoRoot, 'src', 'webview');

// Panels that inline the `.sb-icon` primitive. A panel joins this list when it
// gains its first `.sb-icon-*` rule.
const PANELS = [
    'design.html', 'kanban.html', 'planning.html',
    'setup.html', 'implementation.html', 'project.html', 'tickets.html',
];

// Size modifiers are not icons — they carry no mask and need no asset.
const MODIFIERS = new Set(['sm', 'xs', 'lg']);

const RULE_RE = /\.sb-icon-([a-z0-9-]+)\s*\{[^}]*?mask-image:\s*url\('data:image\/svg\+xml;base64,([^']*)'\)/g;
// Selector-agnostic sweep. Pseudo-element icons (kanban.html's `content: ''` + mask
// sites) carry a mask without an `.sb-icon-<name>` class, so a class-keyed check walks
// straight past them — four corrupt payloads hid there. Every inlined SVG mask anywhere
// under src/webview is claimed by the `<!-- source: icons/icon-<name>.svg -->` header
// its own asset carries, so match on that instead of on the selector.
const ANY_MASK_RE = /mask-image:\s*url\('data:image\/svg\+xml;base64,([^']*)'\)/g;
const SOURCE_HEADER_RE = /source: icons\/icon-([a-z0-9-]+)\.svg/;
const TOKEN_RE = /\bsb-icon-([a-z0-9-]+)\b/g;
const COMPANION_RE = /\{\{([A-Z0-9]+)_JS_URI\}\}/g;

const assets = new Map();
for (const file of fs.readdirSync(iconsDir).filter(f => /^icon-.*\.svg$/.test(f))) {
    assets.set(file.replace(/^icon-|\.svg$/g, ''), fs.readFileSync(path.join(iconsDir, file)).toString('base64'));
}

const errors = [];
let checkedRules = 0;

const lineOf = (content, index) => content.slice(0, index).split('\n').length;

for (const panel of PANELS) {
    const panelPath = path.join(webviewDir, panel);
    if (!fs.existsSync(panelPath)) {
        errors.push(`${panel}: listed in PANELS but the file does not exist`);
        continue;
    }
    const css = fs.readFileSync(panelPath, 'utf8');

    // 1 + 2 — asset parity and asset existence for every declared rule.
    const declared = new Set();
    let match;
    RULE_RE.lastIndex = 0;
    while ((match = RULE_RE.exec(css)) !== null) {
        const [, name, inlined] = match;
        const line = lineOf(css, match.index);
        declared.add(name);
        checkedRules++;
        const canonical = assets.get(name);
        if (canonical === undefined) {
            errors.push(`${panel}:${line} .sb-icon-${name} has no icons/icon-${name}.svg asset`);
        } else if (canonical !== inlined) {
            errors.push(
                `${panel}:${line} .sb-icon-${name} inlined base64 differs from icons/icon-${name}.svg ` +
                `(asset ${canonical.length} chars, inlined ${inlined.length}) — re-encode from the asset`
            );
        }
    }

    // 3 — rule coverage across the panel and any companion script it loads.
    const sources = [{ label: panel, text: css }];
    COMPANION_RE.lastIndex = 0;
    let companion;
    while ((companion = COMPANION_RE.exec(css)) !== null) {
        const jsFile = `${companion[1].toLowerCase()}.js`;
        const jsPath = path.join(webviewDir, jsFile);
        if (fs.existsSync(jsPath)) sources.push({ label: jsFile, text: fs.readFileSync(jsPath, 'utf8') });
    }

    for (const { label, text } of sources) {
        const seen = new Set();
        TOKEN_RE.lastIndex = 0;
        let token;
        while ((token = TOKEN_RE.exec(text)) !== null) {
            const name = token[1];
            if (MODIFIERS.has(name) || seen.has(name)) continue;
            seen.add(name);
            if (!declared.has(name)) {
                errors.push(
                    `${label}:${lineOf(text, token.index)} uses sb-icon-${name} but ${panel} declares no ` +
                    `.sb-icon-${name} mask rule — it will paint a solid currentColor block`
                );
            }
        }
    }
}

// 4 — selector-agnostic sweep over EVERY inlined SVG mask in the webview tree, so a mask
// attached to a pseudo-element (or any selector shape nobody anticipated) is still gated.
let sweptMasks = 0;
for (const file of fs.readdirSync(webviewDir).filter(f => /\.(html|js)$/.test(f))) {
    const content = fs.readFileSync(path.join(webviewDir, file), 'utf8');
    ANY_MASK_RE.lastIndex = 0;
    let mask;
    while ((mask = ANY_MASK_RE.exec(content)) !== null) {
        sweptMasks++;
        const inlined = mask[1];
        const line = lineOf(content, mask.index);
        const decoded = Buffer.from(inlined, 'base64').toString('utf8');
        const claimed = (decoded.match(SOURCE_HEADER_RE) || [])[1];
        if (!claimed) {
            errors.push(
                `${file}:${line} inlined SVG mask carries no "source: icons/icon-<name>.svg" header — ` +
                `it cannot be traced to an asset, so drift in it is undetectable`
            );
            continue;
        }
        const canonical = assets.get(claimed);
        if (canonical === undefined) {
            errors.push(`${file}:${line} inlined mask claims icons/icon-${claimed}.svg, which does not exist`);
        } else if (canonical !== inlined) {
            errors.push(
                `${file}:${line} inlined mask differs from icons/icon-${claimed}.svg ` +
                `(asset ${canonical.length} chars, inlined ${inlined.length}) — re-encode from the asset`
            );
        }
    }
}

if (errors.length) {
    console.error('Icon parity check FAILED:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
}
console.log(
    `Icon parity check passed (${checkedRules} .sb-icon rules across ${PANELS.length} panels, ` +
    `${sweptMasks} inlined masks swept, ${assets.size} assets).`
);
