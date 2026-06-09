/**
 * Webpack loader that patches jsdom's style-rules.js at build time.
 *
 * jsdom reads default-stylesheet.css via fs.readFileSync(path.resolve(__dirname, ...))
 * at module load time. When webpack bundles jsdom, __dirname gets rewritten to the
 * output directory, so the CSS file can't be found at runtime (ENOENT).
 *
 * This loader replaces the fs.readFileSync call with a require() that webpack can
 * resolve and inline via the asset/source rule in webpack.config.js. No static copy
 * of the jsdom source is checked in — the transformation runs on the actual
 * node_modules source each build, so jsdom updates are picked up automatically.
 */
module.exports = function jsdomCssInlineLoader(source) {
    if (source.includes('default-stylesheet.css') && source.includes('fs.readFileSync')) {
        return source.replace(
            /const defaultStyleSheet = fs\.readFileSync\(\s*path\.resolve\(__dirname,\s*"(\.\.\/\.\.\/browser\/default-stylesheet\.css)"\),\s*\{ encoding: "utf-8" \}\s*\);/,
            'const defaultStyleSheet = require("$1");'
        );
    }
    return source;
};
