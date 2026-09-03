// .agents/skills/_lib/cli-call.js
//
// Shared helper to invoke the Switchboard CLI API subcommand (`switchboard api`).
// Inherits token discovery, health probing, offline handling, and JSON envelope
// parsing from the CLI — one transport for every kanban_operations script.
//
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveWorkspaceRoot } = require("./workspace-root");

// Long enough that a feature split / cascade delete on a large board is never
// cut off mid-flight. Before these scripts moved onto the CLI they passed no
// timeout at all, so an operation could take as long as it needed; the CLI's
// own 15s default would turn a slow-but-successful cascade into a reported
// failure the caller is invited to retry — and a retried cascade is a
// double-applied one.
const DEFAULT_TIMEOUT_MS = 120000;

// Extension hosts that ship the Switchboard VSIX. A workspace that is not the
// Switchboard repo has no `dist/` of its own, and `switchboard` is only on PATH
// for someone who installed the npm package — so for the ordinary
// extension-only install these are the ONLY places the bundled CLI exists.
const EXTENSION_HOMES = [
  ".vscode/extensions",
  ".vscode-server/extensions",
  ".vscode-insiders/extensions",
  ".cursor/extensions",
  ".cursor-server/extensions",
  ".windsurf/extensions",
  ".devin/extensions",
];

function newestBundledCli() {
  const home = os.homedir();
  let best = null;
  for (const rel of EXTENSION_HOMES) {
    const dir = path.join(home, rel);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/switchboard/i.test(entry.name)) { continue; }
      const candidate = path.join(dir, entry.name, "dist", "standalone", "cli.js");
      try {
        const st = fs.statSync(candidate);
        if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) {
          best = { path: candidate, mtimeMs: st.mtimeMs };
        }
      } catch { /* not this one */ }
    }
  }
  return best ? best.path : null;
}

/**
 * Locate the Switchboard CLI, and say WHICH candidate answered.
 *
 * The source is returned alongside the value and reported on failure: "the CLI
 * could not be found" and "the CLI was found but the board is down" are
 * different problems with the same symptom, and a caller that cannot tell them
 * apart reports the wrong one.
 *
 * @returns {{ cmd: string, args: string[], source: string }}
 */
function resolveCli(workspaceRoot) {
  const envPath = process.env.SWITCHBOARD_CLI_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return { cmd: process.execPath, args: [envPath], source: `SWITCHBOARD_CLI_PATH (${envPath})` };
  }
  if (workspaceRoot) {
    const wsDist = path.join(workspaceRoot, "dist", "standalone", "cli.js");
    if (fs.existsSync(wsDist)) {
      return { cmd: process.execPath, args: [wsDist], source: `workspace build (${wsDist})` };
    }
  }
  const bundled = newestBundledCli();
  if (bundled) {
    return { cmd: process.execPath, args: [bundled], source: `installed extension (${bundled})` };
  }
  return { cmd: "switchboard", args: [], source: "PATH ('switchboard')" };
}

/**
 * Perform a Switchboard API call via `switchboard api`.
 * @param {string} method HTTP method ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')
 * @param {string} apiPath URL path (e.g. '/kanban/move')
 * @param {object|string|null} [body] Optional request body
 * @param {string} [workspaceRoot] Optional workspace root
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ reachable: boolean, success: boolean, status?: number, result?: any, error?: string }>}
 */
function cliApiCall(method, apiPath, body, workspaceRoot, options) {
  return new Promise((resolve) => {
    const resolvedRoot = resolveWorkspaceRoot(workspaceRoot) || process.cwd();
    const { cmd, args, source } = resolveCli(resolvedRoot);
    const timeoutMs = (options && options.timeoutMs) || DEFAULT_TIMEOUT_MS;
    const cliArgs = [...args, "api", method.toUpperCase(), apiPath];
    if (body !== undefined && body !== null) {
      cliArgs.push(typeof body === "string" ? body : JSON.stringify(body));
    }
    cliArgs.push("--timeout", String(timeoutMs), "--json");

    execFile(cmd, cliArgs, { cwd: resolvedRoot, encoding: "utf8", timeout: timeoutMs + 5000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      let output = stdout ? stdout.trim() : "";
      if (!output && stderr) {
        output = stderr.trim();
      }
      let parsed = null;
      try {
        parsed = JSON.parse(output);
      } catch {
        // non-json output
      }

      if (parsed && typeof parsed === "object") {
        const isOffline = (parsed.error && (parsed.error.includes("No running Switchboard") || parsed.error.includes("No Switchboard instance")));
        const reachable = !isOffline && (parsed.status !== undefined || !parsed.error);
        const innerResult = parsed.result;
        const innerSuccess = innerResult && typeof innerResult === "object" && innerResult.success !== undefined ? innerResult.success : parsed.success;
        const finalSuccess = !!parsed.success && innerSuccess !== false;
        const finalError = parsed.error || (innerResult && typeof innerResult === "object" && innerResult.error) || (!finalSuccess ? (typeof innerResult === "string" ? innerResult : "Request failed") : undefined);

        resolve({
          reachable,
          success: finalSuccess,
          status: parsed.status,
          result: innerResult !== undefined ? innerResult : parsed,
          error: finalError
        });
        return;
      }

      if (err) {
        // The CLI itself is missing. That is NOT "the request failed" — nothing
        // was asked. Report it as unreachable (the same shape a downed board
        // produces, which is what these scripts already degrade on) and name
        // the resolution that came up empty, so the fix is visible.
        if (err.code === "ENOENT") {
          console.error(
            `[cli-call] Switchboard CLI not found via ${source}. Set SWITCHBOARD_CLI_PATH ` +
            `to the extension's dist/standalone/cli.js, or install the CLI on PATH.`
          );
          resolve({ reachable: false, success: false, error: `Switchboard CLI not found (tried ${source})` });
          return;
        }
        const text = output || err.message;
        const offline = text.includes("No running Switchboard") ||
          text.includes("No Switchboard instance") ||
          text.includes("ECONNREFUSED");
        resolve({
          reachable: !offline,
          success: false,
          error: offline ? text : `${text} [cli: ${source}]`
        });
        return;
      }

      resolve({
        reachable: true,
        success: true,
        result: output
      });
    });
  });
}

module.exports = { cliApiCall, resolveCli, DEFAULT_TIMEOUT_MS };
