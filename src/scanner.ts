import * as vscode from "vscode";
import { SorryEntry } from "./parser";

// Extract `namespace Foo` / `end Foo` blocks and top-level `theorem|lemma|def|...` declarations
// from a Lean document, returning fully-qualified names with their line numbers.
export function scanFileForDecls(doc: vscode.TextDocument): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = [];
  const nsStack: string[] = [];
  const re = /^\s*(?:@\[[^\]]*\]\s*)*(?:noncomputable\s+|private\s+|protected\s+|partial\s+|nonrec\s+|unsafe\s+)*(theorem|lemma|def|abbrev|instance|structure|inductive|class|opaque|axiom|example)\s+([A-Za-z_][\w.']*)/;
  const nsRe = /^\s*namespace\s+([A-Za-z_][\w.']*)/;
  const endRe = /^\s*end\s+([A-Za-z_][\w.']*)\s*$/;

  for (let i = 0; i < doc.lineCount; i++) {
    const line = doc.lineAt(i).text;
    const ns = nsRe.exec(line);
    if (ns) { nsStack.push(ns[1]!); continue; }
    const e = endRe.exec(line);
    if (e) {
      const last = nsStack[nsStack.length - 1];
      if (last && (last === e[1] || last.endsWith(`.${e[1]}`))) nsStack.pop();
      continue;
    }
    const m = re.exec(line);
    if (m) {
      const local = m[2]!;
      const fq = nsStack.length ? `${nsStack.join(".")}.${local}` : local;
      out.push({ name: fq, line: i + 1 });
    }
  }
  return out;
}

// Simple, reliable scan: every line containing `sorry` (as a word) that isn't a comment.
// Captures `sorry`, `:= sorry`, `exact sorry`, `· sorry`, etc. Skips `--` line comments.
export function scanFileForSorries(doc: vscode.TextDocument): SorryEntry[] {
  const out: SorryEntry[] = [];
  const re = /\bsorry\b/;
  const file = doc.uri.fsPath;
  let inBlockComment = false;

  for (let i = 0; i < doc.lineCount; i++) {
    let line = doc.lineAt(i).text;

    // Strip block comments /- ... -/ (single-line tracking is approximate but good enough).
    let cleaned = "";
    let j = 0;
    while (j < line.length) {
      if (inBlockComment) {
        const end = line.indexOf("-/", j);
        if (end === -1) { j = line.length; }
        else { inBlockComment = false; j = end + 2; }
      } else {
        const start = line.indexOf("/-", j);
        const lineCmt = line.indexOf("--", j);
        if (lineCmt !== -1 && (start === -1 || lineCmt < start)) {
          cleaned += line.slice(j, lineCmt);
          j = line.length;
        } else if (start !== -1) {
          cleaned += line.slice(j, start);
          inBlockComment = true;
          j = start + 2;
        } else {
          cleaned += line.slice(j);
          j = line.length;
        }
      }
    }

    if (re.test(cleaned)) {
      const snippet = line.trim().slice(0, 80);
      out.push({ name: snippet || "sorry", file, line: i + 1, category: undefined, type: undefined });
    }
  }
  return out;
}
