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
  kind: "root" | "project" | "mathlib" | "std" | "unknown" | "import" | "mathlibImport";
  file?: string;
  line?: number;
  status?: DeclStatus;
}

export interface EdgeUse { line: number; kind: "signature" | "proof"; }
export interface GraphEdge {
  from: string;
  to: string;
  count: number;
  uses?: EdgeUse[];
}

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

// Full Mathlib symbol index, keyed by (fully-qualified and short) name →
// module FQN where the symbol is declared. Built once per lakeRoot and cached
// for the session; first build is slow (a few seconds on a full Mathlib).
interface MathlibIndex {
  fqnToModule: Map<string, string>;
  shortToModule: Map<string, string>;
}
const mathlibIndexCache = new Map<string, MathlibIndex>();

export function getMathlibIndex(lakeRoot: string): MathlibIndex {
  const cached = mathlibIndexCache.get(lakeRoot);
  if (cached) return cached;
  const base = path.join(lakeRoot, ".lake", "packages", "mathlib", "Mathlib");
  const idx: MathlibIndex = { fqnToModule: new Map(), shortToModule: new Map() };
  if (!fs.existsSync(base)) { mathlibIndexCache.set(lakeRoot, idx); return idx; }
  const walk = (dir: string) => {
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!ent.isFile() || !p.endsWith(".lean")) continue;
      const rel = path.relative(path.join(lakeRoot, ".lake", "packages", "mathlib"), p);
      const moduleFqn = rel.slice(0, -".lean".length).split(path.sep).join(".");
      let src: string;
      try { src = fs.readFileSync(p, "utf8"); } catch { continue; }
      for (const d of scanLinesForDecls(src.split(/\r?\n/))) {
        if (!idx.fqnToModule.has(d.name)) idx.fqnToModule.set(d.name, moduleFqn);
        const last = d.name.split(".").pop();
        if (last && !idx.shortToModule.has(last)) idx.shortToModule.set(last, moduleFqn);
      }
    }
  };
  walk(base);
  mathlibIndexCache.set(lakeRoot, idx);
  return idx;
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

// Find the first `:=` at the outermost text level, returning its line index
// within the body (0-based). Anything before is treated as signature/type
// level; anything at or after is proof/value level. Best-effort: uses
// comment-stripping but no paren-balance heuristics.
export function proofStartLine(body: string): number | undefined {
  const lines = body.split(/\r?\n/);
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    // Block comments first.
    if (inBlock) {
      const end = line.indexOf("-/");
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlock = false;
    }
    // Strip block + line comments.
    const parts: string[] = [];
    let j = 0;
    while (j < line.length) {
      const start = line.indexOf("/-", j);
      const cmt = line.indexOf("--", j);
      if (cmt !== -1 && (start === -1 || cmt < start)) { parts.push(line.slice(j, cmt)); j = line.length; }
      else if (start !== -1) {
        parts.push(line.slice(j, start));
        const close = line.indexOf("-/", start + 2);
        if (close === -1) { inBlock = true; j = line.length; }
        else { j = close + 2; }
      } else {
        parts.push(line.slice(j));
        j = line.length;
      }
    }
    const cleaned = parts.join("");
    // Match `:=` with either a leading space (so we don't catch `name :=` inside
    // let-bindings) or at start of line.
    if (/(^|\s):=(\s|$)/.test(cleaned)) return i;
  }
  return undefined;
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
    out.add(n);
    // Lowercase head (e.g. `hf.exists_foo_bar`) is almost always a local
    // hypothesis being dot-applied. Emit the tail too so the ref can resolve.
    const parts = n.split(".");
    if (parts.length >= 2 && /^[a-z_]/.test(parts[0]!)) {
      out.add(parts.slice(1).join("."));
    }
  }
  return [...out];
}

