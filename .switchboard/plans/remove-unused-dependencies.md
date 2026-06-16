# Remove Unused Dependencies (mermaid, @modelcontextprotocol/sdk)

## Goal
Remove unused npm dependencies that are contributing to bundle size without being used in the codebase:
- `mermaid` ^11.14.0 - Loaded via CDN in webview, not imported in source code
- `@modelcontextprotocol/sdk` ^1.0.3 - Dead code from removed MCP server

## Background & Root Cause Analysis
The extension has accumulated unused dependencies over time:
1. **mermaid** was added for diagram generation but the actual implementation loads mermaid.js from CDN (`https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js`) in `DiagramRenderer.ts`. The npm package is never imported in TypeScript source code.
2. **@modelcontextprotocol/sdk** was used by the now-removed MCP server. Migration code in `extension.ts` (lines 499-547) explicitly removes MCP server artifacts, confirming the server is no longer present. No source code imports this package.

These unused dependencies:
- Increase node_modules size (slower npm install)
- May accidentally be bundled by webpack
- Contribute to overall extension maintenance burden
- Create confusion about actual dependencies

## Scope
- Remove `mermaid` from `package.json` dependencies
- Remove `@modelcontextprotocol/sdk` from `package.json` dependencies
- Keep `@mermaid-js/mermaid-cli` in devDependencies (actively used for CLI rendering)
- Verify no source code imports these packages
- Test extension functionality after removal

## Proposed Changes

### 1. Remove mermaid from dependencies
**File:** `package.json`
**Change:** Remove `"mermaid": "^11.14.0"` from the `dependencies` object (line 726)

**Rationale:** 
- No TypeScript code imports mermaid
- Webview loads mermaid from CDN: `DiagramRenderer.ts` line 101
- MermaidGenerator.ts only generates syntax strings, doesn't use the library
- CDN loading continues to work after removal

### 2. Remove @modelcontextprotocol/sdk from dependencies
**File:** `package.json`
**Change:** Remove `"@modelcontextprotocol/sdk": "^1.0.3"` from the `dependencies` object (line 716)

**Rationale:**
- MCP server was removed (migration code in extension.ts lines 499-547)
- No source code imports this package
- Confirmed by grep search showing zero imports

### 3. Verify no imports exist
**Verification:** Run grep searches to confirm no source code imports these packages:
```bash
grep -r "from.*mermaid" src/
grep -r "from.*@modelcontextprotocol" src/
```

### 4. Test extension functionality
**Verification:**
1. Run `npm install` to confirm package.json is valid
2. Run `npm run compile` to confirm webpack builds successfully
3. Test diagram generation skill (mermaid CDN loading)
4. Test extension activation and basic features

## Edge Cases & Dependency Audit

### Security
- No security impact - removing unused code reduces attack surface
- CDN loading for mermaid continues unchanged

### Side Effects
- `npm install` will be faster (fewer packages to download)
- node_modules size will decrease
- No runtime behavior changes

### Dependencies & Conflicts
- `@mermaid-js/mermaid-cli` devDependency must remain - used by LocalApiServer for CLI rendering
- No other packages depend on these removed packages

## Verification Plan

### Pre-removal checks
1. Confirm no source imports: `grep -r "import.*mermaid" src/` should return zero results
2. Confirm no source imports: `grep -r "import.*@modelcontextprotocol" src/` should return zero results
3. Confirm package.json version (read current version)

### Post-removal checks
1. Run `npm install` - should complete successfully
2. Run `npm run compile` - webpack should build without errors
3. Run `npm run package` - production build should succeed
4. Load extension in VS Code - should activate without errors
5. Test diagram generation skill - should work (CDN loading)
6. Test LocalApiServer mermaid-cli check - should work (CLI binary check unaffected)

## Implementation Steps

1. Read current `package.json` version
2. Remove `mermaid` from dependencies
3. Remove `@modelcontextprotocol/sdk` from dependencies
4. Run `npm install` to verify package.json validity
5. Run `npm run compile` to verify webpack build
6. Test extension activation
7. Test diagram generation feature
