import * as fs from "fs";
import * as path from "path";
import { listProjectModules } from "./coverage";
import { scanLinesForDecls } from "./scanner";

// Qualified Lean identifiers: at least one dot, starts with alpha/underscore.
// Ignores numerics and anything too short.
const QUAL_IDENT = /\b([A-Za-z_][\w']*(?:\.[A-Za-z_][\w']*)+)\b/g;

const LEAN_RESERVED = new Set([
  "Prop", "Type", "Sort", "Nat", "Int", "Bool", "String", "Char", "Float",
  "List", "Array", "Option", "Unit", "True", "False", "And", "Or", "Not",
]);

export interface DeclRef {
  name: string;          // the decl defined in this file
  line: number;
  file: string;
  body: string;          // the text between its header and the next decl / end-of-file
  refs: string[];        // qualified identifiers referenced in its body
}

export interface GraphNode {
  id: string;
  label: string;
  kind: "root" | "project" | "mathlib" | "std" | "unknown" | "import";
  file?: string;
  line?: number;
}

export interface GraphEdge { from: string; to: string; }

export interface DepGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  rootFile: string;
}

// Collect { decl -> {file, line, body} } for the whole project, once.
export function indexProjectDecls(lakeRoot: string, rootImport: string): Map<string, { file: string; line: number; body: string }> {
  const idx = new Map<string, { file: string; line: number; body: string }>();
  for (const { file } of listProjectModules(lakeRoot, rootImport)) {
    let src: string;
    try { src = fs.readFileSync(file, "utf8"); } catch { continue; }
    const lines = src.split(/\r?\n/);
    const decls = scanLinesForDecls(lines);
    for (let i = 0; i < decls.length; i++) {
      const d = decls[i]!;
      const endLine = i + 1 < decls.length ? decls[i + 1]!.line - 1 : lines.length;
      const body = lines.slice(d.line - 1, endLine).join("\n");
      idx.set(d.name, { file, line: d.line, body });
    }
  }
  return idx;
}

export function refsFromBody(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(QUAL_IDENT)) {
    const n = m[1]!;
    if (LEAN_RESERVED.has(n)) continue;
    // Skip attribute names like @[simp] (regex already skips single-ident attrs, but be safe).
    out.add(n);
  }
  return [...out];
}

export function classifyRef(name: string, projectRoot: string): GraphNode["kind"] {
  if (name === projectRoot || name.startsWith(projectRoot + ".")) return "project";
  if (name.startsWith("Mathlib.")) return "mathlib";
  if (name.startsWith("Std.") || name.startsWith("Lean.") || name.startsWith("Init.")) return "std";
  return "unknown";
}

// Build a 2-hop graph rooted at the decls in `leanFile`, truncating at
// Mathlib/Std references (no further expansion).
export function buildGraphForFile(
  lakeRoot: string,
  rootImport: string,
  leanFile: string,
): DepGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const addNode = (n: GraphNode) => { if (!nodes.has(n.id)) nodes.set(n.id, n); };
  const addEdge = (from: string, to: string) => {
    if (from !== to) edges.push({ from, to });
  };

  const projectIdx = indexProjectDecls(lakeRoot, rootImport);
  const src = fs.readFileSync(leanFile, "utf8");
  const lines = src.split(/\r?\n/);
  const rootDecls = scanLinesForDecls(lines);

  // Parse every `import X.Y` line in the preamble. Mathlib imports become the
  // gold "feed-in" column; non-Mathlib imports still flow in but with a
  // neutral tint so the Mathlib surface stays visually distinct.
  const importRe = /^\s*import\s+([A-Za-z_][\w']*(?:\.[A-Za-z_][\w']*)*)\s*$/;
  const fileImports: string[] = [];
  let inBlockComment = false;
  for (const ln of lines) {
    const trimmed = ln.trim();
    // Track /- ... -/ block comments so we don't break on them.
    if (inBlockComment) { if (ln.includes("-/")) inBlockComment = false; continue; }
    if (trimmed.startsWith("/-") && !trimmed.includes("-/")) { inBlockComment = true; continue; }
    if (!trimmed || trimmed.startsWith("--") || trimmed.startsWith("/-")) continue;
    const m = importRe.exec(ln);
    if (m) { fileImports.push(m[1]!); continue; }
    // First non-import, non-comment, non-blank line: preamble is over.
    break;
  }

  // Add import nodes feeding into every decl in the file.
  // Mathlib imports keep the gold `import` kind; everything else flows in as
  // a neutral `project`-style import so it doesn't compete visually.
  for (const imp of fileImports) {
    const kind: GraphNode["kind"] = imp === "Mathlib" || imp.startsWith("Mathlib.") ? "import" : "project";
    addNode({ id: `import:${imp}`, label: imp, kind });
  }

  for (let i = 0; i < rootDecls.length; i++) {
    const d = rootDecls[i]!;
    const end = i + 1 < rootDecls.length ? rootDecls[i + 1]!.line - 1 : lines.length;
    const body = lines.slice(d.line - 1, end).join("\n");
    addNode({ id: d.name, label: d.name, kind: "root", file: leanFile, line: d.line });
    for (const imp of fileImports) addEdge(`import:${imp}`, d.name);

    const level1 = refsFromBody(body).filter((r) => r !== d.name);
    for (const r of level1) {
      const kind = classifyRef(r, rootImport);
      const l1Info = projectIdx.get(r);
      addNode({ id: r, label: r, kind, file: l1Info?.file, line: l1Info?.line });
      addEdge(d.name, r);

      // Expand level 2 only for project refs.
      if (kind === "project" && l1Info) {
        const level2 = refsFromBody(l1Info.body).filter((r2) => r2 !== r);
        for (const r2 of level2) {
          const k2 = classifyRef(r2, rootImport);
          const l2Info = projectIdx.get(r2);
          addNode({ id: r2, label: r2, kind: k2, file: l2Info?.file, line: l2Info?.line });
          addEdge(r, r2);
        }
      }
    }
  }

  return { nodes: [...nodes.values()], edges, rootFile: leanFile };
}

