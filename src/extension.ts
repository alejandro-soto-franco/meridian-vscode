import * as vscode from "vscode";
import * as path from "path";
import { CATALOG, find } from "./catalog";
import { buildReportSource, findLakeRoot, guessRootImport, runScratch } from "./runner";
import {
  renderDepGraph, renderSorryInventory, renderGapReport, renderRaw, show,
} from "./webview";
import {
  DashboardState, SorriesProvider, GapsProvider, CoverageProvider, CommandsProvider,
  ingestSorryInventory, ingestGapReport, ingestCoverage,
} from "./tree";

const dash = new DashboardState();
let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("Meridian");
  context.subscriptions.push(output);
  // Sidebar views.
  const sorries = new SorriesProvider(dash);
  const gaps = new GapsProvider(dash);
  const coverage = new CoverageProvider(dash);
  const commandsView = new CommandsProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("meridian.sorries", sorries),
    vscode.window.registerTreeDataProvider("meridian.gaps", gaps),
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
  );

  // Auto-refresh on save.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const cfg = vscode.workspace.getConfiguration("meridian");
      if (!cfg.get<boolean>("autoRefreshOnSave", true)) return;
      if (doc.languageId !== "lean4") return;
      refreshDashboard(context).catch(() => {});
    }),
  );

  // Initial population (non-blocking).
  refreshDashboard(context).catch(() => {});
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

  let arg: string | undefined;
  if (command === "#mathlib_coverage") {
    arg = await vscode.window.showInputBox({ prompt: "Sorry declaration name" });
    if (!arg) return;
  }

  const src = buildReportSource(rootImport, command, arg);
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Meridian: running ${command}`, cancellable: false },
    () => runScratch(lakeRoot, src),
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

  const html = pickRenderer(command)(result.stderr, result.stdout);
  show(context, title, html);

  // Also feed the dashboard when relevant.
  if (command === "#sorry_inventory") ingestSorryInventory(dash, result.stderr, result.stdout);
  if (command === "#gap_report")      ingestGapReport(dash, result.stderr, result.stdout);
  if (command === "#mathlib_coverage") ingestCoverage(dash, result.stderr, result.stdout);
}

function pickRenderer(command: string) {
  if (command === "#dep_graph") return renderDepGraph;
  if (command === "#sorry_inventory") return renderSorryInventory;
  if (command === "#gap_report") return renderGapReport;
  return (stderr: string, stdout: string) => renderRaw(command, stderr || stdout);
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

async function refreshDashboard(context: vscode.ExtensionContext) {
  const { lakeRoot, rootImport } = resolveProject();
  if (!lakeRoot) return;

  const [inv, gap] = await Promise.all([
    runScratch(lakeRoot, buildReportSource(rootImport, "#sorry_inventory")),
    runScratch(lakeRoot, buildReportSource(rootImport, "#gap_report")),
  ]);
  ingestSorryInventory(dash, inv.stderr, inv.stdout);
  ingestGapReport(dash, gap.stderr, gap.stdout);
}
