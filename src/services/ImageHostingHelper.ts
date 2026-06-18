import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function resolveLocalImagePath(rawSrc: string, ticketFilePath?: string): string | null {
    let p = rawSrc;
    if (/^file:/i.test(p)) {
        try {
            p = decodeURIComponent(new URL(p).pathname);
        } catch {
            return null;
        }
    }
    if (p.startsWith('~/')) {
        p = path.join(os.homedir(), p.slice(2));
    }
    if (path.isAbsolute(p)) {
        return path.normalize(p);
    }
    if (!ticketFilePath) {
        return null;
    }
    // Relative paths resolve against the ticket .md file's directory.
    return path.normalize(path.join(path.dirname(ticketFilePath), p));
}

export async function uploadInlineImagesAndRewrite(
    markdown: string,
    ticketFilePath: string | undefined,
    upload: (fileName: string, buffer: Buffer) => Promise<{ url: string }>
): Promise<{ rewritten: string; replacements: Array<{ from: string; to: string }>; warnings: string[] }> {
    const IMG_RE = /!\[[^\]]*\]\(([^)]+)\)/g;
    const warnings: string[] = [];
    const replacements: Array<{ from: string; to: string }> = [];
    const uploadedByRaw = new Map<string, string>(); // raw src -> hosted url

    const matches = [...markdown.matchAll(IMG_RE)];
    for (const m of matches) {
        const rawSrc = m[1].trim();
        // Skip already-hosted images and non-file schemes.
        if (/^(https?:)?\/\//i.test(rawSrc) || /^data:/i.test(rawSrc)) {
            continue;
        }
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawSrc) && !/^file:/i.test(rawSrc)) {
            continue;
        }

        if (uploadedByRaw.has(rawSrc)) {
            continue;
        }

        const localPath = resolveLocalImagePath(rawSrc, ticketFilePath);
        if (!localPath || !fs.existsSync(localPath)) {
            warnings.push(`Inline image not found, left as-is: ${rawSrc}`);
            continue;
        }
        try {
            const buffer = await fs.promises.readFile(localPath);
            const fileName = path.basename(localPath);
            const { url } = await upload(fileName, buffer);
            if (url) {
                uploadedByRaw.set(rawSrc, url);
                replacements.push({ from: rawSrc, to: url });
            } else {
                warnings.push(`Upload returned no URL for: ${rawSrc}`);
            }
        } catch (err) {
            warnings.push(`Failed to upload ${rawSrc}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // Rewrite: replace each occurrence of the raw src inside its image reference.
    let rewritten = markdown;
    for (const [rawSrc, url] of uploadedByRaw) {
        rewritten = rewritten.replace(
            new RegExp(`(!\\[[^\\]]*\\]\\()${escapeRegExp(rawSrc)}(\\))`, 'g'),
            `$1${url}$2`
        );
    }
    return { rewritten, replacements, warnings };
}

export async function hostInlineImages(
    upload: (fileName: string, buffer: Buffer) => Promise<{ url: string }>,
    description: string,
    sourceFilePath?: string
): Promise<{ rewritten: string; warnings: string[] }> {
    const { rewritten, replacements, warnings } = await uploadInlineImagesAndRewrite(
        description,
        sourceFilePath,
        upload
    );

    if (sourceFilePath && fs.existsSync(sourceFilePath) && replacements.length > 0) {
        try {
            const content = fs.readFileSync(sourceFilePath, 'utf8');
            let updatedContent = content;
            for (const { from, to } of replacements) {
                updatedContent = updatedContent.replace(
                    new RegExp(`(!\\[[^\\]]*\\]\\()${escapeRegExp(from)}(\\))`, 'g'),
                    `$1${to}$2`
                );
            }
            if (updatedContent !== content) {
                fs.writeFileSync(sourceFilePath, updatedContent, 'utf8');
            }
        } catch (wbErr) {
            warnings.push(`Pushed, but failed to update local file with hosted image URLs: ${wbErr instanceof Error ? wbErr.message : String(wbErr)}`);
        }
    }

    return { rewritten, warnings };
}
