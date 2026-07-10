#!/usr/bin/env node
/**
 * Protocol Catalog Scanner — Feature A · A1
 *
 * Scans the five Provider files for message-handler `case` arms and the
 * webview sources for `postMessage` call sites, then emits a checked-in
 * `protocol-catalog.json` at the repo root. This is A2b's burn-down
 * checklist, the CI parity-gate fixture, and the `GET /catalog`
 * discoverability layer.
 *
 * Approach: regex to locate each provider's message-handler switch block,
 * then brace-depth tracking to extract only the `case` arms inside that
 * block (avoids counting unrelated switch statements). Webview scan is
 * regex over `postMessage({type: '...'})` call sites.
 *
 * Manual review step: any `case`/`postMessage` where the `type` field is
 * not a string literal is flagged in `catalog.manualReview` so A2b's
 * parity gate has no silent gaps.
 *
 * Usage: node scripts/generate-protocol-catalog.js [--write]
 *   --write  overwrite the checked-in protocol-catalog.json (CI drift check
 *            runs without --write and exits non-zero on drift).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const CATALOG_PATH = path.join(REPO_ROOT, 'protocol-catalog.json');

const PROVIDERS = [
    { name: 'Kanban', file: 'src/services/KanbanProvider.ts', switchPattern: /switch\s*\(msg\.type\)/ },
    { name: 'Planning', file: 'src/services/PlanningPanelProvider.ts', switchPattern: /switch\s*\(msg\.type\)/ },
    { name: 'Design', file: 'src/services/DesignPanelProvider.ts', switchPattern: /switch\s*\(message\.type\)/ },
    { name: 'TaskViewer', file: 'src/services/TaskViewerProvider.ts', switchPattern: /switch\s*\(data\.type\)/ },
    { name: 'Setup', file: 'src/services/SetupPanelProvider.ts', switchPattern: /switch\s*\(message\?\.type\)/ },
];

const WEBVIEW_DIRS = [
    'src/webview',
];

// ─── Helpers ─────────────────────────────────────────────────────────────

function readFile(p) {
    return fs.readFileSync(p, 'utf8');
}

/**
 * Extract `case 'verb':` / `case "verb":` arms from the message-handler
 * switch block in a provider file. Returns an array of
 * { verb, line, dynamic } where `dynamic` is true for template-literal
 * or non-string-literal case values.
 */
