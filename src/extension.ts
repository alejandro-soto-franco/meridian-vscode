import * as vscode from "vscode";
import * as path from "path";
import { CATALOG, find } from "./catalog";
import { buildReportSource, findLakeRoot, guessRootImport, pathToModule, projectHasMeridian, runScratch } from "./runner";
import {
  renderDepGraph, renderSorryInventory, renderGapReport, renderRaw, show,
} from "./webview";
import {
  DashboardState, SorriesProvider, CoverageProvider, CommandsProvider,
  ingestSorryInventory, ingestGapReport, ingestCoverage, ingestCoverageBlocks,
} from "./tree";
import { GapsPanel } from "./gapsView";
import { scanFileForSorries, scanFileForDecls } from "./scanner";
import { listProjectSorries, runProjectCoverage, friendlyRaw } from "./coverage";

const dash = new DashboardState();
let output: vscode.OutputChannel;
// File mirror of the Meridian output channel. Same content as the channel
// but persisted at a stable path so external agents (and the user's grep)
// can read it without needing VS Code open.
const LOG_FILE = require("path").join(require("os").homedir(), ".meridian-vscode.log");

function log(line: string) {
  output.appendLine(line);
  try { require("fs").appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("Meridian");
  context.subscriptions.push(output);
  // Mirror every appendLine to the log file so `output.appendLine(...)` calls
  // scattered elsewhere in the extension also land in the mirror.
  const origAppend = output.appendLine.bind(output);
  (output as any).appendLine = (s: string) => {
    origAppend(s);
    try { require("fs").appendFileSync(LOG_FILE, s + "\n"); } catch {}
  };
  try { require("fs").writeFileSync(LOG_FILE, ""); } catch {}
  log(`Meridian extension activated at ${new Date().toISOString()}`);
  log(`log file mirror: ${LOG_FILE}`);
  const { lakeRoot, rootImport } = resolveProject();
  if (lakeRoot) {
    log(`lake root: ${lakeRoot}`);
    log(`root import: ${rootImport}`);
    log(`Meridian dependency detected: ${projectHasMeridian(lakeRoot)}`);
  } else {
    log(`no Lake project detected from current workspace`);
  }
  // Sidebar views.
  const sorries = new SorriesProvider(dash);
  const coverage = new CoverageProvider(dash);
  const commandsView = new CommandsProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("meridian.sorries", sorries),
    vscode.window.registerTreeDataProvider("meridian.coverage", coverage),
    vscode.window.registerTreeDataProvider("meridian.commands", commandsView),
  );

  // Register every catalog command.
  for (const entry of CATALOG) {
    context.subscriptions.push(
      vscode.commands.registerCommand(entry.id, () => runCatalogCommand(context, entry.id)),
    );
  }

  // Meta commands.
  context.subscriptions.push(
    vscode.commands.registerCommand("meridian.openDashboard", () => {
      vscode.commands.executeCommand("workbench.view.extension.meridian");
    }),
    vscode.commands.registerCommand("meridian.refreshDashboard", () => refreshDashboard(context)),
    vscode.commands.registerCommand("meridian.showResults", () => {
      show(context, "Results", renderRaw("Results", "(no command run yet)"));
    }),
    vscode.commands.registerCommand("meridian.showOutput", () => output.show(true)),
    vscode.commands.registerCommand("meridian.coverageProject", () => runProjectCoverageCmd()),
    vscode.commands.registerCommand("meridian.showGaps", () => GapsPanel.show(context, resolveProject)),
    vscode.commands.registerCommand("meridian.togglePalette", async () => {
      const cfg = vscode.workspace.getConfiguration("meridian");
      const current = cfg.get<string>("colorPalette", "default");
      const next = current === "cvd-safe" ? "default" : "cvd-safe";
      await cfg.update("colorPalette", next, vscode.ConfigurationTarget.Global);
      GapsPanel.current()?.refresh();
    }),
  );

  // Sidebar Sorries view: refresh on active editor change AND on save (current file only).
  const refreshSorriesForActive = () => {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.languageId !== "lean4") {
      dash.update({ sorries: [] });
    } else {
      dash.update({ sorries: scanFileForSorries(doc) });
    }
    GapsPanel.current()?.refresh();
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(refreshSorriesForActive),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId !== "lean4") return;
      if (doc === vscode.window.activeTextEditor?.document) refreshSorriesForActive();
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === vscode.window.activeTextEditor?.document &&
          e.document.languageId === "lean4") {
        refreshSorriesForActive();
      }
    }),
  );
  refreshSorriesForActive();

  const cfg = vscode.workspace.getConfiguration("meridian");
  if (cfg.get<boolean>("depGraphOnStartup", true)) {
    GapsPanel.show(context, resolveProject);
  }
  if (cfg.get<boolean>("coverageOnStartup", false)) {
    runProjectCoverageCmd().catch((e) => output.appendLine(`startup coverage failed: ${e}`));
  }
}

