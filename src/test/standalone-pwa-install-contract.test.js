'use strict';

/**
 * Contract tests for standalone PWA home screen installation.
 *
 * Verifies:
 * 1. apple-mobile-web-app-capable and apple-touch-icon in shell.html
 * 2. viewport-fit=cover in shell.html viewport meta
 * 3. manifest-src 'self' present across all shell-class CSP policies
 * 4. manifest.json and manifest.webmanifest validity and fields
 * 5. Square icon assets with correct dimensions and unrounded corners
 * 6. LocalApiServer MIME mapping and manifest routing
 * 7. Absence of serviceWorker and beforeinstallprompt
 * 8. Host wiring parity: serveStatic wired in standalone, absent in extension
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const repoRoot = path.join(__dirname, "..", "..");
const shellHtmlPath = path.join(repoRoot, "src", "webview", "shell.html");
const headlessHtmlPath = path.join(repoRoot, "src", "services", "headlessPanelHtml.ts");
const localApiServerPath = path.join(repoRoot, "src", "services", "LocalApiServer.ts");
const bootstrapPath = path.join(repoRoot, "src", "standalone", "bootstrap.ts");
const taskViewerPath = path.join(repoRoot, "src", "services", "TaskViewerProvider.ts");
const manifestJsonPath = path.join(repoRoot, "src", "webview", "manifest.json");
const manifestWebmanifestPath = path.join(repoRoot, "src", "webview", "manifest.webmanifest");

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}`);
        console.error(e && e.stack ? e.stack : e);
        failed++;
    }
}

const shellHtml = fs.readFileSync(shellHtmlPath, "utf8");
const headlessHtml = fs.readFileSync(headlessHtmlPath, "utf8");
const localApiServer = fs.readFileSync(localApiServerPath, "utf8");
const bootstrap = fs.readFileSync(bootstrapPath, "utf8");
const taskViewer = fs.readFileSync(taskViewerPath, "utf8");

test("shell.html carries <meta name=\"apple-mobile-web-app-capable\" content=\"yes\">", () => {
    assert.ok(
        /<meta\s+name=["']apple-mobile-web-app-capable["']\s+content=["']yes["']\s*\/?>/i.test(shellHtml),
        "shell.html must contain apple-mobile-web-app-capable with content=\"yes\""
    );
});

test("shell.html carries apple-touch-icon link pointing to 180x180 icon", () => {
    assert.ok(
        /<link\s+rel=["']apple-touch-icon["'][^>]*href=["'][^"']*icon-180\.png["']/i.test(shellHtml) ||
        /<link\s+[^>]*href=["'][^"']*icon-180\.png["'][^>]*rel=["']apple-touch-icon["']/i.test(shellHtml),
        "shell.html must link apple-touch-icon to icon-180.png"
    );
});

test("shell.html carries viewport-fit=cover in viewport meta", () => {
    assert.ok(
        /<meta\s+name=["']viewport["'][^>]*viewport-fit=cover/i.test(shellHtml),
        "shell.html viewport meta must specify viewport-fit=cover"
    );
});

test("shell.html carries apple-mobile-web-app-status-bar-style and theme-color", () => {
    assert.ok(
        /<meta\s+name=["']apple-mobile-web-app-status-bar-style["']/i.test(shellHtml),
        "shell.html must declare apple-mobile-web-app-status-bar-style"
    );
    assert.ok(
        /<meta\s+name=["']theme-color["']\s+content=["']#0a0a0f["']/i.test(shellHtml),
        "shell.html must declare theme-color #0a0a0f"
    );
});

test("shell.html carries <link rel=\"manifest\" href=\"/manifest.json\">", () => {
    assert.ok(
        /<link\s+rel=["']manifest["']\s+href=["']\/manifest\.json["']/i.test(shellHtml) ||
        /<link\s+href=["']\/manifest\.json["']\s+rel=["']manifest["']/i.test(shellHtml),
        "shell.html must link to /manifest.json"
    );
});

function findShellClassPolicies() {
    const policies = [];
    const webviewDir = path.join(repoRoot, "src", "webview");
    const htmlFiles = fs.readdirSync(webviewDir).filter(f => f.endsWith(".html"));
    const installableHtmls = new Set();

    // 1. Scan src/webview/*.html for installable shell documents (carrying rel="manifest" or apple-mobile-web-app-capable)
    for (const file of htmlFiles) {
        const content = fs.readFileSync(path.join(webviewDir, file), "utf8");
        if (content.includes("apple-mobile-web-app-capable") || content.includes('rel="manifest"') || content.includes("rel='manifest'")) {
            installableHtmls.add(file);
            const m = content.match(/<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=(?:"([^"]+)"|'([^']+)')/i);
            if (m) {
                policies.push({
                    source: `src/webview/${file} (meta tag)`,
                    csp: m[1] || m[2],
                });
            }
        }
    }

    // 2. Scan src/services/headlessPanelHtml.ts for generator functions serving installable HTML templates
    const headlessSrc = fs.readFileSync(headlessHtmlPath, "utf8");
    const fnRegex = /export\s+function\s+(get\w+Html)\s*\([^)]*\)[^{]*\{([\s\S]*?\n\})/g;
    let match;
    while ((match = fnRegex.exec(headlessSrc)) !== null) {
        const fnName = match[1];
        const fnBody = match[2];
        const referencesInstallable = [...installableHtmls].some(htmlFile => fnBody.includes(`'${htmlFile}'`) || fnBody.includes(`"${htmlFile}"`));
        if (referencesInstallable || fnName === "getShellHtml" || fnName === "getCommandHtml") {
            const cspMatch = fnBody.match(/const\s+csp\s*=\s*`([^`]+)`/);
            if (cspMatch) {
                policies.push({
                    source: `src/services/headlessPanelHtml.ts:${fnName}`,
                    csp: cspMatch[1],
                });
            }
        }
    }

    return { installableHtmls: [...installableHtmls], policies };
}

test("manifest-src 'self' is present across the full set of shell-class policies", () => {
    const { installableHtmls, policies } = findShellClassPolicies();
    assert.ok(installableHtmls.length >= 1, `expected at least 1 installable shell HTML file, found ${installableHtmls.length}`);
    assert.ok(policies.length >= 2, `expected at least 2 shell-class CSP policy sites, found ${policies.length}`);

    for (const item of policies) {
        assert.ok(
            item.csp.includes("manifest-src 'self'"),
            `Shell-class policy in ${item.source} must contain manifest-src 'self'. Got: ${item.csp}`
        );
    }
});

test("manifest.json and manifest.webmanifest parse and contain required PWA fields", () => {
    for (const p of [manifestJsonPath, manifestWebmanifestPath]) {
        assert.ok(fs.existsSync(p), `file must exist: ${p}`);
        const data = JSON.parse(fs.readFileSync(p, "utf8"));
        assert.strictEqual(data.display, "standalone", "display must be standalone");
        assert.strictEqual(data.start_url, "/", "start_url must be /");
        assert.strictEqual(data.scope, "/", "scope must be /");
        assert.strictEqual(data.name, "Switchboard", "name must be Switchboard");
        assert.strictEqual(data.short_name, "Switchboard", "short_name must be Switchboard");
        assert.strictEqual(data.theme_color, "#0a0a0f", "theme_color must be #0a0a0f");
        assert.strictEqual(data.background_color, "#0a0a0f", "background_color must be #0a0a0f");
        assert.ok(Array.isArray(data.icons) && data.icons.length >= 2, "must provide icons array with multiple sizes");
    }
});

test("icon assets exist at 180, 192, 512, and 512-maskable sizes and are square", () => {
    // Read PNG headers to verify width and height without third-party dependencies
    function getPngDimensions(buf) {
        // PNG header: 8 bytes signature, then 4 bytes length, 4 bytes chunk type "IHDR", 4 bytes width, 4 bytes height
        assert.strictEqual(buf.toString("ascii", 12, 16), "IHDR", "Invalid PNG chunk");
        const width = buf.readUInt32BE(16);
        const height = buf.readUInt32BE(20);
        return { width, height };
    }

    const iconFiles = [
        { file: "icons/icon-180.png", expected: 180 },
        { file: "icons/icon-192.png", expected: 192 },
        { file: "icons/icon-512.png", expected: 512 },
        { file: "icons/icon-512-maskable.png", expected: 512 },
    ];

    for (const item of iconFiles) {
        const fullPath = path.join(repoRoot, item.file);
        assert.ok(fs.existsSync(fullPath), `Icon file must exist: ${item.file}`);
        const buf = fs.readFileSync(fullPath);
        const { width, height } = getPngDimensions(buf);
        assert.strictEqual(width, height, `${item.file} must be square (${width}x${height})`);
        assert.strictEqual(width, item.expected, `${item.file} must be ${item.expected}x${item.expected}, got ${width}x${height}`);
    }
});

test("LocalApiServer maps .webmanifest to application/manifest+json and routes /manifest.json", () => {
    assert.ok(
        localApiServer.includes("'.webmanifest': 'application/manifest+json'") ||
        localApiServer.includes("'.webmanifest':'application/manifest+json'"),
        "LocalApiServer._serveStaticMimeType must map .webmanifest to application/manifest+json"
    );
    assert.ok(
        localApiServer.includes("_handleServeManifest"),
        "LocalApiServer must implement _handleServeManifest"
    );
    assert.ok(
        /pathname\s*===\s*['"]\/manifest\.json['"]/.test(localApiServer),
        "LocalApiServer must route GET /manifest.json"
    );
});

test("negative paired: no serviceWorker.register or beforeinstallprompt in non-test src/", () => {
    function scanDir(dir) {
        let files = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== "node_modules" && entry.name !== ".git" && entry.name !== "test") {
                    files = files.concat(scanDir(p));
                }
            } else if (entry.isFile() && (p.endsWith(".ts") || p.endsWith(".js") || p.endsWith(".html"))) {
                files.push(p);
            }
        }
        return files;
    }

    const srcFiles = scanDir(path.join(repoRoot, "src"));
    for (const f of srcFiles) {
        const content = fs.readFileSync(f, "utf8");
        assert.ok(!content.includes("serviceWorker" + ".register"), `serviceWorker.register found in ${f}`);
        assert.ok(!content.includes("beforeinstallprompt"), `beforeinstallprompt found in ${f}`);
    }
});

test("negative paired: standalone host wires serveStatic, extension host does not", () => {
    assert.ok(
        bootstrap.includes("getShellHtml") && bootstrap.includes("staticRoutes"),
        "bootstrap.ts must wire serveStatic options"
    );
    assert.ok(
        !taskViewer.includes("serveStatic: {") && !taskViewer.includes("serveStatic:{"),
        "TaskViewerProvider.ts in extension host must NOT wire serveStatic"
    );
});

const total = passed + failed;
console.log(`\n${total} tests, ${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
