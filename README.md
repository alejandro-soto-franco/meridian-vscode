# Meridian for VS Code

**Live dependency graph, sorry inventory and Mathlib coverage view for any Lean 4 project.**

[![Licence: Apache 2.0](https://img.shields.io/badge/licence-Apache%202.0-blue.svg)](./LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85-007ACC.svg?logo=visualstudiocode)](https://code.visualstudio.com/)

Meridian draws an interactive map of how the declarations in the current file depend on the rest of the project and on Mathlib, coloured by proof status. It runs entirely on your machine, with no network call, no hosted API and no telemetry.

---

## Features

### Live dependency graph

Open any `.lean` file and a panel beside the editor renders its 2-hop dependency graph:

- **Gold imports** on the left column (direct imports the file actually uses).
- **Blue-and-gold Mathlib imports** for Mathlib files providing referenced symbols, including transitive ones resolved through a full-project Mathlib index.
- **Purple Mathlib refs** in the middle column.
- **Green / yellow / red status nodes** for project declarations, coloured by whether they're complete, partial, or pure `sorry` stubs.
- **Grey Std / Lean refs** kept visually recessed.

Click to focus a node and light up its incident edges; double-click to jump to the source. Click an edge for a pill showing from → to, usage count, and every line where the reference appears, tagged as **signature** (type-level, harder to refactor) or **body / proof** (value-level, easier).

### Proof status

Each declaration body is classified:

- ✅ **complete**: no `sorry` anywhere
- ⚠ **partial**: some proof work and at least one `sorry`
- ⛔ **stub**: a `sorry` and nothing else

Module-level status propagates to import edges, so a dependency chain that bottoms out in an unfinished module is visible from the top of the file.

### Sorry inventory

The sidebar **Sorries** panel lists every `sorry` in the active file with line numbers and jump-to-definition, refreshed on every edit. Comment-aware so block- and line-comments don't produce false positives.

### Mathlib coverage

Run `Meridian: Mathlib Coverage (Whole Project)` and every sorry-bearing declaration is scanned for near-misses against the Mathlib `DiscrTree`. Results land in the **Coverage** sidebar tree: each declaration collapses to show exact matches and near-misses with gap-kind classification. Runs once per Lean process, amortising the 300 k-entry tree build.

Coverage categories map to user-facing labels:

| Meridian category | Label |
|---|---|
| A | **Available** |
| B | **Partially Available** |
| C | **Not Available** |

### Command palette

Every Meridian `#` command and tactic has a palette entry: `#sorry_inventory`, `#dep_graph`, `#mathlib_coverage`, `meridian_search`, `meridian_distrib`, `meridian_biot_savart`, `meridian_curvature`, and more. Report-style commands open a webview with sortable tables or an interactive Graphviz render; tactic-style commands insert the snippet at the cursor.

---

## Requirements

- [Lean 4 VS Code extension](https://marketplace.visualstudio.com/items?itemName=leanprover.lean4), installed automatically as a dependency.
- A Lake project. The dependency graph works in any Lake project. Coverage, Gap Report, and Sorry Inventory (palette version) additionally require [Meridian](https://github.com/alejandro-soto-franco/Meridian) as a Lake dependency:

  ```toml
  [[require]]
  name = "Meridian"
  git = "https://github.com/alejandro-soto-franco/Meridian"
  rev = "main"
  ```

---

## Getting started

1. Install the extension.
2. Open a Lean 4 project in VS Code.
3. Click the compass icon in the activity bar.
4. Open any `.lean` file. The **Dependency Graph** panel opens beside the editor.
5. On first graph render the extension walks `.lake/packages/mathlib/Mathlib/**/*.lean` once to build the Mathlib symbol index (typically 2–5 s, cached for the session).

### Interacting with the graph

| Action | Gesture |
|---|---|
| Focus a node | single-click |
| Open source | double-click |
| Clear focus | click empty canvas |
| Inspect an edge | single-click |
| Pan | click-and-drag empty canvas |
| Zoom | +/− buttons bottom-right, or Ctrl/Cmd + wheel |
| Reset zoom | ⊙ button |

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `meridian.lakeExecutable` | `lake` | Path to Lake binary. |
| `meridian.autoRefreshOnSave` | `true` | Re-scan on Lean save. |
| `meridian.heartbeats` | `400000` | Default for `meridian_search`. |
| `meridian.depGraphOnStartup` | `true` | Auto-open the Dependency Graph panel. |
| `meridian.coverageOnStartup` | `true` | Run project coverage at activation. |
| `meridian.coverageIgnorePrefixes` | `["Meridian.Core", "Meridian.Search", "Meridian.Analysis"]` | Skip these namespaces when running project coverage. |

---

## Diagnostics

- **`Meridian: Show Output Channel`** opens the extension's log (lake root, root import, Meridian dependency detection, every scratch source and its Lean output).
- The same log mirrors to `~/.meridian-vscode.log` so it's inspectable without opening VS Code.

---

## Design

Meridian never calls the network. The dependency graph scanner reads source files directly. Coverage and inventory commands shell out to `lake env lean` on a temporary scratch buffer inside your project, and the output stays on your machine. It gathers no analytics, calls no remote API and asks for no account.

---

## Roadmap

- Type signature hover tooltips on decl nodes.
- Shift-click view of everything transitively dependent on a node.
- Configurable graph depth slider.
- Search / filter within the graph panel.
- SVG / PNG export.

---

## Contributing

Issues and PRs welcome at [github.com/alejandro-soto-franco/meridian-vscode](https://github.com/alejandro-soto-franco/meridian-vscode). For core Meridian features (tactics, commands) see the upstream [Meridian repo](https://github.com/alejandro-soto-franco/Meridian).

---

## Licence

Apache-2.0. Copyright 2026 Alejandro José Soto Franco.
