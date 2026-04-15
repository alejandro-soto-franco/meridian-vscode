import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// Locate the Lake project root by walking upward from `start` looking for lakefile.toml / lakefile.lean.
export function findLakeRoot(start: string): string | undefined {
  let dir = start;
  while (true) {
    if (fs.existsSync(path.join(dir, "lakefile.toml")) ||
        fs.existsSync(path.join(dir, "lakefile.lean"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// True if the Lake project lists Meridian as a dependency (either in the
// manifest or top-level lakefile). Needed because our scratch buffers `import
// Meridian` to use its # commands; projects that don't require Meridian will
// error with "unknown module prefix 'Meridian'".
export function projectHasMeridian(lakeRoot: string): boolean {
  const manifest = path.join(lakeRoot, "lake-manifest.json");
  if (fs.existsSync(manifest)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
      const pkgs = (m?.packages ?? []) as Array<{ name?: string }>;
      if (pkgs.some((p) => (p?.name ?? "").toLowerCase() === "meridian")) return true;
    } catch {}
  }
  const toml = path.join(lakeRoot, "lakefile.toml");
  if (fs.existsSync(toml)) {
    try {
      if (/\bmeridian\b/i.test(fs.readFileSync(toml, "utf8"))) return true;
    } catch {}
  }
  const lean = path.join(lakeRoot, "lakefile.lean");
  if (fs.existsSync(lean)) {
    try {
      if (/\bMeridian\b/.test(fs.readFileSync(lean, "utf8"))) return true;
    } catch {}
  }
  // Also: we're *inside* the Meridian repo itself.
  return path.basename(lakeRoot).toLowerCase() === "meridian";
}

// Guess the default import root for a Lake project: the top-level module matching the dir name.
export function guessRootImport(lakeRoot: string): string {
  const base = path.basename(lakeRoot);
  // Prefer a `<Base>.lean` file at the root.
  if (fs.existsSync(path.join(lakeRoot, `${base}.lean`))) return base;
  // Fallback: any first .lean at root.
  const leans = fs.readdirSync(lakeRoot).filter((f) => f.endsWith(".lean"));
  if (leans.length) return leans[0]!.replace(/\.lean$/, "");
  return base;
}

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

// Run a Lean scratch buffer against a Lake project and capture output.
export async function runScratch(
  lakeRoot: string,
  leanSource: string,
  opts: { timeoutMs?: number; token?: vscode.CancellationToken } = {},
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const lake = vscode.workspace.getConfiguration("meridian").get<string>("lakeExecutable", "lake");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-"));
  const tmpFile = path.join(tmpDir, "Scratch.lean");
  fs.writeFileSync(tmpFile, leanSource);

  return new Promise((resolve) => {
    const child = cp.spawn(lake, ["env", "lean", tmpFile], {
      cwd: lakeRoot,
      env: process.env,
    });
    let stdout = "", stderr = "";
    const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    const cancelSub = opts.token?.onCancellationRequested(() => {
      try { child.kill("SIGKILL"); } catch {}
    });
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", (e) => {
      clearTimeout(timer); cancelSub?.dispose(); cleanup();
      resolve({ ok: false, stdout, stderr: stderr + "\n" + String(e), code: null });
    });
    child.on("close", (code) => {
      clearTimeout(timer); cancelSub?.dispose(); cleanup();
      resolve({ ok: code === 0, stdout, stderr, code });
    });
  });
}

export function buildReportSource(
  rootImport: string,
  command: string,
  arg?: string,
  extra?: string[],
  opts: { meridian?: boolean } = {},
): string {
  const line = arg ? `${command} ${arg}` : command;
  const seen = new Set<string>();
  const base: string[] = [];
  if (opts.meridian !== false) base.push("Meridian");
  base.push(rootImport);
  const imports = [...base, ...(extra ?? [])]
    .filter((m) => m && !seen.has(m) && (seen.add(m), true))
    .map((m) => `import ${m}`)
    .join("\n");
  return `${imports}

${line}
`;
}

// Convert an absolute .lean path inside `lakeRoot` into its module name.
// e.g. /…/Meridian/Meridian/Domain/GMT/FirstVariation.lean → "Meridian.Domain.GMT.FirstVariation"
export function pathToModule(lakeRoot: string, leanFile: string): string | undefined {
  const rel = path.relative(lakeRoot, leanFile);
  if (rel.startsWith("..") || !rel.endsWith(".lean")) return undefined;
  return rel.slice(0, -".lean".length).split(path.sep).join(".");
}
