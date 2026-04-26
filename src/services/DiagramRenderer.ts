import * as vscode from 'vscode';

export interface RenderOptions {
  mermaidText: string;
  preview?: boolean;
  renderTimeout?: number; // ms, default 10000
}

export interface RenderResult {
  svg: string | null;      // null if rendering failed (text-only fallback)
  base64Svg: string | null; // base64-encoded SVG for upload
  base64MermaidText: string; // base64-encoded Mermaid text for upload
  error?: string;
}

export class DiagramRenderer {
  private static activePanel: vscode.WebviewPanel | null = null;
  private static previewPanel: vscode.WebviewPanel | null = null;

  /**
   * Render Mermaid text to SVG via webview and prepare data for upload.
   * Upload is handled by the MCP tool handler, not this renderer.
   */
  async render(options: RenderOptions): Promise<RenderResult> {
    const { mermaidText, preview = true, renderTimeout = 10000 } = options;

    // Step 1: Render Mermaid to SVG via webview
    let svg: string | null = null;
    try {
      svg = await this.renderViaWebview(mermaidText, renderTimeout);
    } catch (err) {
      console.error('[DiagramRenderer] Webview rendering failed, falling back to text-only:', err);
    }

    // Step 2: Show IDE preview if requested and SVG available
    if (preview && svg) {
      this.showPreview(svg);
    }

    // Step 3: Prepare base64-encoded data for upload by the MCP tool handler
    const base64Svg = svg ? Buffer.from(svg).toString('base64') : null;
    const base64MermaidText = Buffer.from(mermaidText).toString('base64');

    return { svg, base64Svg, base64MermaidText };
  }

  private renderViaWebview(mermaidText: string, timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      // Dispose any existing panel to prevent concurrent renders
      if (DiagramRenderer.activePanel) {
        DiagramRenderer.activePanel.dispose();
        DiagramRenderer.activePanel = null;
      }

      const panel = vscode.window.createWebviewPanel(
        'mermaidRenderer',
        'Diagram Renderer',
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: false }
      );
      DiagramRenderer.activePanel = panel;

      // Timeout guard
      const timer = setTimeout(() => {
        panel.dispose();
        DiagramRenderer.activePanel = null;
        reject(new Error(`Webview render timed out after ${timeout}ms`));
      }, timeout);

      // Handle SVG result from webview
      panel.webview.onDidReceiveMessage((msg: { type: string; svg?: string; error?: string }) => {
        if (msg.type === 'renderResult') {
          clearTimeout(timer);
          panel.dispose();
          DiagramRenderer.activePanel = null;
          if (msg.error) {
            reject(new Error(msg.error));
          } else if (msg.svg) {
            resolve(msg.svg);
          } else {
            reject(new Error('Webview returned empty result'));
          }
        }
      });

      // Load mermaid.js and render
      panel.webview.html = this.getWebviewContent(mermaidText);

      panel.onDidDispose(() => {
        clearTimeout(timer);
        DiagramRenderer.activePanel = null;
      });
    });
  }

  private getWebviewContent(mermaidText: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src https://cdn.jsdelivr.net 'unsafe-inline'; style-src 'unsafe-inline';">
  <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
</head>
<body>
  <div id="container"></div>
  <script>
    mermaid.initialize({ startOnLoad: false, theme: 'default' });
    (async () => {
      try {
        const { svg } = await mermaid.render('diagram-output', ${JSON.stringify(mermaidText)});
        vscode.postMessage({ type: 'renderResult', svg });
      } catch (err) {
        vscode.postMessage({ type: 'renderResult', error: err.message });
      }
    })();
  </script>
</body>
</html>`;
  }

  private showPreview(svg: string): void {
    // Dispose any existing preview panel to prevent accumulation
    if (DiagramRenderer.previewPanel) {
      DiagramRenderer.previewPanel.dispose();
      DiagramRenderer.previewPanel = null;
    }

    const panel = vscode.window.createWebviewPanel(
      'diagramPreview',
      'Architecture Diagram Preview',
      vscode.ViewColumn.Beside,
      { enableScripts: false }
    );
    panel.webview.html = `<!DOCTYPE html><html><body style="background:#fff;padding:20px">${svg}</body></html>`;
    DiagramRenderer.previewPanel = panel;
    panel.onDidDispose(() => {
      if (DiagramRenderer.previewPanel === panel) {
        DiagramRenderer.previewPanel = null;
      }
    });
  }

}