// Qualified refs plus bare identifiers that resolve to short names in
// `shortNameToFqn`. Useful because after `open Foo` or inside `namespace Foo`,
// users call symbols without qualifying them.
const BARE_IDENT = /\b([A-Za-z_][\w']*)\b/g;
export function refsFromBodyWithShortResolution(
  body: string,
  shortNameToFqn: Map<string, string>,
): string[] {
  const out = new Set<string>(refsFromBody(body));
  for (const m of body.matchAll(BARE_IDENT)) {
    const n = m[1]!;
    if (LEAN_RESERVED.has(n)) continue;
    const fqn = shortNameToFqn.get(n);
    if (fqn) out.add(fqn);
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
  const edgeCount = new Map<string, { from: string; to: string; count: number; uses: EdgeUse[] }>();
  const addNode = (n: GraphNode) => { if (!nodes.has(n.id)) nodes.set(n.id, n); };
  const addEdge = (from: string, to: string, uses?: EdgeUse[]) => {
    if (from === to) return;
    const k = `${from}->${to}`;
    const e = edgeCount.get(k);
    if (e) {
      e.count++;
      if (uses) e.uses.push(...uses);
    } else {
      edgeCount.set(k, { from, to, count: 1, uses: uses ?? [] });
    }
  };

  const projectIdx = indexProjectDecls(lakeRoot, rootImport);
  const mathlib = getMathlibIndex(lakeRoot);
  // Short-name → FQN map. If a short name is ambiguous (multiple FQNs), the
  // last one wins; that's an acceptable compromise for a visualization.
  const shortToFqn = new Map<string, string>();
  for (const [name] of projectIdx) {
    const last = name.split(".").pop();
    if (last) shortToFqn.set(last, name);
  }
  // Extend the short-name index with decls harvested from Mathlib files that
  // the current file actually imports. This lets a bare ref like
  // `exists_forall_..._hasDerivAt` resolve to its Mathlib import so the gold
  // column wires correctly.
  const fqnToImport = new Map<string, string>();
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

  // Build a per-import "export set" so we can detect actual dependencies
  // decl-by-decl instead of wiring every import to every decl.
  //
  // For project-local imports we know every decl in the module's namespace
  // via projectIdx — that gives us both fully-qualified and short names.
  //
  // For Mathlib / Std / third-party imports we can't enumerate exports, so
  // we match any qualified reference that starts with the import name.
  // Bare/unqualified uses (after `open Foo`) go undetected, which is the
  // right trade-off: we'd rather drop a real edge than fabricate a spurious
  // one.
  type ImportMatcher = (refs: string[]) => boolean;
  const matchers = new Map<string, ImportMatcher>();
  for (const imp of fileImports) {
    const exported = new Set<string>();

    const isMathlib = imp === "Mathlib" || imp.startsWith("Mathlib.");
    const isStd     = imp.startsWith("Std.") || imp.startsWith("Batteries.");
    const isLean    = imp.startsWith("Lean.") || imp.startsWith("Init.");

    if (isMathlib || isStd || isLean) {
      // Try to find the actual source file of this import inside .lake/packages.
      const candidates: string[] = [];
      if (isMathlib) candidates.push(path.join(lakeRoot, ".lake", "packages", "mathlib", imp.replace(/\./g, "/") + ".lean"));
      if (isStd)     candidates.push(path.join(lakeRoot, ".lake", "packages", "batteries", imp.replace(/\./g, "/") + ".lean"));
      for (const p of candidates) {
        if (!fs.existsSync(p)) continue;
        try {
          const src = fs.readFileSync(p, "utf8").split(/\r?\n/);
          for (const d of scanLinesForDecls(src)) {
            exported.add(d.name);
            const last = d.name.split(".").pop();
            if (last) {
              exported.add(last);
              shortToFqn.set(last, d.name);
              fqnToImport.set(d.name, imp);
            }
            fqnToImport.set(d.name, imp);
          }
        } catch {}
      }
      matchers.set(imp, (refs) => refs.some((r) =>
        r === imp || r.startsWith(imp + ".") || exported.has(r) ||
        fqnToImport.get(r) === imp,
      ));
    } else {
      for (const [name] of projectIdx) {
        if (name === imp || name.startsWith(imp + ".")) {
          exported.add(name);
          const last = name.split(".").pop();
          if (last) exported.add(last);
        }
      }
      matchers.set(imp, (refs) => refs.some((r) => exported.has(r) || r.startsWith(imp + ".")));
    }
  }

  // We'll add import nodes lazily — only once we know at least one
  // reference node in the file actually came from them.
  const usedImports = new Set<string>();
  const importEdges: { from: string; to: string }[] = [];

  // Determine which import (if any) a given reference came from. Returns
  // the first matching import so each ref edge-connects to one upstream.
  // Falls back to the global Mathlib index for symbols that Meridian's
  // direct-import scan missed (e.g. transitively imported Mathlib files).
  const transitiveMathlibImports = new Set<string>();
  const importForRef = (ref: string): string | undefined => {
    for (const imp of fileImports) {
      const fn = matchers.get(imp)!;
      if (fn([ref])) return imp;
    }
    // Lookup in global Mathlib index. The ref may be fully-qualified
    // (e.g. Real.sqrt_le_sqrt) or bare (e.g. sqrt_le_sqrt).
    const sourceModule = mathlib.fqnToModule.get(ref) ?? mathlib.shortToModule.get(ref);
    if (!sourceModule) return undefined;
    // Prefer a direct import whose module is an ancestor of the source.
    for (const imp of fileImports) {
      if (imp === sourceModule || sourceModule.startsWith(imp + ".")) return imp;
    }
    // Otherwise surface the actual source file as a transitive gold node.
    transitiveMathlibImports.add(sourceModule);
    return sourceModule;
  };

  for (let i = 0; i < rootDecls.length; i++) {
    const d = rootDecls[i]!;
    const end = i + 1 < rootDecls.length ? rootDecls[i + 1]!.line - 1 : lines.length;
    const body = lines.slice(d.line - 1, end).join("\n");
    const status = classifyBody(body);
    addNode({ id: d.name, label: d.name, kind: "root", file: leanFile, line: d.line, status });

    const level1 = refsFromBodyWithShortResolution(body, shortToFqn).filter((r) => r !== d.name);

    // Per-ref usage locations: find each occurrence of the ref (or its
    // short-name synonym, when the file calls it unqualified) on each line,
    // and tag it signature vs proof based on first `:=` split.
    const bodyLines = body.split(/\r?\n/);
    const split = proofStartLine(body);
    const useLocationsFor = (ref: string): EdgeUse[] => {
      const tokens = new Set<string>();
      tokens.add(ref);
      const short = ref.split(".").pop();
      if (short) tokens.add(short);
      const patterns = [...tokens].map((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b`));
      const out: EdgeUse[] = [];
      for (let j = 0; j < bodyLines.length; j++) {
        const ln = bodyLines[j]!;
        if (patterns.some((re) => re.test(ln))) {
          out.push({
            line: d.line + j,
            kind: split === undefined || j < split ? "signature" : "proof",
          });
        }
      }
      return out;
    };

    // For each ref, connect the import that provided it (if any) upstream
    // of the ref node itself. This produces the layering
    //   imports  →  refs  →  decls
    // the user expects.
    for (const r of level1) {
      const imp = importForRef(r);
      if (imp !== undefined) {
        usedImports.add(imp);
        importEdges.push({ from: `import:${imp}`, to: r });
      }
    }
    for (const r of level1) {
      const kind = classifyRef(r, rootImport);
      const l1Info = projectIdx.get(r);
      addNode({ id: r, label: r, kind, file: l1Info?.file, line: l1Info?.line });
      // Upstream flow: the ref feeds into the decl. Record usage locations.
      addEdge(r, d.name, useLocationsFor(r));

      // Attach status to the level-1 node if it's a project decl we indexed.
      if (kind === "project" && l1Info) {
        nodes.get(r)!.status = l1Info.status;
      }

      // Expand level 2 only for project refs. Level-2 refs feed into the
      // level-1 ref, so the arrow goes upstream (leftward) too.
      if (kind === "project" && l1Info) {
        const level2 = refsFromBodyWithShortResolution(l1Info.body, shortToFqn).filter((r2) => r2 !== r);
        for (const r2 of level2) {
          const k2 = classifyRef(r2, rootImport);
          const l2Info = projectIdx.get(r2);
          addNode({ id: r2, label: r2, kind: k2, file: l2Info?.file, line: l2Info?.line, status: l2Info?.status });
          addEdge(r2, r);
        }
      }
    }
  }

  // Resolve a package-backed import to its source .lean on disk so click
  // opens the actual Mathlib / Batteries file (a "LibView" jump).
  const importSourceFile = (imp: string): string | undefined => {
    const rel = imp.replace(/\./g, "/") + ".lean";
    const isMathlib = imp === "Mathlib" || imp.startsWith("Mathlib.");
    const isStd     = imp.startsWith("Std.") || imp.startsWith("Batteries.");
    const candidates: string[] = [];
    if (isMathlib) candidates.push(path.join(lakeRoot, ".lake", "packages", "mathlib", rel));
    if (isStd)     candidates.push(path.join(lakeRoot, ".lake", "packages", "batteries", rel));
    for (const p of candidates) if (fs.existsSync(p)) return p;
    return undefined;
  };

  // Direct imports: Mathlib imports always show, project imports only when used.
  for (const imp of fileImports) {
    const isMathlib = imp === "Mathlib" || imp.startsWith("Mathlib.");
    if (isMathlib) {
      addNode({ id: `import:${imp}`, label: imp, kind: "mathlibImport", file: importSourceFile(imp) });
    } else if (usedImports.has(imp)) {
      const status = aggregateModuleStatus(imp, projectIdx);
      // Project import: its source file is the matching .lean inside the project.
      const projFile = path.join(lakeRoot, imp.replace(/\./g, "/") + ".lean");
      addNode({ id: `import:${imp}`, label: imp, kind: "project", status, file: fs.existsSync(projFile) ? projFile : undefined });
    }
  }
  // Transitive Mathlib modules: the symbol was declared in a Mathlib file this
  // file doesn't directly import. Show as a gold node, wired up, opens the file.
  for (const m of transitiveMathlibImports) {
    addNode({ id: `import:${m}`, label: m, kind: "import", file: importSourceFile(m) });
  }
  for (const e of importEdges) {
    addEdge(e.from, e.to);
  }

  return {
    nodes: [...nodes.values()],
    edges: [...edgeCount.values()].map((e) => ({ from: e.from, to: e.to, count: e.count, uses: e.uses })),
    rootFile: leanFile,
  };
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
    mathlib: { stroke: "#7c3aed", fill: "#ede9fe",  text: "#4c1d95" },
    std:     { stroke: "#4a5568", fill: "#e5e7eb",  text: "#1f2937" },
    unknown: { stroke: "#6c757d", fill: "#ffffff",  text: "#2d3748" },
    import:        { stroke: "#b8860b", fill: "#f4c430",  text: "#3a2900" },
    mathlibImport: { stroke: "#b8860b", fill: "#ede9fe",  text: "#4c1d95" },
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
  const imports = g.nodes.filter((n) => n.kind === "import" || n.kind === "mathlibImport");
  const roots   = g.nodes.filter((n) => n.kind === "root");
  const middle  = g.nodes.filter((n) => n.kind !== "import" && n.kind !== "mathlibImport" && n.kind !== "root");
  const nodeIdFor = (i: number) => `n${i}`;
  const nodeIndex = new Map<string, number>();
  g.nodes.forEach((n, i) => nodeIndex.set(n.id, i));

  const emit = (n: GraphNode) => {
    const idx = nodeIndex.get(n.id)!;
    return `"${esc(n.id)}" [id="${nodeIdFor(idx)}", label="${plainLabel(n.label)}", tooltip="${esc(n.id)}", ${style(n)}];`;
  };

  // Middle layer: refs (project / mathlib / std / unknown).
  for (const n of middle) lines.push(`  ${emit(n)}`);

  // Left-most: import nodes pinned to rank=source.
  if (imports.length) {
    lines.push(`  { rank=source;`);
    for (const n of imports) lines.push(`    ${emit(n)}`);
    lines.push(`  }`);
  }
  // Right-most: file decls pinned to rank=sink so they never share a column
  // with refs or imports, even when they have no incoming edges.
  if (roots.length) {
    lines.push(`  { rank=sink;`);
    for (const n of roots) lines.push(`    ${emit(n)}`);
    lines.push(`  }`);
  }
  for (let i = 0; i < g.edges.length; i++) {
    const e = g.edges[i]!;
    const thickness = Math.min(3.5, 0.9 + Math.log2(e.count + 1) * 0.7);
    const attrs = [`id="e${i}"`, `penwidth=${thickness.toFixed(2)}`];
    if (e.count > 1) attrs.push(`tooltip="${e.count}×"`);
    lines.push(`  "${esc(e.from)}" -> "${esc(e.to)}" [${attrs.join(", ")}];`);
  }
  lines.push("}");
  return lines.join("\n");
}

// Parallel mappings so the webview can wire up focus / click handlers
// without parsing fragile SVG title text.
export function edgeIdMap(g: DepGraph): Record<string, { from: string; to: string; count: number; uses: EdgeUse[] }> {
  const m: Record<string, { from: string; to: string; count: number; uses: EdgeUse[] }> = {};
  for (let i = 0; i < g.edges.length; i++) {
    const e = g.edges[i]!;
    m[`e${i}`] = { from: e.from, to: e.to, count: e.count, uses: e.uses ?? [] };
  }
  return m;
}
export function nodeIdMap(g: DepGraph): Record<string, string> {
  const m: Record<string, string> = {};
  g.nodes.forEach((n, i) => { m[n.id] = `n${i}`; });
  return m;
}
