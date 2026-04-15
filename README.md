# meridian-vscode

VS Code integration for [Meridian](https://github.com/alejandro-soto-franco/Meridian), a Lean 4 metaprogramming toolkit for proof search, sorry extraction, dependency analysis, Mathlib coverage, and PDE/GMT domain tactics.

Runs locally. No network calls, no hosted API, no data leaves your machine.

## Features

**Command palette** (all commands prefixed `Meridian:`):

- **Core:** Sorry Inventory, Sorry Extract, Extract Theorems, Dependency Graph, Verify Proof, Theorem → Sorry, Normalize, Rename, Disprove
- **Search:** Suggest Tactic, Proof Search (IDA*), Decompose Goal, Instance Debug
- **Analysis:** Mathlib Coverage, Gap Report
- **PDE:** Distributional, Sobolev, Biot–Savart, Connection, Curvature, Helicity
- **GMT:** definitions and statement-level theorems from `Meridian.Domain.GMT`

Insert-style commands drop the right snippet at your cursor. Report-style commands run `lake env lean` on a scratch file, capture output, and render it.

**Results webview** renders:

- `#dep_graph` → interactive SVG via `@hpcc-js/wasm` Graphviz
- `#sorry_inventory` → sortable, filterable table with jump-to-definition
- `#gap_report` → sortable, filterable Mathlib gap table
- Anything else → raw, denoised Lean output

**Sidebar dashboard** (activity bar → Meridian):

- **Sorries** — project-wide, click to jump
- **Mathlib Gaps** — near-miss candidates
- **Coverage** — last `#mathlib_coverage` output
- **Commands** — browsable, self-documenting catalog

Auto-refreshes on save (disable via `meridian.autoRefreshOnSave`).

## Requirements

- [Lean 4 VS Code extension](https://marketplace.visualstudio.com/items?itemName=leanprover.lean4) (installed automatically as a dependency)
- A Lake project with Meridian listed in `lakefile.toml`:

  ```toml
  [[require]]
  name = "Meridian"
  git = "https://github.com/alejandro-soto-franco/Meridian"
  rev = "main"
  ```

## Settings

| Setting | Default | Description |
|---|---|---|
| `meridian.lakeExecutable`    | `lake`   | Path to the Lake binary |
| `meridian.autoRefreshOnSave` | `true`   | Refresh dashboard on Lean save |
| `meridian.heartbeats`        | `400000` | Default `meridian_search` heartbeats |

## Build

```bash
npm install
npm run compile
```

Then F5 in VS Code to launch an Extension Development Host.

## License

Apache-2.0. Copyright 2026 Alejandro Jose Soto Franco.
