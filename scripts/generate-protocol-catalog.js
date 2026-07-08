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
 * Scan webview sources for postMessage call sites.
 * - `postMessage({type: '...'})` → webview→host (direction: 'request')
 * - `*.postMessage({type: '...'})` where the receiver is a webview/panel
 *   → host→webview push (direction: 'push')
 */
function extractWebviewSites() {
    const sites = [];
    const manualReview = [];
    const pushRe = /(\w[\w.]*\.)?postMessage\s*\(\s*\{\s*type\s*:\s*(['"])([^'"]+)\2/g;
    const dynamicTypeRe = /(\w[\w.]*\.)?postMessage\s*\(\s*\{\s*type\s*:\s*(`|[^'"\s])/g;

    function scanDir(dir) {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const ent of entries) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) { scanDir(full); }
            else if (/\.(js|ts|html)$/.test(ent.name)) {
                const src = readFile(full);
                const lines = src.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    let m;
                    pushRe.lastIndex = 0;
                    while ((m = pushRe.exec(lines[i])) !== null) {
                        const receiver = m[1] ? m[1].replace(/\.$/, '') : '';
                        // In webview JS, bare `postMessage(...)` (acquireVsCodeApi) is webview→host.
                        // Receiver like `webview.postMessage` / `this._panel?.webview.postMessage` is host→webview push.
                        const isWebviewToHost = !receiver || receiver === 'vscode';
                        sites.push({
                            verb: m[3],
                            direction: isWebviewToHost ? 'request' : 'push',
                            file: path.relative(REPO_ROOT, full),
                            line: i + 1,
                            receiver: receiver || null,
                        });
                    }
                    dynamicTypeRe.lastIndex = 0;
                    let dm;
                    while ((dm = dynamicTypeRe.exec(lines[i])) !== null) {
                        // Avoid double-counting entries the string-literal regex already caught.
                        const col = dm.index;
                        const prefix = lines[i].slice(0, col);
                        if (pushRe.test(prefix + lines[i].slice(col).replace(/(`|[^'"\s])/, "'"))) continue;
                        manualReview.push({
                            kind: 'dynamic-postMessage-type',
                            file: path.relative(REPO_ROOT, full),
                            line: i + 1,
                            raw: lines[i].trim(),
                        });
                    }
                }
            }
        }
    }

    // Also scan provider files for host→webview push sites.
    for (const p of PROVIDERS) {
        const src = readFile(path.join(REPO_ROOT, p.file));
        const lines = src.split('\n');
        for (let i = 0; i < lines.length; i++) {
            let m;
            const re = /(\w[\w.?]*\.)?postMessage\s*\(\s*\{\s*type\s*:\s*(['"])([^'"]+)\2/g;
            while ((m = re.exec(lines[i])) !== null) {
                const receiver = m[1] ? m[1].replace(/\.$/, '') : '';
                if (!receiver) continue; // bare postMessage in a provider is unusual; skip
                sites.push({
                    verb: m[3],
                    direction: 'push',
                    file: p.file,
                    line: i + 1,
                    receiver,
                    provider: p.name,
                });
            }
        }
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
    // Compare the structural fields (ignore generatedAt).
    const strip = (o) => { const { generatedAt, ...rest } = o; return rest; };
    const a = JSON.stringify(strip(existingJson), null, 2);
    const b = JSON.stringify(strip(catalog), null, 2);
    if (a !== b) {
        console.error(`[catalog] drift detected — regenerated catalog differs from checked-in`);
        console.error(`[catalog] run \`node scripts/generate-protocol-catalog.js --write\` and commit the result`);
        process.exit(1);
    }
    console.error(`[catalog] OK — no drift (${catalog.summary.totalArms} arms, ${catalog.summary.totalVerbs} verbs)`);
}

main();
