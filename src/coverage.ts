import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { buildReportSource, pathToModule, runScratch } from "./runner";
import { stripLeanNoise } from "./parser";

export interface CoverageBlock {
  decl: string;
  category?: string;
  exactMatches: string[];
  nearMisses: string[];
  raw: string;
}

// Walk lakeRoot for .lean files under <rootImport>/, return their module names + file paths.
export function listProjectModules(lakeRoot: string, rootImport: string): { module: string; file: string }[] {
  const root = path.join(lakeRoot, rootImport);
  if (!fs.existsSync(root)) return [];
  const out: { module: string; file: string }[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && ent.name.endsWith(".lean")) {
        const mod = pathToModule(lakeRoot, p);
        if (mod) out.push({ module: mod, file: p });
      }
    }
  };
  walk(root);
  // Also include the root file itself if present (e.g. Meridian.lean).
  const rootFile = path.join(lakeRoot, `${rootImport}.lean`);
  if (fs.existsSync(rootFile)) {
    const mod = pathToModule(lakeRoot, rootFile);
    if (mod) out.push({ module: mod, file: rootFile });
  }
  return out;
}

// Build a scratch buffer that imports every project module and asks Meridian
// for its full sorry inventory. We parse the result to extract qualified names.
export async function listProjectSorries(
  lakeRoot: string,
  rootImport: string,
  token?: vscode.CancellationToken,
): Promise<string[]> {
  const modules = listProjectModules(lakeRoot, rootImport);
  const src = buildReportSource(rootImport, "#sorry_inventory_all", undefined, modules.map((m) => m.module));
  const res = await runScratch(lakeRoot, src, { token, timeoutMs: 1_800_000 });
  const text = stripLeanNoise(res.stderr + "\n" + res.stdout);
  const names = new Set<string>();
  // The inventory format is loose; pull anything that looks like a fully-qualified Lean ident.
  for (const m of text.matchAll(/(?:^|\s|·|\[|->)([A-Z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_']*)+)/g)) {
    const n = m[1]!;
    if (!n.startsWith("Mathlib.") && !n.startsWith("Std.") && !n.startsWith("Lean.")) {
      names.add(n);
    }
  }
  return [...names].sort();
}

// Run #mathlib_coverage for every name in `decls`, batched into one scratch
// (so the Mathlib DiscrTree is built once and reused).
export async function runProjectCoverage(
  lakeRoot: string,
  rootImport: string,
  decls: string[],
  token?: vscode.CancellationToken,
): Promise<CoverageBlock[]> {
  if (decls.length === 0) return [];
  const modules = listProjectModules(lakeRoot, rootImport).map((m) => m.module);
  const lines = decls.map((d) => `#mathlib_coverage ${d}`).join("\n");
  const src = buildReportSource(rootImport, lines, undefined, modules);
  const res = await runScratch(lakeRoot, src, { token, timeoutMs: 1_800_000 });
  return parseCoverageBatch(res.stderr + "\n" + res.stdout);
}

// Parse a batch run's output. Each `Coverage for <name>:` block becomes a CoverageBlock.
export function parseCoverageBatch(text: string): CoverageBlock[] {
  const cleaned = stripLeanNoise(text);
  const blocks: CoverageBlock[] = [];
  const re = /Coverage for ([\w.']+):\s*Category\s+(\w+)/g;
  const starts: { decl: string; category: string; index: number }[] = [];
  for (const m of cleaned.matchAll(re)) {
    starts.push({ decl: m[1]!, category: m[2]!, index: m.index! });
  }
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i]!;
    const end = i + 1 < starts.length ? starts[i + 1]!.index : cleaned.length;
    const body = cleaned.slice(s.index, end);
    const exact: string[] = [];
    for (const m of body.matchAll(/Exact matches \(\d+\):\n((?:\s*-\s*[^\n]+\n?)+)/g)) {
      for (const l of m[1]!.split("\n")) {
        const t = l.replace(/^\s*-\s*/, "").trim();
        if (t) exact.push(t);
      }
    }
    const near: string[] = [];
    for (const m of body.matchAll(/\[(\w+)\]\s+([\w.']+)\s+\((\d+)\s+mismatches?\)/g)) {
      near.push(`[${m[1]}] ${m[2]} (${m[3]} mismatches)`);
    }
    blocks.push({
      decl: s.decl,
      category: s.category,
      exactMatches: exact,
      nearMisses: near,
      raw: body,
    });
  }
  return blocks;
}