// Build a Graphviz HTML-like label that renders the namespace segment in
// Latin Modern Sans and the terminal declaration name in Latin Modern Mono.
// Returns the full label expression including the surrounding angle brackets.
// (Graphviz HTML-like labels: https://graphviz.org/doc/info/shapes.html#html)
function htmlLabel(name: string): string {
  const parts = name.split(".");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const short = parts.length <= 2 ? name : parts.slice(-2).join(".");
  return `<<FONT FACE="Latin Modern Mono">${esc(short)}</FONT>>`;
}

export function graphToDot(g: DepGraph): string {
  const esc = (s: string) => s.replace(/"/g, '\\"');

  // Palette: high-contrast on both light and dark VS Code backgrounds.
  // Imports get a saturated gold treatment so they read clearly as the
  // Mathlib surface flowing into the file.
  const PAL = {
    root:    { stroke: "#4c9aff", fill: "#4c9aff",  text: "#ffffff" },
    project: { stroke: "#8e9aaf", fill: "none",     text: "#4a5568" },
    mathlib: { stroke: "#d4a017", fill: "none",     text: "#8a5a1c" },
    std:     { stroke: "#b48ead", fill: "none",     text: "#6b4a77" },
    unknown: { stroke: "#6c757d", fill: "none",     text: "#4a5568" },
    import:  { stroke: "#b8860b", fill: "#f4c430",  text: "#3a2900" },
  } as const;

  const style = (n: GraphNode): string => {
    const p = PAL[n.kind];
    const fill = p.fill === "none" ? "transparent" : p.fill;
    return [
      `shape=box`,
      `style="filled,rounded,setlinewidth(1.2)"`,
      `fillcolor="${fill}"`,
      `color="${p.stroke}"`,
      `fontcolor="${p.text}"`,
      // No fixed height/width — Graphviz auto-sizes HTML-labelled nodes,
      // but we add generous padding so text never touches the stroke.
      `fixedsize=false`,
      `margin="0.18,0.08"`,
    ].join(", ");
  };

  const lines: string[] = [
    `digraph G {`,
    `  rankdir=LR;`,
    `  bgcolor="transparent";`,
    `  splines=curved;`,
    `  overlap=false;`,
    `  ranksep=0.9;`,
    `  nodesep=0.4;`,
    `  pad=0.25;`,
    `  node [fontname="Latin Modern Mono", fontsize=10, penwidth=1.3];`,
    `  edge [color="#8e9aaf80", arrowsize=0.55, penwidth=0.9, arrowhead=vee];`,
  ];
  const imports = g.nodes.filter((n) => n.kind === "import");
  const others  = g.nodes.filter((n) => n.kind !== "import");
  for (const n of others) {
    lines.push(
      `  "${esc(n.id)}" [label=${htmlLabel(n.label)}, tooltip="${esc(n.id)}", ${style(n)}];`,
    );
  }
  if (imports.length) {
    lines.push(`  subgraph cluster_imports { rank=source; style=invis;`);
    for (const n of imports) {
      lines.push(
        `    "${esc(n.id)}" [label=${htmlLabel(n.label)}, tooltip="${esc(n.id)}", ${style(n)}];`,
      );
    }
    lines.push(`  }`);
  }
  for (const e of g.edges) {
    lines.push(`  "${esc(e.from)}" -> "${esc(e.to)}";`);
  }
  lines.push("}");
  return lines.join("\n");
}
