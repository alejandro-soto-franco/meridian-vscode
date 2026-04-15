# Changelog

All notable changes to the Meridian VS Code extension.

## [0.1.0] — 2026-04-15

Initial release.

### Dependency graph
- Interactive 2-hop graph for the active Lean file, rendered with Graphviz.
- Gold imports on the left, Mathlib imports blue-and-gold, Mathlib refs purple, project refs green/yellow/red by status, Std/Lean refs grey.
- Per-edge usage locations with signature vs proof/body classification.
- Focus mode, click-drag pan, zoom controls, edge-click detail pill.
- Full-project Mathlib symbol index (cached) resolves bare identifiers and transitive Mathlib refs.

### Status classification
- `complete` / `partial` / `stub` computed from every decl body, comment-aware.
- Aggregated per module for import-status colouring.

### Meridian command surface
- Palette commands for every Meridian `#` command and tactic.
- Results webview with interactive dep graph, sortable/filterable sorry inventory, gap report.
- Sidebar views: Sorries (current file), Coverage (project-wide), Commands.
- Project-wide Mathlib coverage with quick-pick for single-decl coverage.
- Output channel mirrored to `~/.meridian-vscode.log`.

### Safety
- Meridian dependency gated at activation; Meridian-dependent commands fail fast with a clear message on projects that don't require Meridian.
- No network calls. No telemetry.