function extractHandlerArms(file, switchPattern) {
    const src = readFile(path.join(REPO_ROOT, file));
    const lines = src.split('\n');

    // Find the message-handler switch line.
    let switchLineIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (switchPattern.test(lines[i])) {
            switchLineIdx = i;
            break;
        }
    }
    if (switchLineIdx === -1) {
        return { arms: [], warning: `no message-handler switch found in ${file}` };
    }

    // Track brace depth from the switch's opening `{` to find its end.
    let depth = 0;
    let started = false;
    const arms = [];
    const caseRe = /case\s+(['"])([^'"]+)\1\s*:/;
    const dynamicCaseRe = /case\s+(`|[^'"\s])/; // template literal or expression

    for (let i = switchLineIdx; i < lines.length; i++) {
        const line = lines[i];
        for (const ch of line) {
            if (ch === '{') { depth++; started = true; }
            else if (ch === '}') { depth--; }
        }
        // The switch's own `{` bumps depth to 1; when it returns to 0 we're done.
        if (started && depth === 0) break;

        // Skip comment-only lines (avoid false-positive "case" matches in comments).
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
        const m = line.match(caseRe);
        if (m) {
            arms.push({ verb: m[2], line: i + 1, dynamic: false });
        } else if (dynamicCaseRe.test(line) && /case\s+/.test(line)) {
            // Non-string-literal case — flag for manual review.
            arms.push({ verb: null, line: i + 1, dynamic: true, raw: line.trim() });
        }
    }
    return { arms };
}

/**
 * 1-based line number of a character offset within `content`.
 */
function lineOf(content, index) {
    let line = 1;
    const end = Math.min(index, content.length);
    for (let i = 0; i < end; i++) {
        if (content[i] === '\n') line++;
    }
    return line;
}

/**
 * Statically extract the top-level key names of an object literal whose opening `{`
 * is at `braceOpenIdx` in `content`. Returns { keys, dynamic }:
 *   - `keys`: the literal's top-level key names (string[]), in source order.
 *   - `dynamic`: true if the literal cannot be statically keyed — any spread (`...x`),
 *     computed key (`[k]`), or a non-object-literal argument (caller checks the latter).
 *
 * Honest under-claiming: a wrong `payloadKeys` list is worse than `"dynamic"` because
 * agents trust it. Prefer flagging dynamic over guessing. Nested objects/arrays are
 * descended into for brace matching but their keys are NOT collected (only top-level
 * keys of the message literal are payload fields). String/template-literal contents are
 * skipped so braces/colons inside them do not corrupt the parse.
 */
function extractPayloadKeys(content, braceOpenIdx) {
    const keys = [];
    let dynamic = false;
    const n = content.length;
    let i = braceOpenIdx;
    if (content[i] !== '{') return { keys, dynamic: true };
    let depth = 0;
    // `expectKey` is true at positions where a top-level key may start: just after the
    // opening `{` or after a top-level `,`. At depth 1 only.
    let expectKey = true;
    while (i < n) {
        const ch = content[i];
        // Whitespace — skip, preserve expectKey.
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
        if (depth === 1 && expectKey) {
            // We're at a key-start position inside the message object.
            // A `}` here means the object is closing (e.g. after a trailing comma or
            // right after a nested value whose close re-armed expectKey) — return the
            // collected keys, do not bail. A `,` here is an elision — skip it.
            if (ch === '}') { return { keys, dynamic }; }
            if (ch === ',') { i++; continue; }
            if (ch === '.') {
                // Possible spread `...x`
                if (content[i + 1] === '.' && content[i + 2] === '.') {
                    dynamic = true;
                    return { keys, dynamic };
                }
                // Otherwise unexpected leading dot — treat conservatively.
                dynamic = true;
                return { keys, dynamic };
            }
            if (ch === '[') {
                // Computed key `[expr]:` → dynamic.
                dynamic = true;
                return { keys, dynamic };
            }
            if (ch === "'" || ch === '"') {
                // Quoted key: 'key': value  /  "key": value
                const quote = ch;
                let j = i + 1;
                let str = '';
                while (j < n) {
                    const c = content[j];
                    if (c === '\\') { str += content[j + 1] || ''; j += 2; continue; }
                    if (c === quote) break;
                    str += c; j++;
                }
                // j now at closing quote. Skip whitespace, expect ':'.
                let k = j + 1;
                while (k < n && /\s/.test(content[k])) k++;
                if (content[k] === ':') {
                    keys.push(str);
                    expectKey = false;
                    i = k + 1;
                    continue;
                }
                // Quoted literal not followed by ':' — not a keyed field. Conservative.
                dynamic = true;
                return { keys, dynamic };
            }
            if (/[A-Za-z_$]/.test(ch)) {
                // Identifier key or shorthand. Read identifier.
                let j = i;
                let id = '';
                while (j < n && /[A-Za-z0-9_$]/.test(content[j])) { id += content[j]; j++; }
                let k = j;
                while (k < n && /\s/.test(content[k])) k++;
                if (content[k] === ':') {
                    keys.push(id);
                    expectKey = false;
                    i = k + 1;
                    continue;
                }
                if (content[k] === ',' || content[k] === '}') {
                    // Shorthand: { tabKey } → key 'tabKey'. Leave i on the `,`/`}` and
                    // set expectKey=false so the structural branch below re-arms
                    // expectKey (`,` → true) or closes the literal (`}` → depth 0).
                    keys.push(id);
                    expectKey = false;
                    i = k;
                    continue;
                }
                // Identifier followed by something else (e.g. `(` method shorthand) —
                // not a simple payload key. Conservative: flag dynamic.
                dynamic = true;
                return { keys, dynamic };
            }
            // Unexpected key-start char — conservative.
            dynamic = true;
            return { keys, dynamic };
        }
        // Not at a key-start (or depth != 1): handle structural chars & strings.
        if (ch === '{') { depth++; i++; continue; }
        if (ch === '}') {
            depth--;
            if (depth === 0) return { keys, dynamic };
            // Do NOT re-arm expectKey here: after a nested value closes, the next token
            // is either `,` (which re-arms) or the outer `}` (which closes). Re-arming
            // here left expectKey=true at the outer `}`, bailing dynamic on literals
            // whose last field was a nested object/array.
            i++;
            continue;
        }
        if (ch === '[') { depth++; i++; continue; }
        if (ch === ']') { depth--; i++; continue; }
        // Parentheses bump depth too, so commas inside call args / parenthesized
        // expressions (e.g. `slice(0, idx)`) do NOT re-arm expectKey at the object's
        // top level and identifiers inside them are not misread as keys.
        if (ch === '(') { depth++; i++; continue; }
        if (ch === ')') { depth--; i++; continue; }
        if (ch === ',' ) {
            if (depth === 1) { expectKey = true; }
            i++;
            continue;
        }
        if (ch === ':') { i++; continue; } // value separator (we already consumed key:`:`)
        if (ch === "'" || ch === '"') {
            // Skip a string literal (value side).
            const quote = ch;
            let j = i + 1;
            while (j < n) {
                const c = content[j];
                if (c === '\\') { j += 2; continue; }
                if (c === quote) { j++; break; }
                j++;
            }
            i = j;
            continue;
        }
        if (ch === '`') {
            // Template literal — skip, accounting for ${...} interpolations (which may
            // contain nested braces/strings). Track brace depth inside interpolations.
            let j = i + 1;
            while (j < n) {
                const c = content[j];
                if (c === '\\') { j += 2; continue; }
                if (c === '`') { j++; break; }
                if (c === '$' && content[j + 1] === '{') {
                    // Interpolation: skip until matching }, tracking braces/strings.
                    j += 2;
                    let d = 1;
                    while (j < n && d > 0) {
                        const ic = content[j];
                        if (ic === '\\') { j += 2; continue; }
                        if (ic === '{') { d++; j++; continue; }
                        if (ic === '}') { d--; j++; continue; }
                        if (ic === "'" || ic === '"') {
                            const iq = ic;
                            j++;
                            while (j < n) {
                                const jc = content[j];
                                if (jc === '\\') { j += 2; continue; }
                                if (jc === iq) { j++; break; }
                                j++;
                            }
                            continue;
                        }
                        if (ic === '`') {
                            // Nested template literal — recurse-ish: skip it simply.
                            j++;
                            let nd = 1;
                            while (j < n && nd > 0) {
                                if (content[j] === '\\') { j += 2; continue; }
                                if (content[j] === '`') { nd--; }
                                j++;
                            }
                            continue;
                        }
                        j++;
                    }
                    continue;
                }
                j++;
            }
            i = j;
            continue;
        }
        // Line comment
        if (ch === '/' && content[i + 1] === '/') {
            let j = i + 2;
            while (j < n && content[j] !== '\n') j++;
            i = j;
            continue;
        }
        // Block comment
        if (ch === '/' && content[i + 1] === '*') {
            let j = i + 2;
            while (j < n && !(content[j] === '*' && content[j + 1] === '/')) j++;
            i = j + 2;
            continue;
        }
        // Any other char (value content, operators, numbers) — skip.
        i++;
    }
    // Ran off the end without closing the literal — conservative.
    return { keys, dynamic: true };
}


