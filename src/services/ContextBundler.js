"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.bundleWorkspaceContext = bundleWorkspaceContext;
const cp = __importStar(require("child_process"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const docx_1 = require("docx");
// Each bundle chunk is capped at 500KB of raw text — keeps AI context per-file manageable.
const CHUNK_LIMIT_BYTES = 500 * 1024;
// Max docx writes in flight simultaneously — balances I/O throughput vs. memory pressure.
const MAX_CONCURRENT_WRITES = 5;
const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.eot',
    '.zip', '.tar', '.gz', '.7z', '.exe', '.dll', '.so', '.dylib', '.bin',
    '.pdf', '.mp3', '.mp4', '.wav', '.avi', '.mov', '.vsix',
]);
// Used only for the non-git fallback to prevent infinite traversal of node_modules etc.
const EXCLUDED_DIRS = ['node_modules', '.git', '.switchboard'];
function formatTimestamp(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}
async function saveAsDocx(filePath, content) {
    const lines = content.split('\n');
    const paragraphs = [];
    for (const line of lines) {
        const isHeader = line.startsWith('REPO:') || line.startsWith('Generated:');
        const isSeparator = line.startsWith('--- BEGIN FILE:') || line.startsWith('--- END FILE:');
        if (isHeader) {
            paragraphs.push(new docx_1.Paragraph({
                children: [new docx_1.TextRun({ text: line, bold: true, font: 'Courier New', size: 20 })],
            }));
        }
        else if (isSeparator) {
            paragraphs.push(new docx_1.Paragraph({
                children: [new docx_1.TextRun({ text: line, bold: true, font: 'Courier New', size: 18, color: '666666' })],
            }));
        }
        else {
            paragraphs.push(new docx_1.Paragraph({
                children: [new docx_1.TextRun({ text: line, font: 'Courier New', size: 18 })],
            }));
        }
    }
    const doc = new docx_1.Document({
        sections: [{ children: paragraphs }],
    });
    const buffer = await docx_1.Packer.toBuffer(doc);
    await fs.promises.writeFile(filePath, buffer);
}
function isBinary(filePath) {
    return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
function isExcludedDir(relativePath) {
    const parts = relativePath.split(/[\\/]/);
    return parts.some(p => EXCLUDED_DIRS.includes(p));
}
async function bundleWorkspaceContext(workspaceRoot) {
    const outputDir = path.join(workspaceRoot, '.switchboard', 'airlock');
    // 1. Purge old bundles to prevent disk bloat, but preserve the directory handle for OS Explorer
    if (fs.existsSync(outputDir)) {
        const entries = await fs.promises.readdir(outputDir);
        for (const entry of entries) {
            await fs.promises.rm(path.join(outputDir, entry), { recursive: true, force: true });
        }
    }
    else {
        await fs.promises.mkdir(outputDir, { recursive: true });
    }
    const repoName = path.basename(workspaceRoot);
    // 2. Git-first file listing; hard-exclude .switchboard/airlock to prevent bundling previous output
    let files;
    try {
        const stdout = cp.execSync('git ls-files --cached --others --exclude-standard', {
            cwd: workspaceRoot,
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true,
        });
        files = stdout.split('\n').map(f => f.trim()).filter(Boolean);
        files = files.filter(f => {
            const normalized = f.replace(/\\/g, '/');
            return !normalized.startsWith('.switchboard/airlock/') && normalized !== '.switchboard/airlock';
        });
    }
    catch {
        // Fallback: basic recursive scan with EXCLUDED_DIRS safeguard against node_modules traversal
        files = await walkDirectory(workspaceRoot, workspaceRoot);
    }
    // 3. Separate binary files into exclusion registry; sort remaining by depth (root files first)
    const excludedFiles = [];
    const validFiles = [];
    for (const f of files) {
        if (isBinary(f)) {
            excludedFiles.push({ file: f, reason: 'Binary' });
        }
        else {
            validFiles.push(f);
        }
    }
    files = validFiles.sort((a, b) => {
        const depthA = a.split(/[\\/]/).length;
        const depthB = b.split(/[\\/]/).length;
        if (depthA !== depthB)
            return depthA - depthB;
        return a.localeCompare(b);
    });
    // 4. Rolling size-based chunking pass
    const now = new Date();
    const generatedAt = now.toISOString();
    const timestamp = formatTimestamp(now);
    let chunkIndex = 1;
    let currentBuffer = '';
    let currentBytes = 0;
    const manifestLines = [
        `# Workspace Manifest`,
        ``,
        `Generated: ${generatedAt}`,
        `Repo: ${repoName}`,
        `Files: ${files.length}`,
        ``,
        `## File → Bundle Mapping`,
        ``,
    ];
    // Pending write promises; drained every MAX_CONCURRENT_WRITES to bound memory.
    const writePromises = [];
    const scheduleChunkWrite = async (buffer, index) => {
        const header = `REPO: ${repoName} — part-${index}\nGenerated: ${generatedAt}\n\n`;
        const chunkPath = path.join(outputDir, `${timestamp}-bundle-part-${index}.docx`);
        const p = saveAsDocx(chunkPath, header + buffer);
        p.catch(() => { }); // Prevent unhandled rejection crash; Promise.all will still catch and bubble it.
        writePromises.push(p);
        if (writePromises.length >= MAX_CONCURRENT_WRITES) {
            await Promise.all(writePromises);
            writePromises.length = 0;
        }
    };
    for (const file of files) {
        let sizeKB;
        try {
            const stat = await fs.promises.stat(path.join(workspaceRoot, file));
            sizeKB = (stat.size / 1024).toFixed(1);
            if (stat.size > CHUNK_LIMIT_BYTES) {
                excludedFiles.push({ file, sizeKB, reason: 'Exceeds 500KB limit' });
                continue;
            }
            const content = await fs.promises.readFile(path.join(workspaceRoot, file), 'utf8');
            // Extract description safely (slice to protect event loop from ReDoS)
            let desc = '';
            const headerSlice = content.slice(0, 1000);
            const commentMatch = headerSlice.match(/^\s*(?:\/\*([\s\S]*?)\*\/|\/\/([^\n]+))/);
            if (commentMatch) {
                desc = (commentMatch[1] || commentMatch[2] || '').replace(/[\r\n]+/g, ' ').replace(/\*/g, '').trim();
                if (desc.length > 150)
                    desc = desc.substring(0, 147) + '...';
                if (desc)
                    desc = ` — *${desc}*`;
            }
            const section = `--- BEGIN FILE: ${file} ---\n${content}\n--- END FILE: ${file} ---\n\n`;
            const sectionBytes = Buffer.byteLength(section, 'utf8');
            if (currentBytes > 0 && currentBytes + sectionBytes > CHUNK_LIMIT_BYTES) {
                await scheduleChunkWrite(currentBuffer, chunkIndex++);
                currentBuffer = '';
                currentBytes = 0;
            }
            const targetIndex = chunkIndex;
            currentBuffer += section;
            currentBytes += sectionBytes;
            manifestLines.push(`- **${file}** (${sizeKB}KB) -> \`${timestamp}-bundle-part-${targetIndex}.docx\`${desc}`);
        }
        catch (e) {
            excludedFiles.push({ file, sizeKB, reason: `Unreadable (${e.code || e.message})` });
        }
    }
    // Final flush of any remaining buffered content.
    if (currentBytes > 0) {
        await scheduleChunkWrite(currentBuffer, chunkIndex);
    }
    // Drain any remaining in-flight writes.
    if (writePromises.length > 0) {
        await Promise.all(writePromises);
        writePromises.length = 0;
    }
    if (excludedFiles.length > 0) {
        manifestLines.push(``);
        manifestLines.push(`## Excluded Files`);
        manifestLines.push(``);
        for (const ef of excludedFiles) {
            const sizeStr = ef.sizeKB ? ` (${ef.sizeKB}KB)` : '';
            manifestLines.push(`- **${ef.file}**${sizeStr} *(Excluded: ${ef.reason})*`);
        }
    }
    // 5. Write manifest as clean markdown (not docx — human-readable in VS Code).
    const manifestPath = path.join(outputDir, `${timestamp}-manifest.md`);
    await fs.promises.writeFile(manifestPath, manifestLines.join('\n') + '\n', 'utf8');
    return { outputDir, timestamp };
}
async function walkDirectory(dir, root) {
    const results = [];
    let entries;
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    }
    catch {
        return results;
    }
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const rel = path.relative(root, fullPath);
        if (isExcludedDir(rel)) {
            continue;
        }
        if (entry.isDirectory()) {
            results.push(...await walkDirectory(fullPath, root));
        }
        else if (entry.isFile()) {
            results.push(rel);
        }
    }
    return results;
}
//# sourceMappingURL=ContextBundler.js.map