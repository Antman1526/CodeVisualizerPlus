# Changes from Upstream — CodeVisualizer Plus

This document describes what was changed, added, or improved in this fork
relative to the original [CodeVisualizer v1.0.6](https://github.com/DucPhamNgoc08/CodeVisualizer)
by [Duc Pham Ngoc](https://github.com/DucPhamNgoc08).

> **Credit:** All core architecture — the Tree-sitter WASM parsers, FlowchartIR pipeline,
> Mermaid rendering engine, AI label system, 9 color themes, codebase dependency graph,
> and VS Code/Cursor/Windsurf compatibility layer — is entirely the original author's work.
> This fork only adds the features described below.

---

## New Features

### 1. Markdown Document Visualization

**Files changed:**
- `src/core/language-services/markdown/MarkdownParser.ts` *(new)*
- `src/core/language-services/markdown/index.ts` *(new)*
- `src/core/analyzer.ts` *(modified — added `"markdown"` case)*

**What it does:**

When you open any `.md` file, CodeVisualizer now renders the document structure
as an interactive diagram instead of showing an error.

The visualization has two layers:

- **Heading hierarchy tree** — Every heading from H1 through H6 is parsed into a node.
  H1 becomes the root; H2 are its children; H3 are grandchildren, and so on.
  Node shapes vary by level (stadium for H1, rectangle for H2, rounded for H3+)
  so you can read the depth at a glance.

- **Outbound link graph** — Every `[text](url)` link in the document is extracted
  and attached to the nearest heading above it. Each unique link target becomes a
  separate node connected by a labeled edge. External URLs are prefixed with 🌐;
  local relative file links with 📄. Pure `#anchor` links (same-page references)
  are intentionally skipped to avoid visual noise.

Clicking a heading node in the diagram jumps the editor cursor to that heading,
just like clicking a code node jumps to that line in a function flowchart.

Because the parser sets `functionRange` to the full document extent, the diagram
does not re-render every time the cursor moves — only when the file content changes.

---

### 2. Markdown Files in the Codebase Dependency Graph

**Files changed:**
- `src/core/dependency/CodebaseAnalyzer.ts` *(modified)*
- `src/core/dependency/FileTypeClassifier.ts` *(modified)*

**What it does:**

"Visualize Codebase Flow" now includes `.md` files when scanning a folder.

- `[text](./relative/path.md)` links in Markdown files are treated as dependencies,
  the same way `import` statements are in TypeScript or Python files.
- `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, and `LICENSE.md` are classified
  as **entry** (grey nodes), matching top-level entry-point files.
- All other `.md` files are classified as **report** (pink nodes), matching the
  documentation/report category that already existed in the classifier.
- External `http://` links and `#anchor` links are not included as dependency edges
  since they don't represent local file relationships.

---

### 3. Improved Unsupported-File Message

**Files changed:**
- `src/view/BaseFlowchartProvider.ts` *(modified — added `getUnsupportedLanguageHtml()`)*

**What it does:**

Previously, opening a file in an unsupported language (e.g. `.json`, `.yaml`, `.html`)
showed a plain text error message: `Error: Unsupported language: json`.

The new behavior renders a styled info card that shows:

- The filename
- Line count and file size in KB
- A language badge
- A friendly explanation
- The complete list of supported languages with file extensions

This also ensures that Markdown, which is now supported, is listed correctly
in the "supported" list that users see in the card for truly unsupported types.

---

### 4. Working Export Command

**Files changed:**
- `src/view/BaseFlowchartProvider.ts` *(modified — added `triggerExport()` and webview message handler)*
- `src/extension.ts` *(modified — replaced "coming soon" stub)*

**What it does:**

The `CodeVisualizer: Export Flowchart` command in the Command Palette previously
showed an "Export flowchart feature coming soon!" info message and did nothing.

The export logic itself was already fully implemented inside the webview (the toolbar
buttons worked). The gap was that the command palette entry had no connection to it.

The fix:

1. A `triggerExport(fileType: 'svg' | 'png')` method was added to `BaseFlowchartProvider`.
   It posts a `triggerExport` message to the active webview.
2. The webview's `message` event listener handles `triggerExport` by calling the
   existing `exportFlowchart(fileType)` JavaScript function — the same one the
   SVG/PNG toolbar buttons already use.
3. The extension command now shows a QuickPick (`PNG` / `SVG`), then calls
   `triggerExport()` on whichever provider is currently visible (panel first,
   sidebar as fallback).

The underlying export quality is unchanged: PNG is generated at 2× resolution,
SVG is exported clean (no UI chrome), and both go through VS Code's Save dialog.

---

### 5. Auto README Preview on Codebase Visualization

**Files changed:**
- `src/extension.ts` *(modified — added README detection)*

**What it does:**

When you run "Visualize Codebase Flow" on a folder, CodeVisualizer now checks
whether that folder contains a `README.md` (also checks `readme.md` and `Readme.md`).

If one is found, VS Code's built-in Markdown preview is automatically opened to the
side (`markdown.showPreviewToSide`). This means you get the dependency graph in
one panel and the project's own documentation right next to it — no manual steps.

---

### 6. Updated README

**Files changed:**
- `README.md` *(full rewrite)*

**What changed:**

The original README was accurate for v1.0.6 but did not cover the new features,
and its installation section only described VS Code.

The new README includes:

- A clear attribution banner at the top crediting the original author
- Separate installation steps for **VS Code**, **Cursor**, **Windsurf**,
  and a generic VSIX install path for any VS Code-compatible editor
- A feature table covering all three visualization modes
- Updated supported-languages tables showing Markdown as fully supported
- A "How It Works" section with a dedicated Markdown pipeline explanation
- A full configuration reference table for all settings
- Updated contact/links section with fork maintainer and original author both credited

---

## Files Added (net new)

| File | Purpose |
|------|---------|
| `src/core/language-services/markdown/MarkdownParser.ts` | Parses MD headings and links into FlowchartIR |
| `src/core/language-services/markdown/index.ts` | Module re-export |
| `CHANGES.md` | This file |

## Files Modified

| File | What changed |
|------|-------------|
| `src/core/analyzer.ts` | Added `"markdown"` dispatch case |
| `src/core/dependency/CodebaseAnalyzer.ts` | Added `.md` extension, markdown link extraction, `resolveMarkdownLink()`, updated `getLanguageId()` |
| `src/core/dependency/FileTypeClassifier.ts` | Added `.md` file classification block |
| `src/view/BaseFlowchartProvider.ts` | Added `import * as path`, `getUnsupportedLanguageHtml()`, `triggerExport()`, `triggerExport` webview message handler |
| `src/extension.ts` | Fixed `exportFlowchart` command, added README auto-preview in `visualizeCodebase` |
| `README.md` | Full rewrite with attribution, install guides, and updated feature docs |