/**
 * Scan webview + provider sources for postMessage call sites.
 * - `postMessage({type: '...'})` → webview→host (direction: 'request')
 * - `*.postMessage({type: '...'})` where the receiver is a webview/panel
 *   → host→webview push (direction: 'push')
 *
 * Scans over FULL FILE CONTENT (not line-by-line). The `\s*` in the regex spans
 * newlines, so multi-line-formatted calls — `postMessage({\n    type: '...'\n})` —
 * are captured. A per-line scan silently drops every call whose `type:` sits on a
 * line after `postMessage({`; that dropped ~572 multi-line sites / 112 push verbs.
 */
function extractWebviewSites() {
    const sites = [];
    const manualReview = [];
    // String-literal type; identifier/template-literal type flagged for manual review.
    const litRe = /(\w[\w.?]*\.)?postMessage\s*\(\s*\{\s*type\s*:\s*(['"])([^'"]+)\2/g;
    const dynRe = /(\w[\w.?]*\.)?postMessage\s*\(\s*\{\s*type\s*:\s*(`|[A-Za-z_$])/g;

    function scanFile(full, fileRel, opts) {
        const providerName = opts && opts.providerName;
        const requireReceiver = !!(opts && opts.requireReceiver);
        const content = readFile(full);
        let m;
        litRe.lastIndex = 0;
        while ((m = litRe.exec(content)) !== null) {
            const receiver = m[1] ? m[1].replace(/\.$/, '') : '';
            // In webview JS, bare `postMessage(...)` (acquireVsCodeApi) and `vscode.postMessage`
            // are webview→host. A `*.webview.postMessage` receiver is host→webview push.
            const isWebviewToHost = !receiver || receiver === 'vscode';
            if (requireReceiver && !receiver) continue; // bare postMessage in a provider is unusual; skip
            const site = {
                verb: m[3],
                direction: (requireReceiver || !isWebviewToHost) ? 'push' : 'request',
                file: fileRel,
                line: lineOf(content, m.index),
                receiver: receiver || null,
            };
            if (providerName) site.provider = providerName;
            // Payload-key extraction: brace-match the object literal starting at the `{`
            // inside the matched `postMessage({…})` and read its top-level keys. Sites
            // whose payload is not statically keyable (spread/computed/non-literal) get
            // `payloadKeys: "dynamic"` — never guess.
            const braceIdx = m.index + m[0].indexOf('{');
            const pk = extractPayloadKeys(content, braceIdx);
            site.payloadKeys = pk.dynamic ? 'dynamic' : pk.keys;
            sites.push(site);
        }
        // Routed push sites via the broadcast chokepoint:
        //   `_pushTo(panel, 'surface', {type:'X'})` / `broadcaster.pushTo(webview, 'surface', {type:'X'})`
        // These replace direct `panel.webview.postMessage({type:...})` (the Gap-A push-site
        // audit) — still host→UI push sites, so keep enumerating them or the catalog
        // silently under-counts every push that moved to the transport layer.
        const pushToRe = /\b_?pushTo\s*\(\s*[^,]+,\s*(['"])([^'"]+)\1\s*,\s*\{\s*type\s*:\s*(['"])([^'"]+)\3/g;
        pushToRe.lastIndex = 0;
        while ((m = pushToRe.exec(content)) !== null) {
            const site = {
                verb: m[4],
                direction: 'push',
                file: fileRel,
                line: lineOf(content, m.index),
                receiver: `pushTo:${m[2]}`,
            };
            if (providerName) site.provider = providerName;
            const braceIdx = m.index + m[0].indexOf('{');
            const pk = extractPayloadKeys(content, braceIdx);
            site.payloadKeys = pk.dynamic ? 'dynamic' : pk.keys;
            sites.push(site);
        }
        dynRe.lastIndex = 0;
        while ((m = dynRe.exec(content)) !== null) {
            const c = m[2][0];
            if (c === '"' || c === "'") continue; // string literal — already caught above
            const nl = content.indexOf('\n', m.index);
            manualReview.push({
                kind: 'dynamic-postMessage-type',
                file: fileRel,
                line: lineOf(content, m.index),
                raw: content.slice(m.index, nl === -1 ? content.length : nl).trim(),
            });
        }
    }

    function scanDir(dir) {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const ent of entries) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) { scanDir(full); }
            else if (/\.(js|ts|html)$/.test(ent.name)) {
                scanFile(full, path.relative(REPO_ROOT, full), {});
            }
        }
    }

    // Provider files: host→webview push sites (receiver required).
    for (const p of PROVIDERS) {
        scanFile(path.join(REPO_ROOT, p.file), p.file, { providerName: p.name, requireReceiver: true });
    }

    for (const dir of WEBVIEW_DIRS) scanDir(path.join(REPO_ROOT, dir));
    return { sites, manualReview };
}

/**
 * Enumerate existing LocalApiServer routes from the if-else chain.
 */
function extractApiEndpoints() {
    const src = readFile(path.join(REPO_ROOT, 'src/services/LocalApiServer.ts'));
    const lines = src.split('\n');
    const endpoints = [];
    // Match route arms in the if-else chain. Lines look like:
    //   `if (pathname === '/health') {`
    //   `} else if (pathname === '/kanban/move' && req.method === 'POST') {`
    //   `} else if (pathname.startsWith('/task/clickup/') && pathname.endsWith('/move') && req.method === 'PUT') {`
    const pathExactRe = /pathname\s*===\s*(['"])([^'"]+)\1/;
    const pathStartsRe = /pathname\.startsWith\(\s*(['"])([^'"]+)\1\s*\)/;
    const methodRe = /req\.method\s*===\s*(['"])(\w+)\1/;
    for (const line of lines) {
        if (!/pathname\s*(?:===|\.startsWith)/.test(line)) continue;
        if (!/req\.method\s*===/.test(line) && !/pathname\s*===\s*['"]\/health['"]/.test(line)) {
            // /health has no method check — special-case it.
        }
        const em = line.match(methodRe);
        const method = em ? em[2] : 'GET'; // /health defaults to GET
        const sm = line.match(pathStartsRe);
        const xm = line.match(pathExactRe);
        const pathStr = (sm && sm[2]) || (xm && xm[2]);
        if (!pathStr) continue;
        endpoints.push({ path: pathStr, method, prefix: !!sm });
    }
    return endpoints;
}

// ─── Main ────────────────────────────────────────────────────────────────

function buildCatalog() {
    const providers = {};
    const manualReview = [];
    let totalArms = 0;
    let totalVerbs = 0;
    const allVerbs = new Set();

    for (const p of PROVIDERS) {
        const { arms, warning } = extractHandlerArms(p.file, p.switchPattern);
        if (warning) manualReview.push({ kind: 'missing-switch', provider: p.name, detail: warning });
        const verbs = new Set();
        for (const a of arms) {
            if (a.dynamic) {
                manualReview.push({ kind: 'dynamic-case', provider: p.name, file: p.file, line: a.line, raw: a.raw });
            } else {
                verbs.add(a.verb);
                allVerbs.add(a.verb);
            }
        }
        providers[p.name] = {
            file: p.file,
            armCount: arms.length,
            dynamicArms: arms.filter(a => a.dynamic).length,
            verbs: Array.from(verbs).sort(),
            arms: arms.map(a => ({ verb: a.verb, line: a.line, dynamic: a.dynamic, raw: a.dynamic ? a.raw : undefined })),
        };
        totalArms += arms.length;
        totalVerbs += verbs.size;
    }

    const { sites, manualReview: wvReview } = extractWebviewSites();
    manualReview.push(...wvReview);

    // Classify verbs: a verb is a "push" if it only appears as a push site,
    // "request" if it appears in a handler arm, "bidirectional" if both.
    const handlerVerbs = new Set();
    for (const p of PROVIDERS) {
        for (const v of providers[p.name].verbs) handlerVerbs.add(v);
    }
    const pushVerbs = new Set();
    const requestVerbs = new Set();
    for (const s of sites) {
        if (s.direction === 'push') pushVerbs.add(s.verb);
        else requestVerbs.add(s.verb);
    }

    const verbTable = [];
    for (const verb of Array.from(allVerbs).sort()) {
        const inHandler = handlerVerbs.has(verb);
        const inPush = pushVerbs.has(verb);
        const inRequest = requestVerbs.has(verb);
        let direction;
        if (inHandler && inPush) direction = 'request-response+push';
        else if (inHandler) direction = 'request-response';
        else if (inPush) direction = 'push';
        else if (inRequest) direction = 'request';
        else direction = 'unknown';
        const owner = PROVIDERS.find(p => providers[p.name].verbs.includes(verb))?.name || null;
        verbTable.push({
            verb,
            direction,
            provider: owner,
            proposedService: owner ? `${owner.toLowerCase()}Service` : null,
        });
    }

    // Per-verb payload-key aggregation. Each site already carries `payloadKeys`
    // (string[] | "dynamic"). Aggregate across every site for a verb: if all sites
    // agree on the same key set, that set is the verb's payload; if any site is
    // "dynamic" or two sites disagree, the verb is "dynamic" (conservative — a wrong
    // list is worse than "dynamic" because agents trust it). `siteCount` records how
    // many call sites contributed, so a single-site verb is distinguishable from one
    // confirmed by many.
    const verbPayloads = {};
    const byVerb = new Map();
    for (const s of sites) {
        if (!byVerb.has(s.verb)) byVerb.set(s.verb, []);
        byVerb.get(s.verb).push(s);
    }
    for (const verb of Array.from(byVerb.keys()).sort()) {
        const verbSites = byVerb.get(verb);
        const sigs = verbSites.map(s => (s.payloadKeys === 'dynamic' ? 'dynamic' : s.payloadKeys.join(',')));
        const unique = Array.from(new Set(sigs));
        let payloadKeys;
        if (unique.length === 1 && unique[0] !== 'dynamic') {
            payloadKeys = verbSites[0].payloadKeys;
        } else if (unique.length === 1 && unique[0] === 'dynamic') {
            payloadKeys = 'dynamic';
        } else {
            // Mixed or dynamic-among-literal → conservative.
            payloadKeys = 'dynamic';
        }
        verbPayloads[verb] = { payloadKeys, siteCount: verbSites.length };
    }

    const apiEndpoints = extractApiEndpoints();

    return {
        version: 1,
        generatedAt: new Date().toISOString(),
        summary: {
            totalArms,
            totalVerbs: allVerbs.size,
            totalPushSites: sites.filter(s => s.direction === 'push').length,
            totalRequestSites: sites.filter(s => s.direction === 'request').length,
            providerArmCounts: Object.fromEntries(
                PROVIDERS.map(p => [p.name, providers[p.name].armCount])
            ),
            apiEndpointCount: apiEndpoints.length,
            manualReviewCount: manualReview.length,
        },
        providers,
        verbs: verbTable,
        verbPayloads,
        pushSites: sites.filter(s => s.direction === 'push'),
        requestSites: sites.filter(s => s.direction === 'request'),
        apiEndpoints,
        manualReview,
    };
}

function main() {
    const args = process.argv.slice(2);
    const write = args.includes('--write');
    const catalog = buildCatalog();

    if (write) {
        fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + '\n');
        console.error(`[catalog] wrote ${path.relative(REPO_ROOT, CATALOG_PATH)} — ${catalog.summary.totalArms} arms, ${catalog.summary.totalVerbs} verbs, ${catalog.summary.totalPushSites} push sites, ${catalog.summary.manualReviewCount} manual-review items`);
        return;
    }

    // Drift check: compare regenerated vs checked-in.
    let existing = null;
    try { existing = readFile(CATALOG_PATH); }
    catch { /* not generated yet */ }

    if (!existing) {
        console.error(`[catalog] ${path.relative(REPO_ROOT, CATALOG_PATH)} not found — run \`node scripts/generate-protocol-catalog.js --write\` first`);
        process.exit(1);
    }

    const existingJson = JSON.parse(existing);
    // Compare the CONTRACT only — ignore volatile metadata that churns without a
    // protocol change: `generatedAt` (a timestamp) and every `line:` number (shifts
    // whenever any code ABOVE an arm/push site moves). A drift gate keyed on line
    // numbers is a false-positive treadmill that fails CI on unrelated edits — the
    // committed tree was already red for exactly this reason.
    const stripVolatile = (key, val) => (key === 'generatedAt' || key === 'line') ? undefined : val;
    const a = JSON.stringify(existingJson, stripVolatile, 2);
    const b = JSON.stringify(catalog, stripVolatile, 2);
    if (a !== b) {
        console.error(`[catalog] drift detected — regenerated catalog differs from checked-in`);
        console.error(`[catalog] run \`node scripts/generate-protocol-catalog.js --write\` and commit the result`);
        process.exit(1);
    }
    console.error(`[catalog] OK — no drift (${catalog.summary.totalArms} arms, ${catalog.summary.totalVerbs} verbs)`);
}

main();
