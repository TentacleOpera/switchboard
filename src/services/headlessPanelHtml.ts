/*
 * Headless panel HTML rendering — shared between standalone bootstrap and
 * the extension's LocalApiServer (TaskViewerProvider).
 *
 * Both hosts serve the same browser UI: shell + panel iframes. These functions
 * read the webview HTML files, replace vscode-webview URI placeholders with
 * /static/... paths, inject the browser transport shim, and return {html, csp}.
 *
 * Feature: Headless Browser UI.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface HostCapabilities {
    terminalDispatch?: boolean;
    automation?: boolean;
    orchestrator?: boolean;
    terminalFleet?: boolean;
    mcpTerminals?: boolean;
    secretsEntry?: boolean;
    featureManagement?: boolean;
    worktrees?: boolean;
    uat?: boolean;
    boardStructure?: boolean;
    featureAdvanced?: boolean;
    integrationsConfigured?: { clickup?: boolean; linear?: boolean; notion?: boolean; stitch?: boolean };
}

const DEFAULT_HOST_CAPABILITIES: HostCapabilities = {
    terminalDispatch: false,
    automation: false,
    orchestrator: false,
    terminalFleet: false,
    mcpTerminals: false,
    secretsEntry: false,
    featureManagement: false,
    worktrees: false,
    uat: false,
    boardStructure: false,
    featureAdvanced: false,
};

export function findFile(candidates: string[]): string | undefined {
    for (const c of candidates) {
        try {
            if (fs.existsSync(c)) { return c; }
        } catch { /* ignore */ }
    }
    return undefined;
}

