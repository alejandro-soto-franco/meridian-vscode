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
  kind: "root" | "project" | "mathlib" | "std" | "unknown";
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

  for (let i = 0; i < rootDecls.length; i++) {
    const d = rootDecls[i]!;
    const end = i + 1 < rootDecls.length ? rootDecls[i + 1]!.line - 1 : lines.length;
    const body = lines.slice(d.line - 1, end).join("\n");
    addNode({ id: d.name, label: d.name, kind: "root", file: leanFile, line: d.line });

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

export function graphToDot(g: DepGraph): string {
  const esc = (s: string) => s.replace(/"/g, '\\"');
  const style = (n: GraphNode): string => {
    switch (n.kind) {
      case "root":    return `shape=box, style="filled,bold", fillcolor="#3c6e71", fontcolor="white"`;
      case "project": return `shape=ellipse, style=filled, fillcolor="#d9d9d9"`;
      case "mathlib": return `shape=ellipse, style="filled,dashed", fillcolor="#f6c177", fontcolor="#3b2e1e"`;
      case "std":     return `shape=ellipse, style="filled,dashed", fillcolor="#c4a7e7"`;
      default:        return `shape=ellipse, style=dashed`;
    }
  };
  const lines: string[] = [`digraph G {`,
    `  rankdir=LR;`,
    `  bgcolor="transparent";`,
    `  node [fontname="Helvetica", fontsize=10];`,
    `  edge [color="#888888", arrowsize=0.6];`,
  ];
  for (const n of g.nodes) {
    lines.push(`  "${esc(n.id)}" [label="${esc(n.label)}", ${style(n)}];`);
  }
  for (const e of g.edges) {
    lines.push(`  "${esc(e.from)}" -> "${esc(e.to)}";`);
  }
  lines.push("}");
  return lines.join("\n");
}
