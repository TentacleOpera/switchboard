import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// 20MB — heuristic upper bound for web LLM context windows (GPT-4, Claude, Gemini)
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;
const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.eot',
    '.zip', '.tar', '.gz', '.7z', '.exe', '.dll', '.so', '.dylib', '.bin',
    '.pdf', '.mp3', '.mp4', '.wav', '.avi', '.mov', '.vsix',
]);
const EXCLUDED_DIRS = ['node_modules', 'dist', 'out', '.git', '.switchboard'];

function isBinary(filePath: string): boolean {
    return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isExcludedDir(relativePath: string): boolean {
    const parts = relativePath.split(/[\\/]/);
    return parts.some(p => EXCLUDED_DIRS.includes(p));
}

function getLanguageId(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const map: Record<string, string> = {
        '.ts': 'typescript', '.js': 'javascript', '.tsx': 'tsx', '.jsx': 'jsx',
        '.json': 'json', '.md': 'markdown', '.html': 'html', '.css': 'css',
        '.py': 'python', '.sh': 'bash', '.yml': 'yaml', '.yaml': 'yaml'
    };
    return map[ext] || '';
}

function formatTimestamp(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export async function bundleWorkspaceContext(workspaceRoot: string): Promise<string> {
    const outputDir = path.join(workspaceRoot, '.switchboard', 'airlock');
    await fs.promises.mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `codebase-bundle-${formatTimestamp()}.md`);

    // Use git ls-files for .gitignore-compliant listing
    let files: string[];
    try {
        const stdout = cp.execSync('git ls-files --cached --others --exclude-standard', {
            cwd: workspaceRoot,
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true,
        });
        files = stdout.split('\n').map(f => f.trim()).filter(Boolean);
    } catch {
        // Fallback: basic recursive scan if not a git repo
        files = await walkDirectory(workspaceRoot, workspaceRoot);
    }

    // Filter and sort by directory depth (root files first)
    files = files.filter(f => !isBinary(f) && !isExcludedDir(f))
        .sort((a, b) => {
            const depthA = a.split(/[\\/]/).length;
            const depthB = b.split(/[\\/]/).length;
            if (depthA !== depthB) return depthA - depthB;
            return a.localeCompare(b);
        });

    // Structure map goes first so LLMs can orient before reading file contents
    let bundle = `# Workspace Context Bundle\n\nGenerated: ${new Date().toISOString()}\nFiles: ${files.length}\n\n## Directory Structure\n\`\`\`text\n${files.join('\n')}\n\`\`\`\n\n---\n\n`;
    let totalBytes = Buffer.byteLength(bundle, 'utf8');

    for (const file of files) {
        const absPath = path.join(workspaceRoot, file);
        try {
            const stat = await fs.promises.stat(absPath);
            if (!stat.isFile() || stat.size > 512 * 1024) { continue; } // skip files > 512KB individually
            const content = await fs.promises.readFile(absPath, 'utf8');
            const lang = getLanguageId(file);
            const section = `## File: ${file}\n\n\`\`\`${lang}\n${content}\n\`\`\`\n\n`;
            const sectionBytes = Buffer.byteLength(section, 'utf8');
            if (totalBytes + sectionBytes > MAX_BUNDLE_BYTES) {
                bundle += `\n\n> ⚠️ Bundle truncated at ${(totalBytes / 1024 / 1024).toFixed(1)}MB limit. ${files.length - files.indexOf(file)} files omitted.\n`;
                break;
            }
            bundle += section;
            totalBytes += sectionBytes;
        } catch {
            // Skip unreadable files
        }
    }

    await fs.promises.writeFile(outputPath, bundle, 'utf8');
    return outputPath;
}

async function walkDirectory(dir: string, root: string): Promise<string[]> {
    const results: string[] = [];
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const rel = path.relative(root, fullPath);
        if (isExcludedDir(rel)) { continue; }
        if (entry.isDirectory()) {
            results.push(...await walkDirectory(fullPath, root));
        } else if (entry.isFile()) {
            results.push(rel);
        }
    }
    return results;
}
