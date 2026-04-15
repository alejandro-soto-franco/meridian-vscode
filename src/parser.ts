// Best-effort parsers for Meridian # command output captured from `lake env lean`.
// Meridian prints `#` command output to stderr as info messages. Formats may vary
// across Meridian versions; these parsers are defensive and fall back to raw text.

export interface SorryEntry {
  name: string;
  file?: string;
  line?: number;
  category?: string;
  type?: string;
}

export interface GapEntry {
  name: string;
  candidate?: string;
  score?: string;
  note?: string;
}

export function stripLeanNoise(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => !l.startsWith("info: ") && !l.startsWith("warning: "))
    .join("\n");
}

// Extract DOT block from output.
export function extractDot(text: string): string | undefined {
  const m = text.match(/digraph[\s\S]*?\n\}/);
  return m ? m[0] : undefined;
}

// Parse sorry_inventory: tolerant to "name :: file:line [category] type" or tab/csv style.
export function parseSorryInventory(text: string): SorryEntry[] {
  const cleaned = stripLeanNoise(text);
  const rows: SorryEntry[] = [];
  for (const raw of cleaned.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    // Try tab-separated
    const tabs = line.split("\t");
    if (tabs.length >= 2) {
      rows.push({
        name: tabs[0]!.trim(),
        file: tabs[1]?.trim(),
        line: tabs[2] ? Number(tabs[2]) || undefined : undefined,
        category: tabs[3]?.trim(),
        type: tabs[4]?.trim(),
      });
      continue;
    }
    // Try " :: " separator
    const parts = line.split(" :: ");
    if (parts.length >= 2) {
      const [name, loc, ...rest] = parts;
      const locMatch = loc!.match(/^(.+?):(\d+)/);
      rows.push({
        name: name!.trim(),
        file: locMatch ? locMatch[1] : loc,
        line: locMatch ? Number(locMatch[2]) : undefined,
        category: rest.join(" :: ").trim() || undefined,
      });
      continue;
    }
    // Bare name
    if (/^[A-Za-z_][\w.]*$/.test(line)) {
      rows.push({ name: line });
    }
  }
  return rows;
}

export function parseGapReport(text: string): GapEntry[] {
  const cleaned = stripLeanNoise(text);
  const rows: GapEntry[] = [];
  for (const raw of cleaned.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const tabs = line.split("\t");
    if (tabs.length >= 2) {
      rows.push({
        name: tabs[0]!.trim(),
        candidate: tabs[1]?.trim(),
        score: tabs[2]?.trim(),
        note: tabs.slice(3).join(" ").trim() || undefined,
      });
    } else if (/^[A-Za-z_][\w.]*$/.test(line)) {
      rows.push({ name: line });
    }
  }
  return rows;
}
