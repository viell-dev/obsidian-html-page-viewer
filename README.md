<p align="center">
  <img src="assets/hero.svg" alt="HTML Page Viewer for Obsidian" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
  <img alt="Obsidian 1.5.0+" src="https://img.shields.io/badge/Obsidian-1.5.0%2B-7c3aed?style=flat-square">
  <img alt="Read-only" src="https://img.shields.io/badge/mode-read--only-0f766e?style=flat-square">
  <img alt="Personal fork" src="https://img.shields.io/badge/status-personal%20fork-8a6d3b?style=flat-square">
</p>

# HTML Page Viewer

> **Fork notice:** This is a personal fork of [viggomeesters/obsidian-html-page-viewer](https://github.com/viggomeesters/obsidian-html-page-viewer), extended with local vault asset support and a settings tab. It is not submitted to the Obsidian Community plugin directory and publishes no releases; it lives on GitHub for personal use and is installed from source.

HTML Page Viewer is a read-only Obsidian plugin for opening `.html` and `.htm` files as rendered pages inside Obsidian. It is built for local reports, exported dashboards, documentation pages, prototypes, and generated visual artifacts that you want to inspect without leaving the vault.

![HTML Page Viewer preview](assets/screenshot.svg)

## Features

- Opens `.html` and `.htm` files in a dedicated Obsidian view.
- Shows a rendered preview by default.
- Displays local vault assets: relative and vault-absolute references to images, stylesheets, media, and other files are rewritten so they render inside the sandbox.
- Resolves asset paths the Obsidian way too: shortest-path matches (such as attachments in a configured attachment folder) work as a fallback.
- Offers two asset loading modes: inline `data:` URIs under the strictest sandbox (default), or direct vault links with same-origin access and scripts disabled.
- Lets you choose which element types the URL rewriting runs on.
- Provides a source view with lightweight HTML syntax highlighting and line numbers.
- Includes a toolbar for Rendered/Source and Refresh.
- Keeps scripts disabled by default; enabling them is a deliberate settings change, not a per-tab toggle.
- Renders through a sandboxed iframe.
- Blocks forms, popups, top-level navigation, and same-origin access.
- Stays read-only by design: it never writes back to HTML files.

## Security model

HTML files can execute powerful browser behavior if a viewer permits it. HTML Page Viewer uses a conservative default:

- Scripts are **OFF** by default and enabled only via the settings tab.
- Enabling scripts adds only `allow-scripts` to the iframe sandbox.
- The iframe is never granted `allow-forms`, `allow-popups`, or `allow-top-navigation`.
- `allow-same-origin` is granted only in the opt-in "Direct vault links" mode, and that mode unconditionally disables scripts: a same-origin `srcdoc` document shares Obsidian's own origin, and scripts there could reach the app object and, on desktop, Node through the parent window. The mutual exclusion is enforced in the sandbox computation itself, not just in the settings UI.
- The plugin code does not make network requests.
- The plugin code does not read or write the system clipboard.
- The plugin code does not edit vault files.

Rendered HTML may still request external resources, such as images, stylesheets, fonts, or scripts, when the HTML document itself references them. This is normal browser behavior for rendered HTML pages and is separate from plugin code making network requests.

### Local asset translation

To display vault-stored assets inside the sandbox, the rendered preview rewrites local references (`src`, `href`, `srcset`, `poster`, `object` `data`, SVG `href`/`xlink:href`, and CSS `url()`/`@import` values) before loading the document into the iframe. Two modes are available in settings:

**Inline assets (default).** The sandbox never grants `allow-same-origin`, so the document has an opaque origin and cannot use responses fetched from Obsidian's `app://` resource URLs. Assets are therefore inlined as `data:` URIs, which involve no fetch at all:

- Images, media, fonts, and other binary assets up to the configured size limit (default 8 MiB) are embedded as base64 `data:` URIs.
- Local stylesheets are inlined as `<style>` elements with their own `url()` and `@import` references rewritten; local scripts are inlined as inline scripts (still subject to the JavaScript setting); local iframes are inlined as nested `srcdoc` documents.
- References that cannot be made to work are left verbatim rather than rewritten: oversized files, unresolvable paths, and anchors (the opaque origin refuses `app://` navigation anyway). A rewritten URL that still cannot render is worse than the original.

**Direct vault links.** References are translated to Obsidian `app://` resource URLs and the sandbox grants `allow-same-origin` so they load directly. Scripts are unconditionally disabled in this mode (see the security model above). This mode avoids embedding and its size limit, so it suits pages with large or streaming media, and anchors to other vault files work.

Both modes share these rules:

- Only references written in the HTML document itself are translated; the plugin never embeds or exposes files the document does not reference.
- Paths that resolve outside the vault (for example `../../outside.png` from the vault root) are rejected and left untouched, as are references that do not resolve to an existing vault file.
- Documents with an external `<base href>` are not rewritten, because their relative references intentionally target that base URL.
- The "Rewritten elements" setting controls which element types the rewriting runs on; clearing it disables rewriting entirely.

## Why read-only?

HTML reports and exported pages are often generated artifacts. HTML Page Viewer intentionally does not write to disk, so it cannot reformat, truncate, or corrupt your files.

## Installation

This fork is not distributed through the Community plugin directory, BRAT, or GitHub releases. Install it from source:

1. Clone this repository and build it:

   ```bash
   npm install
   npm run build
   ```

2. Copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/html-page-viewer/` inside your vault (or symlink the repository there).
3. Reload Obsidian and enable **HTML Page Viewer** in **Settings -> Community plugins**.

## Usage

Open any `.html` or `.htm` file in your vault. Obsidian will open it with HTML Page Viewer.

Use the toolbar to:

- switch between the rendered preview and source view
- refresh the rendered preview after file changes

Everything else lives in **Settings -> HTML Page Viewer**: the asset loading mode, the JavaScript setting, the list of rewritten element types, and the maximum inline size. Settings changes re-render open viewers automatically.

## Development

```bash
npm install
npm run build
npx tsc --noEmit
npm test
```

For local development, copy or symlink this repository into `.obsidian/plugins/html-page-viewer/` inside an Obsidian vault.

## Releases

This fork does not publish GitHub releases or tags; versions in `manifest.json` and `CHANGELOG.md` track the fork's own changes.

## Acknowledgements

This fork builds on [viggomeesters/obsidian-html-page-viewer](https://github.com/viggomeesters/obsidian-html-page-viewer) by Viggo Meesters. The upstream project was built independently but informed by the existing Obsidian HTML viewer ecosystem, including the MIT-licensed [JiaLinZhang24/obsidian-html-viewer](https://github.com/JiaLinZhang24/obsidian-html-viewer); no source code from that project is included in this repository.

## License

[MIT](LICENSE)
