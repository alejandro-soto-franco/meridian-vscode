// Catalog of every Meridian command / tactic exposed by the extension.
// Each entry describes how to render it into a Lean buffer.

export type Insertion =
  | { kind: "snippet"; text: string }                          // insert at cursor
  | { kind: "prompt-snippet"; prompt: string; build: (arg: string) => string }
  | { kind: "report"; command: string };                       // run & show in webview

export interface CatalogEntry {
  id: string;
  title: string;
  doc: string;
  insertion: Insertion;
}

export const CATALOG: CatalogEntry[] = [
  // ----- Core # commands (inserted into buffer) -----
  { id: "meridian.sorryExtract", title: "#sorry_extract", doc: "Extract all sorries into standalone lemma stubs.",
    insertion: { kind: "snippet", text: "#sorry_extract\n" } },
  { id: "meridian.extractTheorems", title: "#extract_theorems", doc: "Extract theorems with metadata.",
    insertion: { kind: "snippet", text: "#extract_theorems\n" } },
  { id: "meridian.theorem2sorry", title: "#theorem2sorry", doc: "Replace a theorem with a sorry stub.",
    insertion: { kind: "snippet", text: "#theorem2sorry ${1:declName}\n" } },
  { id: "meridian.normalize", title: "#normalize", doc: "Run Meridian's structural normalizer.",
    insertion: { kind: "snippet", text: "#normalize\n" } },
  { id: "meridian.rename", title: "#rename", doc: "Rename a declaration.",
    insertion: { kind: "prompt-snippet", prompt: "oldName newName",
      build: (arg) => `#rename ${arg}\n` } },
  { id: "meridian.verifyProof", title: "#verify_proof", doc: "Verify a candidate proof against a sorry.",
    insertion: { kind: "prompt-snippet", prompt: "declaration name",
      build: (n) => `#verify_proof ${n}\n` } },
  { id: "meridian.disprove", title: "#disprove", doc: "Search for counterexamples.",
    insertion: { kind: "prompt-snippet", prompt: "declaration name",
      build: (n) => `#disprove ${n}\n` } },

  // ----- Search tactics (inserted in tactic mode) -----
  { id: "meridian.suggest", title: "meridian_suggest", doc: "Suggest tactics for the current goal.",
    insertion: { kind: "snippet", text: "meridian_suggest" } },
  { id: "meridian.search", title: "meridian_search", doc: "Multi-step proof search (IDA* with memoization).",
    insertion: { kind: "snippet", text: "meridian_search (heartbeats := ${1:400000})" } },
  { id: "meridian.decompose", title: "meridian_decompose", doc: "Decompose goal into sub-lemmas.",
    insertion: { kind: "snippet", text: "meridian_decompose" } },
  { id: "meridian.instanceDebug", title: "#instance_debug", doc: "Diagnose type-class synthesis failure.",
    insertion: { kind: "prompt-snippet", prompt: "type class",
      build: (c) => `#instance_debug ${c}\n` } },

  // ----- PDE tactics -----
  { id: "meridian.distrib", title: "meridian_distrib", doc: "Distributional derivative / weak formulation.",
    insertion: { kind: "snippet", text: "meridian_distrib" } },
  { id: "meridian.sobolev", title: "meridian_sobolev", doc: "Sobolev exponent arithmetic.",
    insertion: { kind: "snippet", text: "meridian_sobolev" } },
  { id: "meridian.biotSavart", title: "meridian_biot_savart", doc: "Biot–Savart connection automation.",
    insertion: { kind: "snippet", text: "meridian_biot_savart" } },
  { id: "meridian.connection", title: "meridian_connection", doc: "Connection automation.",
    insertion: { kind: "snippet", text: "meridian_connection" } },
  { id: "meridian.curvature", title: "meridian_curvature", doc: "Curvature bound tactic.",
    insertion: { kind: "snippet", text: "meridian_curvature" } },
  { id: "meridian.helicity", title: "meridian_helicity", doc: "Helicity tactic.",
    insertion: { kind: "snippet", text: "meridian_helicity" } },

  // ----- Report commands (run + render in webview) -----
  { id: "meridian.depGraph",        title: "#dep_graph",        doc: "Build project dependency graph (DOT) and render it.",
    insertion: { kind: "report", command: "#dep_graph" } },
  { id: "meridian.sorryInventory",  title: "#sorry_inventory",  doc: "Sorry inventory with auto-categorisation.",
    insertion: { kind: "report", command: "#sorry_inventory" } },
  { id: "meridian.gapReport",       title: "#gap_report",       doc: "Project-level Mathlib gap report.",
    insertion: { kind: "report", command: "#gap_report" } },
  { id: "meridian.mathlibCoverage", title: "#mathlib_coverage", doc: "Find near-miss Mathlib lemmas for a sorry.",
    insertion: { kind: "report", command: "#mathlib_coverage" } },
];

export function find(id: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.id === id);
}
