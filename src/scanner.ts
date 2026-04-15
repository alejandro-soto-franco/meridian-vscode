import * as vscode from "vscode";
import { SorryEntry } from "./parser";

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