export function deactivate() {}

async function runCatalogCommand(context: vscode.ExtensionContext, id: string) {
  const entry = find(id);
  if (!entry) return;
  const ins = entry.insertion;
  if (ins.kind === "snippet") {
    await insertAtCursor(ins.text);
    return;
  }
  if (ins.kind === "prompt-snippet") {
    const arg = await vscode.window.showInputBox({ prompt: entry.title, placeHolder: ins.prompt });
    if (!arg) return;
    await insertAtCursor(ins.build(arg.trim()));
    return;
  }
  if (ins.kind === "report") {
    await runReport(context, entry.title, ins.command);
    return;
  }
}

async function insertAtCursor(text: string) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Meridian: open a Lean file first.");
    return;
  }
  const snippet = new vscode.SnippetString(text);
  await editor.insertSnippet(snippet);
}

async function runReport(context: vscode.ExtensionContext, title: string, command: string) {
  const { lakeRoot, rootImport } = resolveProject();
  if (!lakeRoot) {
    vscode.window.showErrorMessage("Meridian: no Lake project found (missing lakefile.toml / lakefile.lean).");
    return;
  }
  if (!projectHasMeridian(lakeRoot)) {
    vscode.window.showErrorMessage(
      `Meridian: this command needs Meridian as a Lake dependency, but it's not listed in ${lakeRoot}. Add it to lakefile.toml and run 'lake update'.`,
    );
    return;
  }

  let arg: string | undefined;
  if (command === "#mathlib_coverage") {
    arg = await pickQualifiedDecl();
    if (!arg) return;
  }

  const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
  const activeModule = activePath ? pathToModule(lakeRoot, activePath) : undefined;
  const src = buildReportSource(rootImport, command, arg, activeModule ? [activeModule] : []);
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Meridian: running ${command} (cancellable)`, cancellable: true },
    (_p, token) => runScratch(lakeRoot, src, { token }),
  );

  output.appendLine(`\n=== ${command} (lake root: ${lakeRoot}, import: ${rootImport}) ===`);
  output.appendLine(`exit code: ${result.code}`);
  output.appendLine(`--- scratch source ---\n${src}`);
  output.appendLine(`--- stdout ---\n${result.stdout}`);
  output.appendLine(`--- stderr ---\n${result.stderr}`);
  if (!result.ok) {
    vscode.window.showErrorMessage(
      `Meridian: ${command} failed (exit ${result.code}). See "Meridian" output channel.`,
      "Open Output",
    ).then((c) => { if (c) output.show(); });
  }

  const friendlyStderr = command === "#mathlib_coverage" ? friendlyRaw(result.stderr) : result.stderr;
  const friendlyStdout = command === "#mathlib_coverage" ? friendlyRaw(result.stdout) : result.stdout;
  const html = pickRenderer(command)(friendlyStderr, friendlyStdout);
  show(context, title, html);

  // Also feed the dashboard when relevant.
  if (command === "#sorry_inventory") ingestSorryInventory(dash, result.stderr, result.stdout);
  if (command === "#gap_report_all")      ingestGapReport(dash, result.stderr, result.stdout);
  if (command === "#mathlib_coverage") ingestCoverage(dash, result.stderr, result.stdout);
}

function pickRenderer(command: string) {
  if (command === "#dep_graph") return renderDepGraph;
  if (command === "#sorry_inventory") return renderSorryInventory;
  if (command === "#gap_report_all") return renderGapReport;
  return (stderr: string, stdout: string) => renderRaw(command, stderr || stdout);
}

async function pickQualifiedDecl(): Promise<string | undefined> {
  const doc = vscode.window.activeTextEditor?.document;
  const decls = doc && doc.languageId === "lean4" ? scanFileForDecls(doc) : [];
  if (!decls.length) {
    return vscode.window.showInputBox({
      prompt: "Fully-qualified declaration name (e.g. Meridian.Domain.GMT.firstVariation_zero)",
    });
  }
  const items: (vscode.QuickPickItem & { value: string })[] = decls.map((d) => ({
    label: d.name,
    description: `line ${d.line}`,
    value: d.name,
  }));
  items.push({ label: "$(edit) Enter another name…", description: "Type a fully-qualified name", value: "__custom__" });
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Pick a declaration in the active file",
    matchOnDescription: true,
  });
  if (!pick) return undefined;
  if (pick.value === "__custom__") {
    return vscode.window.showInputBox({ prompt: "Fully-qualified declaration name" });
  }
  return pick.value;
}

function resolveProject(): { lakeRoot?: string; rootImport: string } {
  const active = vscode.window.activeTextEditor?.document.uri.fsPath;
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const start = active ? path.dirname(active) : folder;
  if (!start) return { rootImport: "Meridian" };
  const lakeRoot = findLakeRoot(start);
  if (!lakeRoot) return { rootImport: "Meridian" };
  return { lakeRoot, rootImport: guessRootImport(lakeRoot) };
}

async function runProjectCoverageCmd() {
  const { lakeRoot, rootImport } = resolveProject();
  if (!lakeRoot) {
    vscode.window.showErrorMessage("Meridian: no Lake project found.");
    return;
  }
  if (!projectHasMeridian(lakeRoot)) {
    vscode.window.showErrorMessage(
      `Meridian: project-wide coverage requires Meridian as a Lake dependency, but it's not listed in ${lakeRoot}. Add it to lakefile.toml and run 'lake update'.`,
    );
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Meridian: project-wide Mathlib coverage", cancellable: true },
    async (progress, token) => {
      progress.report({ message: "scanning project files for sorries…" });
      const decls = listProjectSorries(lakeRoot, rootImport);
      output.appendLine(`\n=== project coverage: ${decls.length} sorry-bearing decls ===`);
      for (const d of decls) output.appendLine(`  ${d}`);
      if (token.isCancellationRequested) return;
      if (!decls.length) {
        vscode.window.showInformationMessage("Meridian: no sorries found in project.");
        ingestCoverageBlocks(dash, []);
        return;
      }
      progress.report({ message: `running coverage on ${decls.length} decls (first run builds Mathlib DiscrTree, can take minutes)` });
      const blocks = await runProjectCoverage(lakeRoot, rootImport, decls, token, (m) => output.appendLine(m));
      output.appendLine(`coverage parsed: ${blocks.length} blocks`);
      ingestCoverageBlocks(dash, blocks);
      vscode.window.showInformationMessage(`Meridian: coverage populated for ${blocks.length} declarations.`);
    },
  );
}

async function refreshDashboard(_context: vscode.ExtensionContext) {
  // Sorries: re-scan the active file directly (fast, reliable).
  const doc = vscode.window.activeTextEditor?.document;
  if (doc && doc.languageId === "lean4") {
    dash.update({ sorries: scanFileForSorries(doc) });
  }
  // Gaps: skip auto-refresh (Meridian's #gap_report is too slow to run on every change).
  // User can run "Meridian: Gap Report" explicitly.
}
