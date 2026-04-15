import * as vscode from "vscode";
import { buildGraphForFile, graphToDot } from "./graph";

export class GapsWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "meridian.gaps";
  private view?: vscode.WebviewView;

  constructor(
    private context: vscode.ExtensionContext,
    private resolveLakeRoot: () => { lakeRoot?: string; rootImport: string },
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage(async (m) => {
      if (m?.type === "openFile" && m.file) {
        const uri = vscode.Uri.file(m.file);
        const doc = await vscode.workspace.openTextDocument(uri);
        const ed = await vscode.window.showTextDocument(doc, { preview: false });
        if (typeof m.line === "number") {
          const pos = new vscode.Position(Math.max(0, m.line - 1), 0);
          ed.selection = new vscode.Selection(pos, pos);
          ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        }
      }
    });
    this.refresh();
  }

  refresh(): void {
    if (!this.view) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "lean4") {
      this.view.webview.html = this.shell("Open a Lean file to see its dependency graph.");
      return;
    }
    const { lakeRoot, rootImport } = this.resolveLakeRoot();
    if (!lakeRoot) {
      this.view.webview.html = this.shell("No Lake project found.");
      return;
    }
    const graph = buildGraphForFile(lakeRoot, rootImport, editor.document.uri.fsPath);
    if (!graph.nodes.length) {
      this.view.webview.html = this.shell("No declarations found in this file.");
      return;
    }
    const dot = graphToDot(graph);
    const nodeMeta = Object.fromEntries(
      graph.nodes.map((n) => [n.id, { file: n.file ?? null, line: n.line ?? null }]),
    );
    this.view.webview.html = this.render(dot, nodeMeta);
  }

  private shell(message: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
             color: var(--vscode-descriptionForeground); padding: 1rem; }
    </style></head><body>${message}</body></html>`;
  }

  private render(dot: string, nodeMeta: Record<string, { file: string | null; line: number | null }>): string {
    const dotJson = JSON.stringify(dot);
    const metaJson = JSON.stringify(nodeMeta);
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      :root { color-scheme: light dark; }
      body { margin: 0; padding: 0; font-family: var(--vscode-font-family);
             color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
      #legend { padding: 6px 8px; font-size: 0.75rem; color: var(--vscode-descriptionForeground);
                border-bottom: 1px solid var(--vscode-panel-border); display: flex; gap: 8px; flex-wrap: wrap; }
      #legend span { display: inline-flex; align-items: center; gap: 4px; }
      #legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
      #graph { width: 100%; height: calc(100vh - 32px); overflow: auto; }
      #graph svg { width: 100%; height: auto; }
      #graph g.node { cursor: pointer; }
      #graph g.node:hover ellipse, #graph g.node:hover polygon { filter: brightness(1.15); }
      #empty { padding: 1rem; color: var(--vscode-descriptionForeground); }
    </style></head><body>
      <div id="legend">
        <span><i style="background:#3c6e71"></i>file decl</span>
        <span><i style="background:#d9d9d9"></i>project ref</span>
        <span><i style="background:#f6c177"></i>Mathlib</span>
        <span><i style="background:#c4a7e7"></i>Std/Lean/Init</span>
        <span><i style="background:#eee;border:1px dashed #888"></i>unknown</span>
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
