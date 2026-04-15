import * as vscode from "vscode";
import { CATALOG, CatalogEntry } from "./catalog";
import { parseSorryInventory, parseGapReport, SorryEntry, GapEntry, stripLeanNoise } from "./parser";

import type { CoverageBlock } from "./coverage";

type State = {
  sorries: SorryEntry[];
  gaps: GapEntry[];
  coverageRaw: string;
  coverageBlocks: CoverageBlock[];
  lastUpdated?: Date;
};

export class DashboardState {
  private state: State = { sorries: [], gaps: [], coverageRaw: "", coverageBlocks: [] };
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

type CovNode =
  | { kind: "block"; block: CoverageBlock }
  | { kind: "exact"; parent: CoverageBlock; name: string }
  | { kind: "near"; parent: CoverageBlock; text: string }
  | { kind: "empty"; text: string };

export class CoverageProvider implements vscode.TreeDataProvider<CovNode> {
  readonly onDidChangeTreeData: vscode.Event<CovNode | undefined | void>;
  constructor(private dash: DashboardState) {
    this.onDidChangeTreeData = dash.onDidChange.event as any;
  }
  getTreeItem(e: CovNode): vscode.TreeItem {
    if (e.kind === "block") {
      const it = new vscode.TreeItem(e.block.decl, vscode.TreeItemCollapsibleState.Collapsed);
      it.description = `${e.block.category ?? "?"}  ·  ${e.block.exactMatches.length} exact, ${e.block.nearMisses.length} near`;
      it.tooltip = e.block.raw;
      return it;
    }
    if (e.kind === "exact") {
      const it = new vscode.TreeItem(e.name);
      it.description = "exact match";
      it.iconPath = new vscode.ThemeIcon("check");
      return it;
    }
    if (e.kind === "near") {
      const it = new vscode.TreeItem(e.text);
      it.iconPath = new vscode.ThemeIcon("circle-outline");
      return it;
    }
    return new vscode.TreeItem(e.text);
  }
  getChildren(e?: CovNode): CovNode[] {
    if (!e) {
      const blocks = this.dash.current.coverageBlocks;
      if (!blocks.length) {
        const raw = this.dash.current.coverageRaw;
        if (raw) {
          return stripLeanNoise(raw).split(/\r?\n/).filter((l) => l.trim()).map((t) => ({ kind: "empty", text: t } as CovNode));
        }
        return [{ kind: "empty", text: "(run Meridian: Mathlib Coverage (Whole Project) to populate)" }];
      }
      return blocks.map((b) => ({ kind: "block", block: b } as CovNode));
    }
    if (e.kind === "block") {
      const out: CovNode[] = [];
      for (const m of e.block.exactMatches) out.push({ kind: "exact", parent: e.block, name: m });
      for (const t of e.block.nearMisses)   out.push({ kind: "near",  parent: e.block, text: t });
      return out;
    }
    return [];
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
export function ingestCoverageBlocks(dash: DashboardState, blocks: CoverageBlock[]) {
  dash.update({ coverageBlocks: blocks, coverageRaw: "" });
}
