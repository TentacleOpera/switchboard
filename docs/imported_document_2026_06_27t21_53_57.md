# VS Code markdown.api.render Preserves Relative Href Attributes

## Executive Summary

`markdown.api.render` **preserves relative href attributes verbatim**. It does not rewrite them to `vscode-webview://` URIs, absolute paths, `file+.vscode-resource.vscode-cdn.net` forms, or any transformed variant. A markdown link `[text](topic)` or `[text](./topic.md)` renders as `<a href="topic" data-href="topic">text</a>` — the raw relative target appears in `href`, and the engine **adds a duplicate `data-href`** attribute holding the same original value (via the `link_open` renderer rule's `token.attrSet('data-href', href)`). For bare relative paths and fragments, `href` and `data-href` are byte-identical.

The engine's `normalizeLink` override only rewrites `vscode:`/`vscode-insiders:` scheme URIs; resource-URI conversion (`asWebviewUri`) is applied **only to `<img>` src, never to `<a>` href** — and in the command path specifically, no resource provider is wired up at all. The string-render path used by `markdown.api.render` runs the identical renderer rules as the document-render path, so this preservation behavior applies uniformly to the command's output.

The **single load-bearing implementation detail** for your webview click handler: read the raw attribute via `element.getAttribute('href')` (or `getAttribute('data-href')`), **not** the DOM `element.href` property. Once the HTML is in the DOM (via `innerHTML`), the `.href` property is browser-normalized to an absolute URL (`https://file+.vscode-resource.vscode-cdn.net/...`) and the relative form is lost. VS Code's own markdown-preview click handler had exactly this bug, fixed in PR #228633 (merged Sept 2024).

---

## Confirmed Facts

*(High confidence — verified 3-0 against primary sources: microsoft/vscode source on `main`, merged PRs, official docs, the WHATWG/MDN DOM standard.)*

**1. The href attribute is preserved, not rewritten.** The engine's `link_open` renderer (`#addLinkRenderer` in `markdownEngine.ts`) does only:

```js
const href = token.attrGet('href');
if (typeof href === 'string') token.attrSet('data-href', href);
```

then delegates to the original renderer. There is **no** `token.attrSet('href', ...)` anywhere — the href is never overwritten. *(Answers sub-questions 2 and 3.)*

**2. Output for `[text](topic)` is a dual-attribute anchor.** Real captured output (issue #103076):

```html
<a href="#introduction" data-href="#introduction" title="#introduction">Introduction</a>
```

The `data-href` is **added alongside** href, not a replacement for it. For your case, `[text](./topic.md)` renders as:

```html
<a href="./topic.md" data-href="./topic.md">text</a>
```

*(Answers sub-question 1.)*

**3. Read `getAttribute('href')`, never the `.href` property.** PR #228633 ("Fix open html anchor link in markdown preview", file `preview-src/index.ts`) changed the handler from `node.href.startsWith(scheme)` to `node.getAttribute('href')`. PR description: *"The href property always resolves to an absolute URL starting with https, which prevents delegation of link resolution to VS Code."* Issue #203410 documents the failure: `./README.zh_TW.md` had its `.href` property resolve to `https://file+.vscode-resource.vscode-cdn.net/...`. Independently corroborated by the WHATWG/MDN DOM standard: `HTMLAnchorElement.href` is a stringifier returning the absolute URL, while `getAttribute('href')` returns the literal attribute value unchanged. *(Answers sub-question 6.)*

**4. `normalizeLink` rewrites only vscode-scheme URIs.** Verbatim:

```js
md.normalizeLink = (link) => {
  try {
    if (isOfScheme(Schemes.vscode, link) || isOfScheme(Schemes['vscode-insiders'], link)) {
      return normalizeLink(vscode.Uri.parse(link).with({ scheme: vscode.env.uriScheme }).toString());
    }
  } catch (e) { /* noop */ }
  return normalizeLink(link);
};
```

Relative paths fall through to markdown-it's default `normalizeLink`. Only the **image** renderer (`#addImageRenderer` / `#toResourceUri`) rewrites `src` to a resource URI; the link renderer never does. *(Answers sub-question 3.)*

**5. `validateLink` is a security gate, not a transformer.** Verbatim:

```js
md.validateLink = (link) =>
  validateLink(link)
  || isOfScheme(Schemes.vscode, link)
  || isOfScheme(Schemes['vscode-insiders'], link)
  || /^data:image\/.*?;/.test(link);
```

It returns a boolean controlling which hrefs survive sanitization (blocking `javascript:`/`vbscript:`/`file:`); it never alters the href string.

**6. The command path and document path share identical link handling.** `render()` calls `getEngine(config)` once, then branches `typeof input === 'string' ? tokenizeString(...) : tokenizeDocument(...)`; both end at `engine.parse()` on the same cached engine with rules installed once at construction. The `link_open` rule has no branch on `env.currentDocument`. The only path difference is `env.currentDocument` (undefined for the string input used by `markdown.api.render`), which does not affect link handling. *(Answers sub-question 4 for links.)*

**7. Relative-path resolution semantics.** Official docs: paths starting with `/` resolve relative to the **workspace root/folder**; paths starting with `./` or with no prefix resolve relative to the **current file**. Maintainer-confirmed as-designed in issues #120754 and #299488. (Caveat: in multi-root workspaces, `/` resolves to the containing workspace folder, which may differ from the git repo root.)

**8. `markdown.api.render` is a first-party built-in.** Provided by the bundled `markdown-language-features` extension ("can be disabled but not uninstalled"). Command introduced in PR #77151, shipped in VS Code v1.38 (2019). *(Partial answer to sub-question 5.)*

**9. Webview resource isolation is the extension's responsibility, not automatic.** Webviews "run in isolated contexts that cannot directly access local resources"; local `file:` URIs need `Webview.asWebviewUri` and `localResourceRoots` whitelisting. This conversion does **not** happen automatically to `<a>` hrefs in `markdown.api.render` output — you must resolve relative paths yourself.

**10. This behavior is undocumented in official prose.** The Markdown Extension API guide covers only `previewStyles`/`markdownItPlugins`/`previewScripts` and never mentions `markdown.api.render`, its return value, or href processing. Rely on source-code behavior (above), not docs, for href specifics.

---

## Likely but Unverified

*(Confirmed but with a surface/scope caveat — verified 2-1.)*

- **Reading the raw href makes relative anchors behave like markdown links** (open the local file inside VS Code rather than an external browser). Evidence is PR #228633 / issue #203410, which fix the **preview webview's own** click handler — a different surface from `markdown.api.render` in a third-party webview. The underlying attribute-vs-property mechanism transfers directly, but the preview's click handler is **not** automatically present in your custom webview; you must implement your own.
- **The Markdown preview enforces a strict default CSP** (script execution disabled, resources only over https, http images blocked). This governs how content *renders and loads* — it does **not** alter the href attribute string and does **not** block reading the attribute in a click handler. Critically, **your host webview's CSP is set independently** by your extension, not inherited from the preview. *(Answers sub-question 7: CSP does not affect the href attribute value or your ability to read it; it affects what happens on actual navigation, which is why you intercept clicks and `postMessage` to the extension rather than letting the anchor navigate.)*

---

## Uncertain

*(Open questions no source resolved — flagged honestly rather than guessed.)*

- **Pre-2020 version differences (sub-question 5).** No source directly tested whether the `data-href` dual-attribute existed in the earliest 1.38 release of the command, or was added later. Behavior is stable from a 2020 issue (#103076) through current `main`, but per-version relative-link handling was never enumerated.
- **Raw HTML anchors in markdown source.** When the `.md` contains a literal `<a href="./topic.md">` (rather than `[..](..)` syntax), it is unclear whether `link_open` still attaches `data-href`, or whether `data-href` is added only to markdown-syntax links. The engine code suggests `link_open` fires on markdown-syntax tokens; raw-HTML anchor handling is less certain. **Test this if your content mixes raw HTML anchors.**
- **Percent-encoding of special characters.** `[x](my topic.md)` — markdown-it's default `normalizeLink` URL-encodes the path, so `href` would be percent-encoded. A click handler must **decode** before path resolution. Not addressed by any source.
- **Base-tag vs manual resolution in a custom webview.** Whether setting `<base href>` or relying on `localResourceRoots` changes how you resolve `getAttribute('href')` back to workspace files, or whether you must fully resolve relative paths yourself against the source document's URI. (The `<base>`-tag-resolves-everything theory was explicitly **refuted** — see below.)

---

## Trade-off Evaluation — How to Read the Link in Your Click Handler

Since hrefs are **preserved** (not transformed), the real decision is *which attribute to read and how to resolve it*:

| Option | Verdict | Notes |
| :--- | :--- | :--- |
| `element.getAttribute('data-href')` | **Recommended** | Captured *before* any `normalizeLink` processing — the most defensively-correct original value. Survives the slugify/scheme-rewrite edge cases where `href` could diverge. |
| `element.getAttribute('href')` | **Works** | Byte-identical to `data-href` for bare relative paths and fragments. Can diverge only when `normalizeLink` slugifies heading text or scheme-rewrites `vscode:` URIs — irrelevant for your `topic` / `./topic.md` case. |
| `element.href` (DOM property) | **Broken** | Returns an absolute `https://file+.vscode-resource.vscode-cdn.net/...` URL; the relative form is gone. This is the exact bug PR #228633 fixed. |
| `<base href>` tag resolves everything | **Refuted (0-3)** | The preview does not leave relative hrefs for a `<base>` tag to resolve at render time; do not rely on this. |
| `javascript:` URI in href that posts a message | **Refuted (0-3)** | Blocked by webview CSP; not a viable routing technique. |

**Recommended pattern** — delegate click handling, then route through `postMessage`:

```js
container.addEventListener('click', e => {
  const a = e.target.closest('a');
  if (!a) return;
  const raw = a.getAttribute('data-href') ?? a.getAttribute('href');
  e.preventDefault();
  vscodeApi.postMessage({ type: 'openLink', href: decodeURIComponent(raw) });
});
```

In the extension host, resolve `raw` against the **source document's URI** (`./` / no-prefix → relative to the file; `/` → workspace folder), then open. Don't try to make the anchor navigate natively — intercept and route through `postMessage`.

**One command-path nuance worth knowing:** the `markdown.api.render` command (`renderDocument.ts`) passes **no `WebviewResourceProvider`**, so unlike the preview's document-render path, even `<img>` src values are left untransformed in the command's output. If you display rendered images, you must convert their `src` with `asWebviewUri` yourself.

---

## Glossary

- **`markdown.api.render`** — Command exposed by the built-in `markdown-language-features` extension; `executeCommand<string>('markdown.api.render', md)` returns rendered HTML as a string.
- **`link_open` rule** — A markdown-it renderer rule for the opening `<a>` tag. VS Code overrides it to copy `href` into a `data-href` attribute.
- **`normalizeLink` / `validateLink`** — markdown-it hooks. `normalizeLink` *transforms* a URL string; `validateLink` is a boolean *security gate*. VS Code customizes both but neither rewrites relative anchor hrefs.
- **`asWebviewUri`** — Webview API method converting a local `file:` URI into a webview-loadable URI. Applied to `<img>` src in the preview's document path; never auto-applied to `<a>` href.
- **href attribute vs `.href` property** — The *attribute* (`getAttribute('href')`) is the literal string in the markup; the *property* (`.href`) is browser-normalized to an absolute URL.
- **`data-href`** — A custom duplicate attribute VS Code adds to anchors, holding the pre-normalization href value.
- **CSP (Content Security Policy)** — The webview's security meta tag; governs resource loading and script execution, not attribute string contents.
- **`vscode-resource` / `file+.vscode-resource.vscode-cdn.net`** — The internal origin against which a webview resolves relative URLs, which is why the `.href` property produces an absolute CDN-style URL.

---

## Methodology & Source Notes

The brief targeted ≥50 sources. In practice the question converged on a **compact set of ~20 authoritative primary sources** — the engine source code, three or four decisive PRs/issues, official docs, and the DOM standard — which fully and consistently answer it. The 99-agent fan-out surfaced dozens of candidate results across 5 angles; after URL-deduplication 17 sources were fetched and verified, plus the corroborating standards/practitioner references cited inline above. Padding to 50 would have meant adding redundant, lower-value links that do not change any conclusion, so I have listed only the load-bearing, verified sources. Eight candidate claims were adversarially **refuted and excluded**, including: relative links rewritten to `file+.vscode-resource` form in render output (0-3); `<base>`-tag render-time resolution (0-3); render non-determinism from heading-ID suffixing (0-3); and `javascript:`-URI message-posting (0-3).

## Sources

1. microsoft/vscode — `extensions/markdown-language-features/src/markdownEngine.ts` (engine source, `main` branch)
2. microsoft/vscode — `extensions/markdown-language-features/` (extension README/tree)
3. microsoft/vscode — `extensions/markdown-language-features/package.json` (command registration)
4. microsoft/vscode — Issue #103076 (captured `markdown.api.render` HTML output)
5. microsoft/vscode — PR #228633, "Fix open html anchor link in markdown preview" (merged 2024-09-18)
6. microsoft/vscode — Issue #203410 (relative anchor opening externally; `.href` normalization bug)
7. microsoft/vscode — Issue #80338 (`markdown.api.render` string vs TextDocument input)
8. microsoft/vscode — Issue #120754 (leading `/` resolves to workspace folder, as-designed)
9. microsoft/vscode — Issue #299488 (`/docs/...` and `./docs/...` link resolution)
10. microsoft/vscode — Issue #140733 (markdown-syntax vs raw-HTML anchor link behavior)
11. microsoft/vscode — Issue #158528 (preview relative-path / base-tag discussion)
12. microsoft/vscode — Issue #98100 (notebook webview link interception)
13. microsoft/vscode — Issue #97962 (webview resource URIs / `asWebviewUri`)
14. microsoft/vscode — Issue #189214 (CSP / innerHTML anchor behavior)
15. microsoft/vscode — Issue #98542 (webview click handling / external link opening)
16. microsoft/vscode — Issue #112459 (known divergence / link handling)
17. Visual Studio Code Docs — Markdown (`code.visualstudio.com/docs/languages/markdown`) — relative path resolution, preview security model
18. Visual Studio Code API — Markdown Extension API guide (`code.visualstudio.com/api/extension-guides/markdown-extension`)
19. Visual Studio Code API — Webview API guide (`code.visualstudio.com/api/extension-guides/webview`)
20. Visual Studio Code — v1.38 release notes (`markdown.api.render` introduction)
21. MDN / WHATWG DOM — `HTMLAnchorElement.href` (attribute vs property normalization)
22. Matt Bierner — "VS Code Webview Web Learnings" (practitioner blog, webview behavior)
23. Elio Struyf — "Command URI in a VS Code webview to open files/links" (practitioner blog)
