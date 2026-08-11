// .agents/skills/_lib/workspace-root.js
//
// Resolve the workspace root a kanban_operations script should address.
//
// A path crossing a process boundary must denote the same directory on both
// sides. `path.resolve('.')` is process.cwd() — absolute, but only correct when
// the caller happens to stand at the workspace root. So: discover the root.
//
const fs = require('fs');
const os = require('os');
const path = require('path');

// Markers identifying a REAL workspace root. A bare `.switchboard` directory is
// NOT sufficient: ~/.switchboard (global config — master key, secrets) and
// ~/Documents/.switchboard (legacy scaffold) both exist on real machines and
// hold neither of these files.
const ROOT_MARKERS = [
  path.join('.switchboard', 'kanban.db'),
  path.join('.switchboard', 'api-server-port.txt')
];

function isWorkspaceRoot(dir) {
  return ROOT_MARKERS.some((marker) => {
    try { return fs.existsSync(path.join(dir, marker)); } catch { return false; }
  });
}

/**
 * @param {string|undefined} explicit  the script's optional workspace-root argv slot
 * @param {string|undefined} startDir  discovery origin (defaults to process.cwd())
 * @returns {string|null} absolute workspace root, or null when none can be identified
 */
function resolveWorkspaceRoot(explicit, startDir) {
  const raw = explicit === undefined || explicit === null ? '' : String(explicit).trim();
  const isHereToken = raw === '' || raw === '.' || raw === './';
  if (!isHereToken) {
    // The caller named a root. Honour it verbatim — do not second-guess it by
    // walking. Keeps the absolute-argument path byte-identical to today.
    return path.resolve(raw);
  }

  const home = path.resolve(os.homedir());
  let cur = path.resolve(startDir || process.cwd());
  while (true) {
    if (cur !== home && isWorkspaceRoot(cur)) { return cur; }
    const next = path.dirname(cur);
    if (next === cur) { return null; }   // hit the filesystem root
    cur = next;
  }
}

module.exports = { resolveWorkspaceRoot, isWorkspaceRoot };
