# Regenerate Claude mirror for switchboard-remote SKILL.md content drift

## Goal

`npm run mirror:check` is red at HEAD on content drift in `.claude/skills/switchboard-remote/SKILL.md`. The checked-in mirror file does not match what `generateClaudeMirror` would produce from the current `.agents/` source. The `mirror:check` script (`scripts/check-claude-mirror.js`) compares the checked-in `.claude/skills/` directory against a fresh generation and reports the drifted file.

The mirror is a generated artifact: `.claude/skills/` is produced from `.agents/skills/` by `generateClaudeMirror`. When a source `.agents/` file is edited without regenerating the mirror, the checked-in mirror goes stale. The `mirror:check` gate in CI (`.github/workflows/integration-tests.yml`, line 68) catches this, but the drift was introduced and not caught before merge.

**Root cause:** A source `.agents/skills/switchboard-remote.md` (or the source file that generates this mirror entry) was edited without running the mirror generation, or the `generateClaudeMirror` logic changed without regenerating the mirror.

## Metadata

**Complexity:** 2
**Tags:** docs, devops
**Project:** Browser Switchboard

## Complexity Audit

**Routine:**
- Run the mirror generation to regenerate `.claude/skills/switchboard-remote/SKILL.md`.
- Commit the regenerated file.
- Verify `npm run mirror:check` passes.

**Complex/Risky:**
- None. This is a content regeneration — the source of truth is `.agents/`, and the mirror is derived. The only risk is regenerating from the wrong source or introducing unrelated changes.

## Edge-Case & Dependency Audit

- **`scripts/check-claude-mirror.js`:** The checker script compares checked-in `.claude/skills/` against a fresh generation. It reports the specific drifted file(s).
- **`generateClaudeMirror`:** The generation function lives in the compiled output (`out/services/ClaudeCodeMirrorService`). Must run `npm run compile` first, or invoke the generation via the extension activation.
- **CI gate:** `mirror:check` is wired into `.github/workflows/integration-tests.yml` (line 68). The fix must make this gate pass.
- **Other drifted files:** The checker reported only `switchboard-remote/SKILL.md`. No other files are drifted.

## Proposed Changes

### 1. Compile the extension (needed for `generateClaudeMirror`)

```bash
npm run compile
```

### 2. Regenerate the mirror

```bash
node -e "const {generateClaudeMirror} = require('./out/services/ClaudeCodeMirrorService'); generateClaudeMirror(process.cwd(), '1.0.0');"
```

Or, if the extension is running, activate it (the mirror is regenerated on activation).

### 3. Verify the drift is resolved

```bash
npm run mirror:check
```

Assert exit code 0.

### 4. Commit the regenerated file

```bash
git add .claude/skills/switchboard-remote/SKILL.md
git commit -m "Regenerate Claude mirror for switchboard-remote SKILL.md"
```

## Verification Plan

1. Run `npm run mirror:check` — assert exit code 0.
2. Run `git diff --stat .claude/skills/switchboard-remote/SKILL.md` — assert only the expected file changed.
3. Verify no other `.claude/skills/` files were modified by the regeneration.
4. Run the full `integration-tests.yml` CI job locally (or verify on CI) — assert the "Claude mirror drift check" step passes.
