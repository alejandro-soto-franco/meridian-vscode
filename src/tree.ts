import * as vscode from "vscode";
import { CATALOG, CatalogEntry } from "./catalog";
import { parseSorryInventory, parseGapReport, SorryEntry, GapEntry, stripLeanNoise } from "./parser";

type State = {
  sorries: SorryEntry[];
  gaps: GapEntry[];
  coverageRaw: string;
  lastUpdated?: Date;
};

export class DashboardState {
  private state: State = { sorries: [], gaps: [], coverageRaw: "" };
  readonly onDidChange = new vscode.EventEmitter<void>();

  update(partial: Partial<State>) {
    this.state = { ...this.state, ...partial, lastUpdated: new Date() };
    this.onDidChange.fire();
  }
  get current(): State { return this.state; }
}

abstract class BaseProvider<T> implements vscode.TreeDataProvider<T> {
  readonly onDidChangeTreeData: vscode.Event<T | undefined | void>;
  constructor(protected dash: DashboardState) {
    this.onDidChangeTreeData = dash.onDidChange.event as any;
  }
  abstract getTreeItem(e: T): vscode.TreeItem;
  abstract getChildren(e?: T): vscode.ProviderResult<T[]>;
}

export class SorriesProvider extends BaseProvider<SorryEntry> {
  getTreeItem(e: SorryEntry): vscode.TreeItem {
    const it = new vscode.TreeItem(e.name);
    it.description = [e.category, e.file && `${e.file}${e.line ? `:${e.line}` : ""}`].filter(Boolean).join("  ");
    it.tooltip = e.type;
    if (e.file) {
      it.command = {
        command: "vscode.open",
        title: "Open",
        arguments: [
          vscode.Uri.file(e.file),
          { selection: e.line ? new vscode.Range(e.line - 1, 0, e.line - 1, 0) : undefined },
        ],
      };
    }
    return it;
  }
  getChildren(): SorryEntry[] { return this.dash.current.sorries; }
}

export class GapsProvider extends BaseProvider<GapEntry> {
  getTreeItem(e: GapEntry): vscode.TreeItem {
    const it = new vscode.TreeItem(e.name);
    it.description = [e.candidate, e.score].filter(Boolean).join("  ·  ");
    it.tooltip = e.note;
    return it;
  }
  getChildren(): GapEntry[] { return this.dash.current.gaps; }
}

export class CoverageProvider extends BaseProvider<string> {
  getTreeItem(e: string): vscode.TreeItem { return new vscode.TreeItem(e); }
  getChildren(): string[] {
    const raw = this.dash.current.coverageRaw;
    if (!raw) return ["(run Mathlib Coverage to populate)"];
    return stripLeanNoise(raw).split(/\r?\n/).filter((l) => l.trim().length);
  }
}

export class CommandsProvider implements vscode.TreeDataProvider<CatalogEntry> {
  getTreeItem(e: CatalogEntry): vscode.TreeItem {
    const it = new vscode.TreeItem(e.title);
    it.description = e.doc;
    it.tooltip = e.doc;
    it.command = { command: e.id, title: e.title };
    return it;
  }
  getChildren(): CatalogEntry[] { return CATALOG; }
}

export function ingestSorryInventory(dash: DashboardState, stderr: string, stdout: string) {
  dash.update({ sorries: parseSorryInventory(stderr + "\n" + stdout) });
}
export function ingestGapReport(dash: DashboardState, stderr: string, stdout: string) {
  dash.update({ gaps: parseGapReport(stderr + "\n" + stdout) });
}
export function ingestCoverage(dash: DashboardState, stderr: string, stdout: string) {
  dash.update({ coverageRaw: stderr + "\n" + stdout });
}
