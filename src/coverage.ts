import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { buildReportSource, pathToModule, runScratch } from "./runner";
import { stripLeanNoise } from "./parser";
import { scanLinesForSorriesWithDecl } from "./scanner";

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

// Walk the filesystem to find every sorry and the fully-qualified declaration
// it lives in. Far more reliable than asking Meridian from a scratch buffer
// (which hangs on large projects).
export function listProjectSorries(
  lakeRoot: string,
  rootImport: string,
): string[] {
  const ignore = vscode.workspace
    .getConfiguration("meridian")
    .get<string[]>("coverageIgnorePrefixes", []);
  const isIgnored = (n: string) =>
    ignore.some((p) => n === p || n.startsWith(p + "."));
  const modules = listProjectModules(lakeRoot, rootImport);
  const names = new Set<string>();
  for (const { file } of modules) {
    let src: string;
    try { src = fs.readFileSync(file, "utf8"); } catch { continue; }
    const lines = src.split(/\r?\n/);
    for (const hit of scanLinesForSorriesWithDecl(lines)) {
      if (hit.decl && !isIgnored(hit.decl)) names.add(hit.decl);
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

// Map Meridian's internal A/B/C categorisation to user-facing labels.
export function friendlyCategory(cat: string): string {
  switch (cat.trim().toUpperCase()) {
    case "A": return "Available";
    case "B": return "Partially Available";
    case "C": return "Not Available";
    default:  return cat;
  }
}

// Rewrite raw Meridian output so "Category A/B/C" becomes the friendly label.
export function friendlyRaw(text: string): string {
  return text.replace(/Category\s+([ABC])\b/g, (_m, c) => friendlyCategory(c));
}

// Parse a batch run's output. Each `Coverage for <name>:` block becomes a CoverageBlock.
export function parseCoverageBatch(text: string): CoverageBlock[] {
  const cleaned = stripLeanNoise(text);
  const blocks: CoverageBlock[] = [];
  const re = /Coverage for ([\w.']+):\s*Category\s+(\w+)/g;
  const starts: { decl: string; category: string; index: number }[] = [];
  for (const m of cleaned.matchAll(re)) {
    starts.push({ decl: m[1]!, category: friendlyCategory(m[2]!), index: m.index! });
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
      raw: friendlyRaw(body),
    });
  }
  return blocks;
}
