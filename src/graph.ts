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

// "complete" = decl has no sorry anywhere.
// "partial"  = decl body has some work AND at least one sorry.
// "stub"     = decl body is effectively just `sorry` (or `by sorry`).
export type DeclStatus = "complete" | "partial" | "stub";

export interface GraphNode {
  id: string;
  label: string;
  kind: "root" | "project" | "mathlib" | "std" | "unknown" | "import";
  file?: string;
  line?: number;
  status?: DeclStatus;
}

export interface GraphEdge { from: string; to: string; }

export interface DepGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  rootFile: string;
}

export interface DeclIndexEntry {
  file: string;
  line: number;
  body: string;
  status: DeclStatus;
}

// Classify a decl body as complete / partial / stub.
// stub = the proof position is literally `sorry` (possibly behind `by`) with
// no other tactics. partial = has a sorry but also other non-trivial content.
// complete = no sorry found at all.
export function classifyBody(body: string): DeclStatus {
  // Strip -- line comments and /- ... -/ block comments.
  let cleaned = body.replace(/\/-[\s\S]*?-\//g, " ");
  cleaned = cleaned.split(/\r?\n/).map((l) => {
    const i = l.indexOf("--");
    return i === -1 ? l : l.slice(0, i);
  }).join("\n");

  const hasSorry = /\bsorry\b/.test(cleaned);
  if (!hasSorry) return "complete";

  // Extract the proof/value part: everything after the first ` := ` or ` by `.
  const afterAssign = cleaned.match(/:=([\s\S]*)$/);
  const afterBy     = cleaned.match(/\bby\b([\s\S]*)$/);
  const tail = (afterAssign?.[1] ?? afterBy?.[1] ?? cleaned).trim();

  // Strip a leading `by` if present.
  const proof = tail.replace(/^by\b\s*/, "").trim();

  // Count tactics / terms by splitting on common separators.
  const tokens = proof
    .split(/[\s\n;·•]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t !== "by");

  // Stub if the only non-trivial token is `sorry` (possibly with punctuation).
  const nonSorry = tokens.filter((t) => t !== "sorry" && t !== "sorry;");
  if (nonSorry.length === 0) return "stub";
  return "partial";
}

// Collect project-wide decl index with status classification.
export function indexProjectDecls(lakeRoot: string, rootImport: string): Map<string, DeclIndexEntry> {
  const idx = new Map<string, DeclIndexEntry>();
  for (const { file } of listProjectModules(lakeRoot, rootImport)) {
    let src: string;
    try { src = fs.readFileSync(file, "utf8"); } catch { continue; }
    const lines = src.split(/\r?\n/);
    const decls = scanLinesForDecls(lines);
    for (let i = 0; i < decls.length; i++) {
      const d = decls[i]!;
      const endLine = i + 1 < decls.length ? decls[i + 1]!.line - 1 : lines.length;
      const body = lines.slice(d.line - 1, endLine).join("\n");
      idx.set(d.name, { file, line: d.line, body, status: classifyBody(body) });
    }
  }
  return idx;
}

// Aggregate decl-level statuses to a module-level status.
// all complete → complete; all stub → stub; mixed or any partial → partial.
export function aggregateModuleStatus(
  module: string,
  idx: Map<string, DeclIndexEntry>,
): DeclStatus | undefined {
  let sawComplete = false, sawPartial = false, sawStub = false, any = false;
  for (const [name, entry] of idx) {
    // Match decls whose qualified name lives in this module's namespace.
    if (name === module || name.startsWith(module + ".")) {
      any = true;
      if (entry.status === "complete") sawComplete = true;
      else if (entry.status === "partial") sawPartial = true;
      else if (entry.status === "stub") sawStub = true;
    }
  }
  if (!any) return undefined;
  if (sawPartial) return "partial";
  if (sawStub && sawComplete) return "partial";
  if (sawStub) return "stub";
  return "complete";
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
  // Mathlib imports keep the gold `import` kind. Project-local imports flow
  // in as `project` kind with an aggregated module status so they get
  // coloured complete / partial / stub just like decl nodes would be.
  for (const imp of fileImports) {
    if (imp === "Mathlib" || imp.startsWith("Mathlib.")) {
      addNode({ id: `import:${imp}`, label: imp, kind: "import" });
    } else {
      const status = aggregateModuleStatus(imp, projectIdx);
      addNode({ id: `import:${imp}`, label: imp, kind: "project", status });
    }
  }

  for (let i = 0; i < rootDecls.length; i++) {
    const d = rootDecls[i]!;
    const end = i + 1 < rootDecls.length ? rootDecls[i + 1]!.line - 1 : lines.length;
    const body = lines.slice(d.line - 1, end).join("\n");
    const status = classifyBody(body);
    addNode({ id: d.name, label: d.name, kind: "root", file: leanFile, line: d.line, status });
    for (const imp of fileImports) addEdge(`import:${imp}`, d.name);

    const level1 = refsFromBody(body).filter((r) => r !== d.name);
    for (const r of level1) {
      const kind = classifyRef(r, rootImport);
      const l1Info = projectIdx.get(r);
      addNode({ id: r, label: r, kind, file: l1Info?.file, line: l1Info?.line });
      addEdge(d.name, r);

      // Attach status to the level-1 node if it's a project decl we indexed.
      if (kind === "project" && l1Info) {
        nodes.get(r)!.status = l1Info.status;
      }

      // Expand level 2 only for project refs.
      if (kind === "project" && l1Info) {
        const level2 = refsFromBody(l1Info.body).filter((r2) => r2 !== r);
        for (const r2 of level2) {
          const k2 = classifyRef(r2, rootImport);
          const l2Info = projectIdx.get(r2);
          addNode({ id: r2, label: r2, kind: k2, file: l2Info?.file, line: l2Info?.line, status: l2Info?.status });
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
// Compact label: last two segments of a qualified name. Plain (non-HTML)
// label so Graphviz can size the node using its built-in Courier metrics,
// which closely match Latin Modern Mono. The browser overrides the actual
// SVG text font-family via CSS (see gapsView.ts).
function plainLabel(name: string): string {
  const parts = name.split(".");
  const short = parts.length <= 2 ? name : parts.slice(-2).join(".");
  return short.replace(/"/g, '\\"');
}

export function graphToDot(g: DepGraph): string {
  const esc = (s: string) => s.replace(/"/g, '\\"');

  // Status palette: drives project + root decl colors, and also non-Mathlib
  // imports (whose status is aggregated from their module's decls).
  const STATUS = {
    complete: { stroke: "#15803d", fill: "#86efac", text: "#14532d" },
    partial:  { stroke: "#b45309", fill: "#fcd34d", text: "#78350f" },
    stub:     { stroke: "#b91c1c", fill: "#7f1d1d", text: "#ffffff" },
  } as const;

  // Kind-keyed defaults for everything else. All fills are near-white so
  // the labels stay readable on a dark theme.
  const PAL = {
    root:    { stroke: "#4c9aff", fill: "#4c9aff",  text: "#ffffff" },
    project: { stroke: "#8e9aaf", fill: "#ffffff",  text: "#2e3440" },
    mathlib: { stroke: "#4a5568", fill: "#cbd5e0",  text: "#000000" },
    std:     { stroke: "#b48ead", fill: "#ffffff",  text: "#6b4a77" },
    unknown: { stroke: "#6c757d", fill: "#ffffff",  text: "#2d3748" },
    import:  { stroke: "#b8860b", fill: "#f4c430",  text: "#3a2900" },
  } as const;

  const style = (n: GraphNode): string => {
    const base = PAL[n.kind];
    // Status coloring wins for project/root decls AND for project-kind
    // imports with an aggregated module status.
    const p = (n.kind === "project" || n.kind === "root") && n.status
      ? STATUS[n.status]
      : base;
    const fill = p.fill;
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
    // splines=true routes smooth cubic Bézier edges that avoid node
    // bounding boxes — straight when possible, arcing only around
    // obstacles. 'curved' always arcs and clips through other nodes.
    `  splines=true;`,
    `  overlap=false;`,
    `  ranksep=0.9;`,
    `  nodesep=0.4;`,
    `  pad=0.25;`,
    // Graphviz sizes nodes using this font's metrics. Courier is built-in
    // and close enough in glyph width to Latin Modern Mono that the boxes
    // end up a bit wider than strictly needed, which is what we want.
    `  node [fontname="Courier", fontsize=10, penwidth=1.3];`,
    `  edge [color="#8e9aaf80", arrowsize=0.55, penwidth=0.9, arrowhead=vee, tailport=e, headport=w];`,
  ];
  const imports = g.nodes.filter((n) => n.kind === "import");
  const others  = g.nodes.filter((n) => n.kind !== "import");
  const nodeIdFor = (i: number) => `n${i}`;
  const nodeIndex = new Map<string, number>();
  g.nodes.forEach((n, i) => nodeIndex.set(n.id, i));

  const emit = (n: GraphNode) => {
    const idx = nodeIndex.get(n.id)!;
    return `"${esc(n.id)}" [id="${nodeIdFor(idx)}", label="${plainLabel(n.label)}", tooltip="${esc(n.id)}", ${style(n)}];`;
  };

  for (const n of others) {
    lines.push(`  ${emit(n)}`);
  }
  if (imports.length) {
    lines.push(`  subgraph cluster_imports { rank=source; style=invis;`);
    for (const n of imports) lines.push(`    ${emit(n)}`);
    lines.push(`  }`);
  }
  for (let i = 0; i < g.edges.length; i++) {
    const e = g.edges[i]!;
    // Explicit id so the SVG carries a stable, parseable identifier per edge.
    lines.push(`  "${esc(e.from)}" -> "${esc(e.to)}" [id="e${i}"];`);
  }
  lines.push("}");
  return lines.join("\n");
}

// Parallel mappings so the webview can wire up focus / click handlers
// without parsing fragile SVG title text.
export function edgeIdMap(g: DepGraph): Record<string, { from: string; to: string }> {
  const m: Record<string, { from: string; to: string }> = {};
  for (let i = 0; i < g.edges.length; i++) {
    const e = g.edges[i]!;
    m[`e${i}`] = { from: e.from, to: e.to };
  }
  return m;
}
export function nodeIdMap(g: DepGraph): Record<string, string> {
  const m: Record<string, string> = {};
  g.nodes.forEach((n, i) => { m[n.id] = `n${i}`; });
  return m;
}
