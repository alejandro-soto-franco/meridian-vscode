import * as vscode from "vscode";
import { buildGraphForFile, graphToDot } from "./graph";

export class GapsPanel {
  public static readonly viewType = "meridian.gapsPanel";
  private static instance: GapsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(
    context: vscode.ExtensionContext,
    resolveProject: () => { lakeRoot?: string; rootImport: string },
  ): GapsPanel {
    if (GapsPanel.instance) {
      GapsPanel.instance.panel.reveal(vscode.ViewColumn.Beside, true);
      GapsPanel.instance.refresh();
      return GapsPanel.instance;
    }
    const panel = vscode.window.createWebviewPanel(
      GapsPanel.viewType,
      "Mathlib Gaps",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    GapsPanel.instance = new GapsPanel(panel, resolveProject);
    return GapsPanel.instance;
  }

  static current(): GapsPanel | undefined { return GapsPanel.instance; }

  private constructor(
    panel: vscode.WebviewPanel,
    private resolveProject: () => { lakeRoot?: string; rootImport: string },
  ) {
    this.panel = panel;
    panel.webview.onDidReceiveMessage(async (m) => {
      if (m?.type === "openFile" && m.file) {
        const uri = vscode.Uri.file(m.file);
        const doc = await vscode.workspace.openTextDocument(uri);
        const ed = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
        if (typeof m.line === "number") {
          const pos = new vscode.Position(Math.max(0, m.line - 1), 0);
          ed.selection = new vscode.Selection(pos, pos);
          ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        }
      }
    }, null, this.disposables);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.refresh();
  }

  refresh(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "lean4") {
      this.panel.webview.html = this.shell("Open a Lean file to see its dependency graph.");
      return;
    }
    const { lakeRoot, rootImport } = this.resolveProject();
    if (!lakeRoot) {
      this.panel.webview.html = this.shell("No Lake project found.");
      return;
    }
    const graph = buildGraphForFile(lakeRoot, rootImport, editor.document.uri.fsPath);
    if (!graph.nodes.length) {
      this.panel.webview.html = this.shell("No declarations found in this file.");
      return;
    }
    const dot = graphToDot(graph);
    const nodeMeta = Object.fromEntries(
      graph.nodes.map((n) => [n.id, { file: n.file ?? null, line: n.line ?? null }]),
    );
    this.panel.title = `Mathlib Gaps — ${editor.document.fileName.split("/").pop()}`;
    this.panel.webview.html = this.render(dot, nodeMeta);
  }

  private dispose(): void {
    GapsPanel.instance = undefined;
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private shell(message: string): string {
    return `<!doctype html><html><head><meta charset="utf-8">
      <link rel="stylesheet" href="https://fonts.cdnfonts.com/css/cmu-sans-serif">
      <style>
        :root { color-scheme: light dark; }
        body { margin: 0; padding: 2rem; display: flex; align-items: center; justify-content: center;
               height: 100vh; box-sizing: border-box;
               font-family: "CMU Sans Serif", "Latin Modern Sans", "Helvetica Neue", system-ui, sans-serif;
               font-size: 13px;
               color: var(--vscode-descriptionForeground);
               background: var(--vscode-editor-background); }
      </style></head><body>${message}</body></html>`;
  }

  private render(dot: string, nodeMeta: Record<string, { file: string | null; line: number | null }>): string {
    const dotJson = JSON.stringify(dot);
    const metaJson = JSON.stringify(nodeMeta);
    return `<!doctype html><html><head><meta charset="utf-8">
    <link rel="stylesheet" href="https://fonts.cdnfonts.com/css/cmu-sans-serif">
    <style>
      :root {
        color-scheme: light dark;
        --fg: var(--vscode-foreground);
        --bg: var(--vscode-editor-background);
        --muted: var(--vscode-descriptionForeground);
        --border: var(--vscode-panel-border);
        --cm: "CMU Sans Serif", "Latin Modern Sans", "Helvetica Neue", system-ui, sans-serif;
      }
      html, body { height: 100%; }
      body {
        margin: 0; padding: 0;
        font-family: var(--cm);
        font-feature-settings: "kern", "liga", "calt";
        -webkit-font-smoothing: antialiased;
        color: var(--fg); background: var(--bg);
      }
      #legend {
        padding: 10px 16px;
        font-size: 11px;
        letter-spacing: 0.03em;
        color: var(--muted);
        border-bottom: 1px solid var(--border);
        display: flex; gap: 16px; flex-wrap: wrap; align-items: center;
      }
      #legend span { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
      #legend i { width: 12px; height: 8px; border-radius: 2px; display: inline-block; box-sizing: border-box; }
      #legend .root    { background: #4c9aff; }
      #legend .project { border: 1.3px solid #8e9aaf; }
      #legend .mathlib { border: 1.3px solid #e5a13a; }
      #legend .std     { border: 1.3px solid #b48ead; }
      #legend .import  { background: #fff4e0; border: 1.3px solid #e5a13a; }
      #graph {
        width: 100%;
        height: calc(100vh - 38px);
        overflow: auto;
        padding: 16px;
        box-sizing: border-box;
      }
      #graph svg { width: 100%; height: auto; display: block; }
      #graph svg text {
        font-family: var(--cm) !important;
        font-size: 10px !important;
      }
      #graph svg path { stroke-linecap: round; stroke-linejoin: round; }
      #graph g.node { cursor: pointer; transition: transform 120ms ease; }
      #graph g.node:hover { filter: drop-shadow(0 1px 4px rgba(76,154,255,.35)); }
      #graph g.edge path { transition: stroke-opacity 120ms ease; }
      #graph g.edge:hover path { stroke-opacity: 1; }
      #empty { padding: 1rem; color: var(--muted); }
    </style></head><body>
      <div id="legend">
        <span><i class="import"></i>import</span>
        <span><i class="root"></i>file decl</span>
        <span><i class="project"></i>project</span>
        <span><i class="mathlib"></i>Mathlib</span>
        <span><i class="std"></i>Std / Lean</span>
      </div>
      <div id="graph"><div id="empty">rendering…</div></div>
      <script type="module">
        const vscode = acquireVsCodeApi();
        const meta = ${metaJson};
        try {
          const { Graphviz } = await import("https://cdn.jsdelivr.net/npm/@hpcc-js/wasm@2.20.0/dist/graphviz.js");
          const gv = await Graphviz.load();
          const svg = gv.dot(${dotJson});
          const el = document.getElementById('graph');
          el.innerHTML = svg;
          el.querySelectorAll('g.node').forEach((g) => {
            const t = g.querySelector('title');
            if (!t) return;
            const id = t.textContent;
            const info = meta[id];
            if (info && info.file) {
              g.addEventListener('click', () => vscode.postMessage({ type: 'openFile', file: info.file, line: info.line }));
            }
          });
        } catch (e) {
          document.getElementById('graph').innerHTML = '<div id="empty">Graphviz failed to load: ' + e + '</div>';
        }
      </script>
    </body></html>`;
  }
}
