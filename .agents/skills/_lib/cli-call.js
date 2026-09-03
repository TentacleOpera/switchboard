// .agents/skills/_lib/cli-call.js
//
// Shared helper to invoke the Switchboard CLI API subcommand (`switchboard api`).
// Inherits token discovery, offline handling, and JSON envelope parsing from the CLI.
//
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { resolveWorkspaceRoot } = require("./workspace-root");

function resolveCli(workspaceRoot) {
  if (process.env.SWITCHBOARD_CLI_PATH && fs.existsSync(process.env.SWITCHBOARD_CLI_PATH)) {
    return { cmd: process.execPath, args: [process.env.SWITCHBOARD_CLI_PATH] };
  }
  if (workspaceRoot) {
    const wsDist = path.join(workspaceRoot, "dist", "standalone", "cli.js");
    if (fs.existsSync(wsDist)) {
      return { cmd: process.execPath, args: [wsDist] };
    }
  }
  const relDist = path.resolve(__dirname, "../../../dist/standalone/cli.js");
  if (fs.existsSync(relDist)) {
    return { cmd: process.execPath, args: [relDist] };
  }
  return { cmd: "switchboard", args: [] };
}

/**
 * Perform a Switchboard API call via `switchboard api`.
 * @param {string} method HTTP method ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')
 * @param {string} apiPath URL path (e.g. '/kanban/move')
 * @param {object|string|null} [body] Optional request body
 * @param {string} [workspaceRoot] Optional workspace root
 * @returns {Promise<{ reachable: boolean, success: boolean, status?: number, result?: any, error?: string }>}
 */
function cliApiCall(method, apiPath, body, workspaceRoot) {
  return new Promise((resolve) => {
    const resolvedRoot = resolveWorkspaceRoot(workspaceRoot) || process.cwd();
    const { cmd, args } = resolveCli(resolvedRoot);
    const cliArgs = [...args, "api", method.toUpperCase(), apiPath];
    if (body !== undefined && body !== null) {
      cliArgs.push(typeof body === "string" ? body : JSON.stringify(body));
    }
    cliArgs.push("--json");

    execFile(cmd, cliArgs, { cwd: resolvedRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
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
        const isOffline = (output || err.message).includes("No running Switchboard") ||
          (output || err.message).includes("No Switchboard instance") ||
          (output || err.message).includes("ECONNREFUSED");
        resolve({
          reachable: !isOffline,
          success: false,
          error: output || err.message
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

module.exports = { cliApiCall, resolveCli };
