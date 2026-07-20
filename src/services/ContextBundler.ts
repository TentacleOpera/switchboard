import * as fs from 'fs';
import * as path from 'path';
import JSZip = require('jszip');

// DOCS-ONLY BY DESIGN. Do not add a code-inclusion option — see plan
// create-plans-tab-docs-only-agent-intake.md. The whole-repo NotebookLM
// bundler (bundleWorkspaceContext) was removed; this module now hosts the
// docs-scoped bundler used by the Create Plans tab.

// The allowlist is the invariant: only prose formats ever enter the bundle.
// A doc folder containing source files, .env files, or binaries is filtered
// here regardless of what the caller passes in.
const DOC_EXTENSIONS = new Set(['.md', '.txt']);

/** One file the caller wants bundled, with the folder it lands in inside the zip. */
export interface DocsBundleSource {
    /** Zip-internal directory, e.g. 'prds/my-project' or 'docs/guides'. */
    zipDir: string;
    /** Absolute path on disk. */
    absPath: string;
}

/**
 * Bundle the managed doc set into a markdown zip for the Create Plans tab.
 * The caller (PlanningPanelProvider) enumerates the source set — constitution,
 * PRDs, README, curated Docs-tab folders; this function enforces the docs-only
 * allowlist, writes HOW-TO-PLAN.md + MANIFEST.md, and emits the zip under
 * `.switchboard/create-plans/`. Never lists or reads source code.
 */
export async function bundleDocsContext(
    workspaceRoot: string,
    options: { sources: DocsBundleSource[]; howToPlanMarkdown: string }
): Promise<{ zipPath: string; fileCount: number; skipped: string[] }> {
    const outDir = path.join(workspaceRoot, '.switchboard', 'create-plans');
    await fs.promises.mkdir(outDir, { recursive: true });

    // Purge previous bundles — disposable output, same posture as the old exporter.
    for (const entry of await fs.promises.readdir(outDir)) {
        if (entry.endsWith('.zip')) {
            try { await fs.promises.rm(path.join(outDir, entry), { force: true }); } catch { /* best effort */ }
        }
    }

    const zip = new JSZip();
    zip.file('HOW-TO-PLAN.md', options.howToPlanMarkdown);

    const included: string[] = [];
    const skipped: string[] = [];
    const usedNames = new Set<string>(['HOW-TO-PLAN.md', 'MANIFEST.md']);

    for (const source of options.sources) {
        const ext = path.extname(source.absPath).toLowerCase();
        if (!DOC_EXTENSIONS.has(ext)) {
            skipped.push(`${source.absPath} (not a doc: ${ext || 'no extension'})`);
            continue;
        }
        let content: string;
        try {
            content = await fs.promises.readFile(source.absPath, 'utf8');
        } catch {
            skipped.push(`${source.absPath} (unreadable)`);
            continue;
        }
        let zipName = path.posix.join(source.zipDir.replace(/\\/g, '/'), path.basename(source.absPath));
        // De-dupe zip entries (two folders can hold same-named docs).
        let candidate = zipName;
        let n = 2;
        while (usedNames.has(candidate)) {
            const parsed = path.posix.parse(zipName);
            candidate = path.posix.join(parsed.dir, `${parsed.name}-${n}${parsed.ext}`);
            n++;
        }
        zipName = candidate;
        usedNames.add(zipName);
        zip.file(zipName, content);
        included.push(zipName);
    }

    const manifest = [
        '# Bundle manifest',
        '',
        `Generated from workspace: ${path.basename(workspaceRoot)}`,
        '',
        '## Included',
        ...included.map(f => `- ${f}`),
        '',
        skipped.length ? '## Skipped (docs-only allowlist)' : '',
        ...skipped.map(f => `- ${f}`),
        '',
        'Start with HOW-TO-PLAN.md.',
    ].filter(Boolean).join('\n');
    zip.file('MANIFEST.md', manifest);

    const pad = (n: number) => String(n).padStart(2, '0');
    const now = new Date();
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    const zipPath = path.join(outDir, `docs-context-${stamp}.zip`);
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    await fs.promises.writeFile(zipPath, buffer);

    return { zipPath, fileCount: included.length, skipped };
}
