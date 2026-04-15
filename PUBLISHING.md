# Publishing to the VS Code Marketplace

Tracker for the remaining steps to get `meridian-vscode` on the Marketplace.

## Prerequisites

- [ ] **Publisher account** — register `alejandro-soto-franco` (or chosen handle) at <https://marketplace.visualstudio.com/manage>. Requires an Azure DevOps organisation.
- [ ] **Personal Access Token** (PAT) with *Marketplace (publish)* scope, scoped to all accessible organisations. Store in a password manager.
- [ ] **`vsce` CLI** installed: `npm install -g @vscode/vsce`.

## Package assets

- [ ] **Icon** — `resources/icon.png`, 128×128 (or 256×256) PNG. Generate from `resources/meridian.svg`:

  ```bash
  # e.g. with ImageMagick / librsvg
  rsvg-convert -w 256 -h 256 resources/meridian.svg > resources/icon.png
  ```

- [ ] **Screenshots** — README references a hero dependency-graph image. Drop `docs/screenshot-graph.png` at 1200×720 or wider and reference it from the README.
- [ ] **LICENSE** — already present (Apache-2.0).
- [ ] **CHANGELOG.md** — already present.

## Package.json polish

Already set:
- `name`, `displayName`, `description`, `version`, `publisher`
- `repository`, `bugs`, `homepage`
- `engines.vscode: ^1.85.0`
- `categories`, `keywords`
- `galleryBanner` colour
- `extensionDependencies: ["leanprover.lean4"]`

Final checks before first publish:
- [ ] Bump `version` to `0.1.0` (or `0.0.1` if we prefer to reserve 0.1 for first stable).
- [ ] Decide whether to depend on `leanprover.lean4` hard (current behaviour) or soften to `extensionPack` recommendation.

## Dry run

```bash
cd ~/meridian-vscode
vsce package          # produces meridian-vscode-0.1.0.vsix
```

Install the .vsix locally to verify end-to-end behaviour in a fresh VS Code window:

```bash
code --install-extension meridian-vscode-0.1.0.vsix
```

Exercise:
- Activation on a Lake project.
- Dependency graph renders, imports wire, status colouring correct.
- Mathlib Coverage (Whole Project) completes on a project with Meridian.
- Output channel mirrors to `~/.meridian-vscode.log`.

## Publish

```bash
vsce login alejandro-soto-franco  # paste PAT once
vsce publish                      # or `vsce publish patch|minor|major` to auto-bump
```

Listing appears at `https://marketplace.visualstudio.com/items?itemName=alejandro-soto-franco.meridian-vscode` within a minute or two after indexing.

## Post-publish

- [ ] Add the Marketplace badge to the README:

  ```md
  [![Marketplace](https://img.shields.io/visual-studio-marketplace/v/alejandro-soto-franco.meridian-vscode)](https://marketplace.visualstudio.com/items?itemName=alejandro-soto-franco.meridian-vscode)
  ```

- [ ] Open Collective / GitHub sponsor link (optional) in the README.
- [ ] Announce: Lean Zulip `#announce` stream, Mathlib Discord, r/leanprover.

## Marketplace listing hygiene

- Keep `CHANGELOG.md` updated; the Marketplace renders it in the "Changelog" tab.
- Use `vsce publish minor` when adding features, `vsce publish patch` for bug fixes.
- Avoid bundling large assets — `.vscodeignore` is already configured to strip sources.