export function htmlEscapeJson(json: string): string {
    return json.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function makeNonce(): string {
    return crypto.randomBytes(16).toString('base64');
}

/**
 * Inject `sharedDefaults.js` + `transport.js` ahead of a panel's own scripts.
 *
 * `expectMarker` says whether THIS panel is one of the marker-shaped ones
 * (kanban.html / setup.html — an inline `<script>` preceded by the comment).
 * Only those may warn on the fallback: project.html / planning.html /
 * design.html have never carried the marker, so for them the first-script
 * anchor IS the designed path. Warning there would fire on every render of
 * three panels and bury the one case worth hearing about — the accidental
 * marker deletion that shipped a dead Setup panel in 1.7.13.
 */
function injectTransportShim(content: string, nonce: string, marker: string, firstScript: string, expectMarker = false): string {
    const shim = `<script src="/static/webview/sharedDefaults.js" nonce="${nonce}"></script>\n<script src="/static/webview/transport.js" nonce="${nonce}"></script>`;
    // If a marker comment exists (kanban.html / setup.html shape), replace it.
    if (content.includes(marker)) {
        return content.replace(marker, shim);
    }
    // Otherwise inject before the first script tag (design.html / project.html shape).
    if (!content.includes(firstScript)) {
        console.error('[headlessPanelHtml] transport shim NOT injected: no marker and no first-script anchor. The panel will throw on acquireVsCodeApi().');
        return content;
    }
    if (expectMarker) {
        console.warn('[headlessPanelHtml] SHARED_DEFAULTS_SCRIPT marker missing — injected the shim before the first script instead.');
    }
    return content.replace(firstScript, `${shim}\n${firstScript}`);
}

/**
 * Rewrite a panel's real `<body>` tag.
 *
 * Anchored AFTER `</head>` for a load-bearing reason: a naive first-match
 * `content.replace(/<body/, ...)` matches the first *textual* occurrence, which is
 * not necessarily the tag. terminals.html grew a CSS comment mentioning `<body>` in
 * prose, and all three injections (workspace root / panel id / host capabilities,
 * the theme class, and TaskViewerProvider's data-terminal-token) stacked onto the
 * comment instead. The real `<body>` shipped bare, so terminals.js read no token,
 * every /ws/terminal upgrade 401'd against rejectWhenTokenEmpty, and the browser
 * fleet rendered terminals that accepted no input.
 *
 * `<body` cannot legally appear before `</head>`, so the first match past that
 * boundary is the tag itself — prose, inline CSS, and inline JS in <head> are all
 * excluded by construction. Every panel HTML has `</head>`; if one somehow does not,
 * fall back to scanning from the start rather than silently skipping the injection.
 */
function rewriteBodyTag(content: string, rewrite: (attrs: string) => string): string {
    const headEnd = content.search(/<\/head\s*>/i);
    const from = headEnd === -1 ? 0 : headEnd;
    const match = /<body\b([^>]*)>/i.exec(content.slice(from));
    if (!match) {
        console.error('[headlessPanelHtml] no <body> tag found — body attributes NOT injected.');
        return content;
    }
    const start = from + match.index;
    return content.slice(0, start) + rewrite(match[1]) + content.slice(start + match[0].length);
}

/**
 * Add attributes to a panel's real `<body>` tag, preserving the ones already there.
 * Exported because TaskViewerProvider appends the terminal session token to the
 * already-rendered HTML and must use the same anchor — see rewriteBodyTag.
 */
export function injectBodyAttributes(content: string, attrs: string): string {
    if (!attrs) return content;
    return rewriteBodyTag(content, existing => `<body ${attrs}${existing}>`);
}

function applyThemeClass(content: string, themeClass?: string): string {
    if (!themeClass) return content;
    return rewriteBodyTag(content, attrs => {
        const withoutClass = attrs.replace(/\s*class="[^"]*"/i, '');
        return `<body${withoutClass} class="${htmlEscapeJson(themeClass)}">`;
    });
}

export interface PanelHtmlResult {
    html: string;
    csp: string;
}

/**
 * Resolve the repo root from a known file path inside the extension/standalone
 * bundle. In standalone, __dirname is dist/standalone/ → repo root is ../..
 * In the extension, extensionUri.fsPath is the extension root → use directly.
 */
export function resolveRepoRootFromDir(dir: string): string {
    return path.resolve(dir, '..', '..');
}

export function getShellHtml(repoRoot: string, themeClass?: string): PanelHtmlResult {
    const candidates = [
        path.join(repoRoot, 'dist', 'webview', 'shell.html'),
        path.join(repoRoot, 'src', 'webview', 'shell.html'),
    ];
    const htmlPath = findFile(candidates);
    if (!htmlPath) {
        return { html: '<html><body>Switchboard shell HTML not found.</body></html>', csp: '' };
    }
    let content = fs.readFileSync(htmlPath, 'utf8');
    const nonce = makeNonce();
    const csp = `default-src 'none'; script-src 'nonce-${nonce}' 'self'; style-src 'unsafe-inline' 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:* ws://localhost:* wss://localhost:* ws://*.localhost:* wss://*.localhost:*; frame-src 'self';`;
    content = content.replace(/\{\{NONCE\}\}/g, nonce);
    content = applyThemeClass(content, themeClass);
    return { html: content, csp };
}

export function getBoardHtml(repoRoot: string, workspaceRoot: string, capabilities?: HostCapabilities, themeClass?: string): PanelHtmlResult {
    const candidates = [
        path.join(repoRoot, 'dist', 'webview', 'kanban.html'),
        path.join(repoRoot, 'src', 'webview', 'kanban.html'),
    ];
    const htmlPath = findFile(candidates);
    if (!htmlPath) {
        return { html: '<html><body>Board HTML not found.</body></html>', csp: '' };
    }
    let content = fs.readFileSync(htmlPath, 'utf8');
    const nonce = makeNonce();
    const csp = `default-src 'self'; script-src 'nonce-${nonce}' 'self'; style-src 'unsafe-inline' 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:* ws://localhost:* wss://localhost:* ws://*.localhost:* wss://*.localhost:*; frame-src 'self';`;
    content = content.replace(/<script>/g, `<script nonce="${nonce}">`);
    // kanban.html carries the marker — pass expectMarker so its deletion warns.
    content = injectTransportShim(content, nonce, '<!-- SHARED_DEFAULTS_SCRIPT -->', `<script nonce="${nonce}">`, true);
    const caps = { ...DEFAULT_HOST_CAPABILITIES, ...capabilities };
    const bodyAttr = `data-initial-workspace-root="${encodeURIComponent(workspaceRoot)}" data-panel="kanban" data-host-capabilities="${htmlEscapeJson(JSON.stringify(caps))}"`;
    content = injectBodyAttributes(content, bodyAttr);
    content = applyThemeClass(content, themeClass);

    // Icon replacements (kanban.html uses {{ICON_*}} placeholders).
    const iconDir = '/static/icons';
    const iconMap: Record<string, string> = {
        '{{ICON_22}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-78.png`,
        '{{ICON_COLLAPSE_CODERS}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-66 copy.png`,
        '{{ICON_28}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-24.png`,
        '{{ICON_REMOTE}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-28.png`,
        '{{ICON_53}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-53.png`,
        '{{ICON_54}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-54.png`,
        '{{ICON_115}}': `${iconDir}/25-101-150 Sci-Fi Flat icons-115.png`,
        '{{ICON_ANALYST_MAP}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-42.png`,
        '{{ICON_IMPORT_CLIPBOARD}}': `${iconDir}/25-101-150 Sci-Fi Flat icons-121.png`,
        '{{ICON_CLI}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-53.png`,
        '{{ICON_CLI_TRIGGERS}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-65.png`,
        '{{ICON_ULTRACODE}}': `${iconDir}/25-101-150 Sci-Fi Flat icons-102.png`,
        '{{ICON_GOAL}}': `${iconDir}/25-101-150 Sci-Fi Flat icons-139.png`,
        '{{ICON_PROMPT}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-22.png`,
        '{{ICON_55}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-55.png`,
        '{{ICON_85}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-85.png`,
        '{{ICON_CHAT}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-65.png`,
        '{{ICON_77}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-77.png`,
        '{{ICON_59}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-59.png`,
        '{{ICON_41}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-41.png`,
        '{{ICON_DELETE_PROJECT}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-46.png`,
        '{{ICON_IMPORT_PLANS}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-67.png`,
        '{{ICON_CODE_MAP}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-90.png`,
        '{{ICON_WORKTREE}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-68.png`,
        '{{ICON_WORKTREE_ACTIVE}}': `${iconDir}/worktree-active.svg`,
        '{{ICON_WORKTREE_MERGED}}': `${iconDir}/worktree-merged.svg`,
        '{{ICON_MANAGER_PASS}}': `${iconDir}/25-101-150 Sci-Fi Flat icons-125.png`,
    };
    for (const [placeholder, uri] of Object.entries(iconMap)) {
        content = content.split(placeholder).join(uri);
    }
    content = content.replace(/\{\{HANKEN_FONT_URI\}\}/g, '/static/designs/HankenGrotesk-Variable.woff2');
    content = content.replace(/\{\{GEIST_PIXEL_FONT_URI\}\}/g, '/static/designs/GeistPixel-Square.woff2');

    return { html: content, csp };
}

export function getProjectHtml(repoRoot: string, workspaceRoot: string, capabilities?: HostCapabilities, themeClass?: string): PanelHtmlResult {
    const candidates = [
        path.join(repoRoot, 'dist', 'webview', 'project.html'),
        path.join(repoRoot, 'src', 'webview', 'project.html'),
    ];
    const htmlPath = findFile(candidates);
    if (!htmlPath) {
        return { html: '<html><body>Project panel HTML not found.</body></html>', csp: '' };
    }
    let content = fs.readFileSync(htmlPath, 'utf8');
    const nonce = makeNonce();
    const csp = `default-src 'none'; script-src 'nonce-${nonce}' 'self' 'unsafe-eval'; script-src-attr 'unsafe-inline'; style-src 'unsafe-inline' 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:* ws://localhost:* wss://localhost:* ws://*.localhost:* wss://*.localhost:*; frame-src 'self' http: https: about:srcdoc blob: data:;`;
    content = content.replace(/\{\{NONCE\}\}/g, nonce);
    content = content.replace(/{{WEBVIEW_CSP_SOURCE}}/g, "'self'");
    // Browser cockpit: the shared template's meta CSP hardcodes `connect-src https:`
    // (written for the VS Code webview). In a plain browser that blocks the local
    // server's verb fetches (http://127.0.0.1) AND the WebSocket (ws://127.0.0.1),
    // so every panel comes up empty. Widen it to the loopback API/WS origins.
    content = content.replace('connect-src https:', "connect-src 'self' https: http://127.0.0.1:* http://localhost:* http://*.localhost:* ws://127.0.0.1:* wss://127.0.0.1:* ws://localhost:* wss://localhost:* ws://*.localhost:* wss://*.localhost:*");
    content = content.replace(/{{PROJECT_JS_URI}}/g, '/static/webview/project.js');
    content = content.replace(/{{HANKEN_FONT_URI}}/g, '/static/designs/HankenGrotesk-Variable.woff2');
    content = content.replace(/{{GEIST_PIXEL_FONT_URI}}/g, '/static/designs/GeistPixel-Square.woff2');
    content = content.replace(/{{SHARED_UTILS_URI}}/g, '/static/webview/sharedUtils.js');
    content = content.replace(/{{MARKDOWN_EDITOR_URI}}/g, '/static/webview/markdownEditor.js');
    const firstScript = `<script nonce="${nonce}" src="/static/webview/sharedUtils.js"></script>`;
    content = injectTransportShim(content, nonce, '<!-- SHARED_DEFAULTS_SCRIPT -->', firstScript);
    const caps = { ...DEFAULT_HOST_CAPABILITIES, ...capabilities };
    const bodyAttr = `data-initial-workspace-root="${encodeURIComponent(workspaceRoot)}" data-panel="project" data-host-capabilities="${htmlEscapeJson(JSON.stringify(caps))}"`;
    content = injectBodyAttributes(content, bodyAttr);
    content = applyThemeClass(content, themeClass);
    return { html: content, csp };
}

export function getPlanningHtml(repoRoot: string, workspaceRoot: string, capabilities?: HostCapabilities, themeClass?: string): PanelHtmlResult {
    const candidates = [
        path.join(repoRoot, 'dist', 'webview', 'planning.html'),
        path.join(repoRoot, 'src', 'webview', 'planning.html'),
    ];
    const htmlPath = findFile(candidates);
    if (!htmlPath) {
        return { html: '<html><body>Planning panel HTML not found.</body></html>', csp: '' };
    }
    let content = fs.readFileSync(htmlPath, 'utf8');
    const nonce = makeNonce();
    // `img-src` includes the loopback origins because local ticket screenshots are
    // rewritten to an absolute `http://127.0.0.1:<port>/design/asset?…` URL (one string
    // has to satisfy both the editor webview and this browser — see
    // PlanningPanelProvider._buildLocalAssetUrl). 'self' alone drops them whenever the
    // cockpit is opened on `localhost` rather than `127.0.0.1`.
    const csp = `default-src 'none'; script-src 'nonce-${nonce}' 'self' 'unsafe-eval'; script-src-attr 'unsafe-inline'; style-src 'unsafe-inline' 'self'; img-src 'self' http://127.0.0.1:* http://localhost:* http://*.localhost:* data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:* ws://localhost:* wss://localhost:* ws://*.localhost:* wss://*.localhost:*; frame-src 'self' http: https: about:srcdoc blob: data:;`;
    content = content.replace(/\{\{NONCE\}\}/g, nonce);
    content = content.replace(/{{WEBVIEW_CSP_SOURCE}}/g, "'self'");
    // Browser cockpit: the shared template's meta CSP hardcodes `connect-src https:`
    // (written for the VS Code webview). In a plain browser that blocks the local
    // server's verb fetches (http://127.0.0.1) AND the WebSocket (ws://127.0.0.1),
    // so every panel comes up empty. Widen it to the loopback API/WS origins.
    content = content.replace('connect-src https:', "connect-src 'self' https: http://127.0.0.1:* http://localhost:* http://*.localhost:* ws://127.0.0.1:* wss://127.0.0.1:* ws://localhost:* wss://localhost:* ws://*.localhost:* wss://*.localhost:*");
    content = content.replace(/{{PLANNING_JS_URI}}/g, '/static/webview/planning.js');
    content = content.replace(/{{SHARED_UTILS_URI}}/g, '/static/webview/sharedUtils.js');
    content = content.replace(/{{MARKDOWN_EDITOR_URI}}/g, '/static/webview/markdownEditor.js');
    content = content.replace(/{{GEIST_PIXEL_FONT_URI}}/g, '/static/designs/GeistPixel-Square.woff2');
    content = content.replace(/{{HANKEN_FONT_URI}}/g, '/static/designs/HankenGrotesk-Variable.woff2');
    const firstScript = `<script nonce="${nonce}" src="/static/webview/sharedUtils.js"></script>`;
    content = injectTransportShim(content, nonce, '<!-- SHARED_DEFAULTS_SCRIPT -->', firstScript);
    const caps = { ...DEFAULT_HOST_CAPABILITIES, ...capabilities };
    const bodyAttr = `data-initial-workspace-root="${encodeURIComponent(workspaceRoot)}" data-panel="planning" data-host-capabilities="${htmlEscapeJson(JSON.stringify(caps))}"`;
    content = injectBodyAttributes(content, bodyAttr);
    content = applyThemeClass(content, themeClass);
    return { html: content, csp };
}

export function getDesignHtml(repoRoot: string, workspaceRoot: string, capabilities?: HostCapabilities, themeClass?: string): PanelHtmlResult {
    const candidates = [
        path.join(repoRoot, 'dist', 'webview', 'design.html'),
        path.join(repoRoot, 'src', 'webview', 'design.html'),
    ];
    const htmlPath = findFile(candidates);
    if (!htmlPath) {
        return { html: '<html><body>Design panel HTML not found.</body></html>', csp: '' };
    }
    let content = fs.readFileSync(htmlPath, 'utf8');
    const nonce = makeNonce();
    // `img-src` includes the loopback origins because local/Stitch assets are emitted as
    // absolute `http://127.0.0.1:<port>/…` URLs so one string works in both hosts (see
    // DesignPanelProvider._absoluteApiUrl). 'self' alone drops them whenever the cockpit
    // is opened on `localhost` rather than `127.0.0.1`.
    const csp = `default-src 'none'; script-src 'nonce-${nonce}' 'self' 'unsafe-eval'; script-src-attr 'unsafe-inline'; style-src 'unsafe-inline' 'self'; img-src 'self' http://127.0.0.1:* http://localhost:* http://*.localhost:* data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:* ws://localhost:* wss://localhost:* ws://*.localhost:* wss://*.localhost:*; frame-src 'self' http: https: about:srcdoc blob: data:;`;
    content = content.replace(/\{\{NONCE\}\}/g, nonce);
    content = content.replace(/{{WEBVIEW_CSP_SOURCE}}/g, "'self'");
    // Browser cockpit: the shared template's meta CSP hardcodes `connect-src https:`
    // (written for the VS Code webview). In a plain browser that blocks the local
    // server's verb fetches (http://127.0.0.1) AND the WebSocket (ws://127.0.0.1),
    // so every panel comes up empty. Widen it to the loopback API/WS origins.
    content = content.replace('connect-src https:', "connect-src 'self' https: http://127.0.0.1:* http://localhost:* http://*.localhost:* ws://127.0.0.1:* wss://127.0.0.1:* ws://localhost:* wss://localhost:* ws://*.localhost:* wss://*.localhost:*");
    content = content.replace(/{{DESIGN_JS_URI}}/g, '/static/webview/design.js');
    content = content.replace(/{{SHARED_UTILS_URI}}/g, '/static/webview/sharedUtils.js');
    content = content.replace(/{{MARKDOWN_EDITOR_URI}}/g, '/static/webview/markdownEditor.js');
    content = content.replace(/{{INSPECT_JS_URI}}/g, '/static/webview/inspect.js');
    content = content.replace(/{{GEIST_PIXEL_FONT_URI}}/g, '/static/designs/GeistPixel-Square.woff2');
    content = content.replace(/{{HANKEN_FONT_URI}}/g, '/static/designs/HankenGrotesk-Variable.woff2');
    const firstScript = `<script nonce="${nonce}" src="/static/webview/sharedUtils.js"></script>`;
    content = injectTransportShim(content, nonce, '<!-- SHARED_DEFAULTS_SCRIPT -->', firstScript);
    const caps = { ...DEFAULT_HOST_CAPABILITIES, ...capabilities };
    const bodyAttr = `data-initial-workspace-root="${encodeURIComponent(workspaceRoot)}" data-panel="design" data-host-capabilities="${htmlEscapeJson(JSON.stringify(caps))}"`;
    content = injectBodyAttributes(content, bodyAttr);
    content = applyThemeClass(content, themeClass);
    return { html: content, csp };
}

export function getSetupHtml(repoRoot: string, workspaceRoot: string, capabilities?: HostCapabilities, themeClass?: string): PanelHtmlResult {
    const candidates = [
        path.join(repoRoot, 'dist', 'webview', 'setup.html'),
        path.join(repoRoot, 'src', 'webview', 'setup.html'),
    ];
    const htmlPath = findFile(candidates);
    if (!htmlPath) {
        return { html: '<html><body>Setup panel HTML not found.</body></html>', csp: '' };
    }
    let content = fs.readFileSync(htmlPath, 'utf8');
    const nonce = makeNonce();
    const csp = `default-src 'self'; script-src 'nonce-${nonce}' 'self' 'unsafe-eval' 'unsafe-inline'; script-src-attr 'unsafe-inline'; style-src 'unsafe-inline' 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:* ws://localhost:* wss://localhost:* ws://*.localhost:* wss://*.localhost:*; frame-src 'self';`;
    content = content.replace(/<script>/g, `<script nonce="${nonce}">`);
    // setup.html carries the marker — pass expectMarker so its deletion warns.
    // (It was deleted once, by 3224366, and shipped a dead Setup panel in 1.7.13.)
    content = injectTransportShim(content, nonce, '<!-- SHARED_DEFAULTS_SCRIPT -->', `<script nonce="${nonce}">`, true);
    content = content.replace(/\{\{HANKEN_FONT_URI\}\}/g, '/static/designs/HankenGrotesk-Variable.woff2');
    content = content.replace(/\{\{GEIST_PIXEL_FONT_URI\}\}/g, '/static/designs/GeistPixel-Square.woff2');
    const caps = { ...DEFAULT_HOST_CAPABILITIES, ...capabilities };
    const bodyAttr = `data-initial-workspace-root="${encodeURIComponent(workspaceRoot)}" data-panel="setup" data-host-capabilities="${htmlEscapeJson(JSON.stringify(caps))}"`;
    content = injectBodyAttributes(content, bodyAttr);
    content = applyThemeClass(content, themeClass);
    return { html: content, csp };
}

export function getMemoHtml(repoRoot: string, workspaceRoot: string, capabilities?: HostCapabilities, themeClass?: string): PanelHtmlResult {
    const candidates = [
        path.join(repoRoot, 'dist', 'webview', 'memo.html'),
        path.join(repoRoot, 'src', 'webview', 'memo.html'),
    ];
    const htmlPath = findFile(candidates);
    if (!htmlPath) {
        return { html: '<html><body>Memo panel HTML not found.</body></html>', csp: '' };
    }
    let content = fs.readFileSync(htmlPath, 'utf8');
    const nonce = makeNonce();
    const csp = `default-src 'none'; script-src 'nonce-${nonce}' 'self'; style-src 'unsafe-inline' 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:* ws://localhost:* wss://localhost:* ws://*.localhost:* wss://*.localhost:*; frame-src 'none';`;
    content = content.replace(/\{\{NONCE\}\}/g, nonce);
    content = content.replace(/\{\{MEMO_JS_URI\}\}/g, '/static/webview/memo.js');
    content = content.replace(/\{\{HANKEN_FONT_URI\}\}/g, '/static/designs/HankenGrotesk-Variable.woff2');
    content = content.replace(/\{\{GEIST_PIXEL_FONT_URI\}\}/g, '/static/designs/GeistPixel-Square.woff2');
    content = injectTransportShim(content, nonce, '<!-- SHARED_DEFAULTS_SCRIPT -->', `<script nonce="${nonce}" src="/static/webview/memo.js"></script>`);
    const caps = { ...DEFAULT_HOST_CAPABILITIES, ...capabilities };
    const bodyAttr = `data-initial-workspace-root="${encodeURIComponent(workspaceRoot)}" data-panel="memo" data-host-capabilities="${htmlEscapeJson(JSON.stringify(caps))}"`;
    content = injectBodyAttributes(content, bodyAttr);
    content = applyThemeClass(content, themeClass);
    return { html: content, csp };
}

export function getTerminalsHtml(repoRoot: string, workspaceRoot: string, capabilities?: HostCapabilities, themeClass?: string): PanelHtmlResult {
    const candidates = [
        path.join(repoRoot, 'dist', 'webview', 'terminals.html'),
        path.join(repoRoot, 'src', 'webview', 'terminals.html'),
    ];
    const htmlPath = findFile(candidates);
    if (!htmlPath) {
        return { html: '<html><body>Terminals panel HTML not found.</body></html>', csp: '' };
    }
    let content = fs.readFileSync(htmlPath, 'utf8');
    const nonce = makeNonce();
    const csp = `default-src 'none'; script-src 'nonce-${nonce}' 'self'; style-src 'unsafe-inline' 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:* ws://localhost:* wss://localhost:* ws://*.localhost:* wss://*.localhost:*; frame-src 'none';`;
    content = content.replace(/\{\{NONCE\}\}/g, nonce);
    content = content.replace(/\{\{TERMINALS_JS_URI\}\}/g, '/static/webview/terminals.js');
    content = content.replace(/\{\{XTERM_JS_URI\}\}/g, '/static/webview/vendor/xterm/xterm.js');
    content = content.replace(/\{\{XTERM_CSS_URI\}\}/g, '/static/webview/vendor/xterm/xterm.css');
    content = content.replace(/\{\{XTERM_ADDON_FIT_URI\}\}/g, '/static/webview/vendor/xterm/addon-fit.js');
    content = content.replace(/\{\{XTERM_ADDON_WEBGL_URI\}\}/g, '/static/webview/vendor/xterm/addon-webgl.js');
    content = content.replace(/\{\{XTERM_ADDON_CANVAS_URI\}\}/g, '/static/webview/vendor/xterm/addon-canvas.js');
    content = content.replace(/\{\{HANKEN_FONT_URI\}\}/g, '/static/designs/HankenGrotesk-Variable.woff2');
    content = content.replace(/\{\{GEIST_PIXEL_FONT_URI\}\}/g, '/static/designs/GeistPixel-Square.woff2');
    content = injectTransportShim(content, nonce, '<!-- SHARED_DEFAULTS_SCRIPT -->', `<script nonce="${nonce}" src="/static/webview/terminals.js"></script>`);
    const caps = { ...DEFAULT_HOST_CAPABILITIES, ...capabilities };
    const bodyAttr = `data-initial-workspace-root="${encodeURIComponent(workspaceRoot)}" data-panel="terminals" data-host-capabilities="${htmlEscapeJson(JSON.stringify(caps))}"`;
    content = injectBodyAttributes(content, bodyAttr);
    content = applyThemeClass(content, themeClass);
    return { html: content, csp };
}

export function getTicketsHtml(repoRoot: string, workspaceRoot: string, capabilities?: HostCapabilities, themeClass?: string): PanelHtmlResult {
    const candidates = [
        path.join(repoRoot, 'dist', 'webview', 'tickets.html'),
        path.join(repoRoot, 'src', 'webview', 'tickets.html'),
    ];
    const htmlPath = findFile(candidates);
    if (!htmlPath) {
        return { html: '<html><body>Tickets panel HTML not found.</body></html>', csp: '' };
    }
    let content = fs.readFileSync(htmlPath, 'utf8');
    const nonce = makeNonce();
    const csp = `default-src 'none'; script-src 'nonce-${nonce}' 'self' 'unsafe-eval'; script-src-attr 'unsafe-inline'; style-src 'unsafe-inline' 'self'; img-src 'self' http://127.0.0.1:* http://localhost:* http://*.localhost:* data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:* ws://localhost:* wss://localhost:* ws://*.localhost:* wss://*.localhost:*; frame-src 'self' http: https: about:srcdoc blob: data:;`;
    content = content.replace(/\{\{NONCE\}\}/g, nonce);
    content = content.replace(/{{WEBVIEW_CSP_SOURCE}}/g, "'self'");
    content = content.replace('connect-src https:', "connect-src 'self' https: http://127.0.0.1:* http://localhost:* http://*.localhost:* ws://127.0.0.1:* wss://127.0.0.1:* ws://localhost:* wss://localhost:* ws://*.localhost:* wss://*.localhost:*");
    content = content.replace(/{{TICKETS_JS_URI}}/g, '/static/webview/tickets.js');
    content = content.replace(/{{SHARED_UTILS_URI}}/g, '/static/webview/sharedUtils.js');
    content = content.replace(/{{MARKDOWN_EDITOR_URI}}/g, '/static/webview/markdownEditor.js');
    content = content.replace(/{{GEIST_PIXEL_FONT_URI}}/g, '/static/designs/GeistPixel-Square.woff2');
    content = content.replace(/{{HANKEN_FONT_URI}}/g, '/static/designs/HankenGrotesk-Variable.woff2');
    const firstScript = `<script nonce="${nonce}" src="/static/webview/sharedUtils.js"></script>`;
    content = injectTransportShim(content, nonce, '<!-- SHARED_DEFAULTS_SCRIPT -->', firstScript);
    const caps = { ...DEFAULT_HOST_CAPABILITIES, ...capabilities };
    const bodyAttr = `data-initial-workspace-root="${encodeURIComponent(workspaceRoot)}" data-panel="tickets" data-host-capabilities="${htmlEscapeJson(JSON.stringify(caps))}"`;
    content = injectBodyAttributes(content, bodyAttr);
    content = applyThemeClass(content, themeClass);
    return { html: content, csp };
}

export interface PanelManifestEntry {
    id: string;
    label: string;
    icon: string;
    route: string;
    enabled: boolean;
}

export interface PanelAvailability {
    design?: boolean;
    setup?: boolean;
    planning?: boolean;
    terminals?: boolean;
    tickets?: boolean;
}

export function getPanelsManifest(availability?: PanelAvailability): PanelManifestEntry[] {
    const setupEnabled = availability?.setup !== false;
    const planningEnabled = availability?.planning !== false;
    const designEnabled = availability?.design !== false;
    const ticketsEnabled = availability?.tickets !== false;
    const terminalsEnabled = availability?.terminals === true; // Fail-closed!
    const iconDir = '/static/icons';
    return [
        { id: 'board', label: 'Board', icon: `${iconDir}/nav-board.svg`, route: '/board', enabled: true },
        { id: 'project', label: 'Project', icon: `${iconDir}/nav-project.svg`, route: '/project', enabled: true },
        { id: 'memo', label: 'Memo', icon: `${iconDir}/nav-memo.svg`, route: '/memo', enabled: true },
        { id: 'tickets', label: 'Tickets', icon: `${iconDir}/nav-tickets.svg`, route: '/tickets', enabled: ticketsEnabled },
        { id: 'planning', label: 'Artifacts', icon: `${iconDir}/nav-artifacts.svg`, route: '/planning', enabled: planningEnabled },
        { id: 'design', label: 'Design', icon: `${iconDir}/nav-design.svg`, route: '/design', enabled: designEnabled },
        { id: 'setup', label: 'Setup', icon: `${iconDir}/nav-setup.svg`, route: '/setup', enabled: setupEnabled },
        { id: 'terminals', label: 'Terminals', icon: `${iconDir}/nav-terminals.svg`, route: '/terminals', enabled: terminalsEnabled },
    ];
}

export function getPanelHtmlById(id: string, repoRoot: string, workspaceRoot: string, capabilities?: HostCapabilities, themeClass?: string): PanelHtmlResult | null {
    switch (id) {
        case 'board': return getBoardHtml(repoRoot, workspaceRoot, capabilities, themeClass);
        case 'project': return getProjectHtml(repoRoot, workspaceRoot, capabilities, themeClass);
        case 'memo': return getMemoHtml(repoRoot, workspaceRoot, capabilities, themeClass);
        case 'tickets': return getTicketsHtml(repoRoot, workspaceRoot, capabilities, themeClass);
        case 'planning': return getPlanningHtml(repoRoot, workspaceRoot, capabilities, themeClass);
        case 'design': return getDesignHtml(repoRoot, workspaceRoot, capabilities, themeClass);
        case 'setup': return getSetupHtml(repoRoot, workspaceRoot, capabilities, themeClass);
        case 'terminals': return getTerminalsHtml(repoRoot, workspaceRoot, capabilities, themeClass);
        default: return null;
    }
}

