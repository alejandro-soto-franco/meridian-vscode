import * as vscode from "vscode";
import { buildGraphForFile, graphToDot } from "./graph";

// Standalone editor panel rendering the dependency graph for the most recently
// focused Lean file. Behaves like LeanInfoView: lives beside the editor, stays
// pinned to the last active .lean document even when the user interacts with
// the panel itself (which would otherwise deactivate the editor).
export class GapsPanel {
  public static readonly viewType = "meridian.depGraphPanel";
  private static instance: GapsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private lastLeanFile: string | undefined;

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
      "Dependency Graph",
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

  // Called by the activation hook whenever the active editor changes.
  // If the new active editor is a Lean file, remember it; otherwise (webview
  // tab focus, output panel, etc.) keep showing the previous graph.
  refresh(): void {
    const active = vscode.window.activeTextEditor;
    if (active && active.document.languageId === "lean4") {
      this.lastLeanFile = active.document.uri.fsPath;
    }
    const filePath = this.lastLeanFile;
    if (!filePath) {
      this.panel.webview.html = this.shell("Open a Lean file to see its dependency graph.");
      return;
    }
    const { lakeRoot, rootImport } = this.resolveProject();
    if (!lakeRoot) {
      this.panel.webview.html = this.shell("No Lake project found.");
      return;
    }
    const graph = buildGraphForFile(lakeRoot, rootImport, filePath);
    if (!graph.nodes.length) {
      this.panel.webview.html = this.shell("No declarations found in this file.");
      return;
    }
    const dot = graphToDot(graph);
    const nodeMeta = Object.fromEntries(
      graph.nodes.map((n) => [n.id, { file: n.file ?? null, line: n.line ?? null, kind: n.kind, label: n.label }]),
    );
    const adjacency: Record<string, string[]> = {};
    for (const n of graph.nodes) adjacency[n.id] = [];
    for (const e of graph.edges) {
      (adjacency[e.from] ??= []).push(e.to);
      (adjacency[e.to]   ??= []).push(e.from);
    }
    this.panel.title = `Dependency Graph — ${filePath.split("/").pop()}`;
    this.panel.webview.html = this.render(dot, nodeMeta, adjacency);
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

  private render(
    dot: string,
    nodeMeta: Record<string, { file: string | null; line: number | null; kind: string; label: string }>,
    adjacency: Record<string, string[]>,
  ): string {
    const dotJson = JSON.stringify(dot);
    const metaJson = JSON.stringify(nodeMeta);
    const adjJson = JSON.stringify(adjacency);
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
        overflow: hidden;
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

      #viewport {
        position: relative;
        width: 100%;
        height: calc(100vh - 38px);
        overflow: auto;
        padding: 16px;
        box-sizing: border-box;
      }
      #stage {
        transform-origin: 0 0;
        transition: transform 120ms ease;
        width: max-content;
      }
      #stage svg { display: block; }
      #stage svg text {
        font-family: var(--cm) !important;
        font-size: 10px !important;
      }
      #stage svg path { stroke-linecap: round; stroke-linejoin: round; }
      #stage g.node { cursor: pointer; transition: opacity 150ms ease; }
      #stage g.node:hover { filter: drop-shadow(0 1px 4px rgba(76,154,255,.35)); }
      #stage g.node.selected > *:first-child + * { stroke-width: 2.4 !important; }
      #stage g.edge { cursor: pointer; transition: opacity 150ms ease; }
      #stage g.edge path { transition: stroke-opacity 120ms ease, stroke-width 120ms ease; }
      #stage g.edge:hover path { stroke-opacity: 1; stroke-width: 1.8; }
      #stage.focused g.node:not(.in-focus) { opacity: 0.12; }
      #stage.focused g.edge:not(.in-focus) { opacity: 0.08; }
      #stage.focused g.edge.in-focus path { stroke-width: 1.8; stroke-opacity: 1; }

      #zoom {
        position: fixed;
        right: 18px; bottom: 18px;
        display: flex; flex-direction: column;
        background: var(--vscode-editorWidget-background, rgba(30,30,30,0.85));
        border: 1px solid var(--border);
        border-radius: 6px;
        overflow: hidden;
        box-shadow: 0 2px 8px rgba(0,0,0,0.25);
        font-family: var(--cm);
      }
      #zoom button {
        all: unset;
        width: 32px; height: 30px;
        display: flex; align-items: center; justify-content: center;
        font-size: 14px; line-height: 1;
        cursor: pointer;
        color: var(--fg);
      }
      #zoom button + button { border-top: 1px solid var(--border); }
      #zoom button:hover { background: var(--vscode-list-hoverBackground); }
      #zoomLabel {
        font-size: 10px; text-align: center; padding: 2px 0;
        color: var(--muted); border-top: 1px solid var(--border);
      }

      #edgeInfo {
        position: fixed;
        left: 50%; transform: translateX(-50%);
        bottom: 18px;
        max-width: 70%;
        background: var(--vscode-editorWidget-background, #2b2b2b);
        color: var(--fg);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 8px 12px;
        font-size: 11px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.25);
        display: none;
        font-family: var(--cm);
      }
      #edgeInfo code { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
      #edgeInfo .from, #edgeInfo .to { color: var(--vscode-textLink-foreground); cursor: pointer; }
      #edgeInfo .kind { color: var(--muted); margin-left: 6px; font-style: italic; }
      #edgeInfo .close { float: right; cursor: pointer; color: var(--muted); margin-left: 10px; }
    </style></head><body>
      <div id="legend">
        <span><i class="import"></i>import</span>
        <span><i class="root"></i>file decl</span>
        <span><i class="project"></i>project</span>
        <span><i class="mathlib"></i>Mathlib</span>
        <span><i class="std"></i>Std / Lean</span>
      </div>
      <div id="viewport"><div id="stage"><div style="padding:1rem;color:var(--muted)">rendering…</div></div></div>
      <div id="zoom">
        <button id="zoomIn" title="Zoom in">+</button>
        <button id="zoomOut" title="Zoom out">&minus;</button>
        <button id="zoomReset" title="Reset">&#x25CE;</button>
        <div id="zoomLabel">100%</div>
      </div>
      <div id="edgeInfo">
        <span class="close" id="edgeClose">&times;</span>
        <span class="from" id="edgeFrom"></span>
        <span>&nbsp;&rarr;&nbsp;</span>
        <span class="to" id="edgeTo"></span>
        <span class="kind" id="edgeKind"></span>
      </div>
      <script type="module">
        const vscode = acquireVsCodeApi();
        const meta = ${metaJson};
        const adjacency = ${adjJson};

        // ---------------- zoom ----------------
        const stage = document.getElementById('stage');
        const zoomLabel = document.getElementById('zoomLabel');
        let scale = 1;
        const applyScale = () => {
          stage.style.transform = 'scale(' + scale + ')';
          zoomLabel.textContent = Math.round(scale * 100) + '%';
        };
        document.getElementById('zoomIn').onclick  = () => { scale = Math.min(scale * 1.2, 4); applyScale(); };
        document.getElementById('zoomOut').onclick = () => { scale = Math.max(scale / 1.2, 0.25); applyScale(); };
        document.getElementById('zoomReset').onclick = () => { scale = 1; applyScale(); };
        document.getElementById('viewport').addEventListener('wheel', (e) => {
          if (!e.ctrlKey && !e.metaKey) return;
          e.preventDefault();
          scale = Math.max(0.25, Math.min(4, scale * (e.deltaY < 0 ? 1.1 : 1/1.1)));
          applyScale();
        }, { passive: false });

        // ---------------- edge info ----------------
        const infoEl = document.getElementById('edgeInfo');
        const fromEl = document.getElementById('edgeFrom');
        const toEl   = document.getElementById('edgeTo');
        const kindEl = document.getElementById('edgeKind');
        document.getElementById('edgeClose').onclick = () => { infoEl.style.display = 'none'; };

        const kindLabel = (k) => {
          switch (k) {
            case 'mathlib': return 'Mathlib reference';
            case 'std':     return 'Std/Lean reference';
            case 'project': return 'project reference';
            case 'import':  return 'file import';
            case 'root':    return 'file declaration';
            default:        return 'unresolved reference';
          }
        };

        // ---------------- render ----------------
        try {
          const { Graphviz } = await import("https://cdn.jsdelivr.net/npm/@hpcc-js/wasm@2.20.0/dist/graphviz.js");
          const gv = await Graphviz.load();
          const svg = gv.dot(${dotJson});
          stage.innerHTML = svg;

          // Build quick lookup from node id -> SVG group and edge "from->to" -> SVG group.
          const nodeById = new Map();
          const edgesByNode = new Map(); // nodeId -> Array<{el, other}>
          stage.querySelectorAll('g.node').forEach((g) => {
            const t = g.querySelector('title');
            if (!t) return;
            const id = t.textContent;
            nodeById.set(id, g);
            g.setAttribute('data-id', id);
          });
          stage.querySelectorAll('g.edge').forEach((g) => {
            const t = g.querySelector('title');
            if (!t) return;
            const parts = t.textContent.split('->').map(s => s.trim());
            if (parts.length !== 2) return;
            const [from, to] = parts;
            g.setAttribute('data-from', from);
            g.setAttribute('data-to', to);
            if (!edgesByNode.has(from)) edgesByNode.set(from, []);
            if (!edgesByNode.has(to))   edgesByNode.set(to, []);
            edgesByNode.get(from).push({ el: g, other: to, direction: 'out' });
            edgesByNode.get(to).push({ el: g, other: from, direction: 'in' });
          });

          let selected = null;
          const clearFocus = () => {
            selected = null;
            stage.classList.remove('focused');
            stage.querySelectorAll('.in-focus').forEach((el) => el.classList.remove('in-focus'));
            stage.querySelectorAll('.selected').forEach((el) => el.classList.remove('selected'));
          };
          const applyFocus = (id) => {
            selected = id;
            stage.classList.add('focused');
            stage.querySelectorAll('.in-focus').forEach((el) => el.classList.remove('in-focus'));
            stage.querySelectorAll('.selected').forEach((el) => el.classList.remove('selected'));
            const rootNode = nodeById.get(id);
            if (rootNode) { rootNode.classList.add('in-focus'); rootNode.classList.add('selected'); }
            for (const nb of (adjacency[id] || [])) {
              const nbEl = nodeById.get(nb);
              if (nbEl) nbEl.classList.add('in-focus');
            }
            for (const info of (edgesByNode.get(id) || [])) {
              info.el.classList.add('in-focus');
            }
          };

          stage.querySelectorAll('g.node').forEach((g) => {
            const id = g.getAttribute('data-id');
            if (!id) return;
            let clickTimer = null;
            g.addEventListener('click', (ev) => {
              ev.stopPropagation();
              // Defer so double-click can cancel.
              if (clickTimer) return;
              clickTimer = setTimeout(() => {
                clickTimer = null;
                if (selected === id) clearFocus();
                else applyFocus(id);
              }, 220);
            });
            g.addEventListener('dblclick', (ev) => {
              ev.stopPropagation();
              if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
              const info = meta[id];
              if (info && info.file) vscode.postMessage({ type: 'openFile', file: info.file, line: info.line });
            });
          });
          document.getElementById('viewport').addEventListener('click', (ev) => {
            if (ev.target === ev.currentTarget || ev.target === stage) clearFocus();
          });

          stage.querySelectorAll('g.edge').forEach((g) => {
            const t = g.querySelector('title');
            if (!t) return;
            // Graphviz title format for directed edges: "from->to"
            const parts = t.textContent.split('->').map(s => s.trim());
            if (parts.length !== 2) return;
            const [from, to] = parts;
            g.addEventListener('click', (ev) => {
              ev.stopPropagation();
              fromEl.textContent = (meta[from] && meta[from].label) || from;
              toEl.textContent   = (meta[to]   && meta[to].label)   || to;
              kindEl.textContent = '(' + kindLabel(meta[to] && meta[to].kind) + ')';
              fromEl.onclick = () => {
                const m = meta[from];
                if (m && m.file) vscode.postMessage({ type: 'openFile', file: m.file, line: m.line });
              };
              toEl.onclick = () => {
                const m = meta[to];
                if (m && m.file) vscode.postMessage({ type: 'openFile', file: m.file, line: m.line });
              };
              infoEl.style.display = 'block';
            });
          });
        } catch (e) {
          stage.innerHTML = '<div style="padding:1rem;color:var(--muted)">Graphviz failed to load: ' + e + '</div>';
        }
      </script>
    </body></html>`;
  }
}
