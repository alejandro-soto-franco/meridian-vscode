import * as vscode from "vscode";
import { extractDot, parseSorryInventory, parseGapReport, stripLeanNoise } from "./parser";

let panel: vscode.WebviewPanel | undefined;

export function show(context: vscode.ExtensionContext, title: string, html: string) {
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      "meridian.results",
      "Meridian",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.onDidDispose(() => { panel = undefined; });
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === "openFile" && msg.file) {
        const uri = vscode.Uri.file(msg.file);
        const doc = await vscode.workspace.openTextDocument(uri);
        const ed = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        if (typeof msg.line === "number") {
          const pos = new vscode.Position(Math.max(0, msg.line - 1), 0);
          ed.selection = new vscode.Selection(pos, pos);
          ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        }
      }
    });
  }
  panel.title = `Meridian: ${title}`;
  panel.webview.html = html;
  panel.reveal(vscode.ViewColumn.Beside, true);
}

const BASE_STYLE = `
<style>
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 0.75rem 1rem; color: var(--vscode-foreground); }
  h2 { margin: 0 0 0.5rem 0; font-size: 1rem; }
  h3 { margin: 1rem 0 0.25rem; font-size: 0.9rem; color: var(--vscode-descriptionForeground); }
  table { border-collapse: collapse; width: 100%; margin-top: 0.5rem; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 0.85rem; }
  th { cursor: pointer; user-select: none; }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  a:hover { text-decoration: underline; }
  pre { background: var(--vscode-textBlockQuote-background); padding: 0.5rem; overflow: auto; border-radius: 4px; font-size: 0.8rem; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 0.8rem; margin-bottom: 0.5rem; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 0.75rem; margin-left: 6px; }
  .toolbar { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; }
  input[type=search] { flex: 1; padding: 4px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; }
  .graph { border: 1px solid var(--vscode-panel-border); border-radius: 4px; overflow: hidden; background: var(--vscode-editor-background); }
  .graph svg { width: 100%; height: 70vh; }
  .empty { color: var(--vscode-descriptionForeground); padding: 1rem; text-align: center; }
</style>
`;

const SORT_SCRIPT = `
<script>
  const vscode = acquireVsCodeApi();
  function enableSort(tableId) {
    const t = document.getElementById(tableId);
    if (!t) return;
    const ths = t.querySelectorAll('th');
    ths.forEach((th, i) => {
      th.addEventListener('click', () => {
        const rows = Array.from(t.querySelectorAll('tbody tr'));
        const asc = th.dataset.asc !== 'true';
        th.dataset.asc = String(asc);
        rows.sort((a, b) => {
          const av = a.children[i]?.textContent || '';
          const bv = b.children[i]?.textContent || '';
          return asc ? av.localeCompare(bv) : bv.localeCompare(av);
        });
        const tb = t.querySelector('tbody');
        rows.forEach((r) => tb.appendChild(r));
      });
    });
  }
  function enableFilter(inputId, tableId) {
    const inp = document.getElementById(inputId);
    const t = document.getElementById(tableId);
    if (!inp || !t) return;
    inp.addEventListener('input', () => {
      const q = inp.value.toLowerCase();
      t.querySelectorAll('tbody tr').forEach((r) => {
        r.style.display = r.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });
  }
  function openFile(file, line) {
    vscode.postMessage({ type: 'openFile', file, line });
  }
</script>
`;

export function renderRaw(title: string, text: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">${BASE_STYLE}</head><body>
    <h2>${escapeHtml(title)}</h2>
    <pre>${escapeHtml(stripLeanNoise(text))}</pre>
  </body></html>`;
}

export function renderDepGraph(stderr: string, stdout: string): string {
  const dot = extractDot(stderr) ?? extractDot(stdout);
  const body = dot
    ? `<div class="graph" id="graph"></div>
       <h3>DOT source</h3>
       <pre>${escapeHtml(dot)}</pre>
       <script type="module">
         import { Graphviz } from "https://cdn.jsdelivr.net/npm/@hpcc-js/wasm@2.20.0/dist/graphviz.js";
         const graphviz = await Graphviz.load();
         const svg = graphviz.dot(${JSON.stringify(dot)});
         document.getElementById('graph').innerHTML = svg;
       </script>`
    : `<div class="empty">No DOT graph found in output.</div>
       <pre>${escapeHtml(stripLeanNoise(stderr || stdout))}</pre>`;
  return `<!doctype html><html><head><meta charset="utf-8">${BASE_STYLE}</head><body>
    <h2>Dependency Graph</h2>${body}</body></html>`;
}

export function renderSorryInventory(stderr: string, stdout: string): string {
  const rows = parseSorryInventory(stderr + "\n" + stdout);
  if (!rows.length) {
    return `<!doctype html><html><head><meta charset="utf-8">${BASE_STYLE}</head><body>
      <h2>Sorry Inventory <span class="badge">0</span></h2>
      <div class="empty">No entries parsed.</div>
      <pre>${escapeHtml(stripLeanNoise(stderr || stdout))}</pre></body></html>`;
  }
  const body = `
    <h2>Sorry Inventory <span class="badge">${rows.length}</span></h2>
    <div class="toolbar"><input id="filter" type="search" placeholder="Filter…" /></div>
    <table id="tbl"><thead><tr>
      <th>Name</th><th>File</th><th>Line</th><th>Category</th><th>Type</th>
    </tr></thead><tbody>
      ${rows.map((r) => `<tr>
        <td><code>${escapeHtml(r.name)}</code></td>
        <td>${r.file ? `<a onclick="openFile('${escapeJs(r.file)}', ${r.line ?? "null"})">${escapeHtml(r.file)}</a>` : ""}</td>
        <td>${r.line ?? ""}</td>
        <td>${escapeHtml(r.category ?? "")}</td>
        <td><code>${escapeHtml(r.type ?? "")}</code></td>
      </tr>`).join("")}
    </tbody></table>
    ${SORT_SCRIPT}
    <script>enableSort('tbl'); enableFilter('filter', 'tbl');</script>
  `;
  return `<!doctype html><html><head><meta charset="utf-8">${BASE_STYLE}</head><body>${body}</body></html>`;
}

export function renderGapReport(stderr: string, stdout: string): string {
  const rows = parseGapReport(stderr + "\n" + stdout);
  if (!rows.length) {
    return `<!doctype html><html><head><meta charset="utf-8">${BASE_STYLE}</head><body>
      <h2>Gap Report</h2>
      <div class="empty">No entries parsed.</div>
      <pre>${escapeHtml(stripLeanNoise(stderr || stdout))}</pre></body></html>`;
  }
  const body = `
    <h2>Mathlib Gap Report <span class="badge">${rows.length}</span></h2>
    <div class="toolbar"><input id="filter" type="search" placeholder="Filter…" /></div>
    <table id="tbl"><thead><tr>
      <th>Sorry</th><th>Candidate</th><th>Score</th><th>Note</th>
    </tr></thead><tbody>
      ${rows.map((r) => `<tr>
        <td><code>${escapeHtml(r.name)}</code></td>
        <td><code>${escapeHtml(r.candidate ?? "")}</code></td>
        <td>${escapeHtml(r.score ?? "")}</td>
        <td>${escapeHtml(r.note ?? "")}</td>
      </tr>`).join("")}
    </tbody></table>
    ${SORT_SCRIPT}
    <script>enableSort('tbl'); enableFilter('filter', 'tbl');</script>
  `;
  return `<!doctype html><html><head><meta charset="utf-8">${BASE_STYLE}</head><body>${body}</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
function escapeJs(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
