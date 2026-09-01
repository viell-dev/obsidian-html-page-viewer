<p align="center">
  <img src="assets/hero.svg" alt="HTML Page Viewer for Obsidian" width="100%">
</p>

<p align="center">
  <a href="https://github.com/viggomeesters/obsidian-html-page-viewer/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/viggomeesters/obsidian-html-page-viewer?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
  <img alt="Obsidian 1.5.0+" src="https://img.shields.io/badge/Obsidian-1.5.0%2B-7c3aed?style=flat-square">
  <img alt="Read-only" src="https://img.shields.io/badge/mode-read--only-0f766e?style=flat-square">
</p>

# HTML Page Viewer

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

### Community plugin directory

HTML Page Viewer is ready for submission to the Obsidian Community plugin directory. Once accepted, it can be installed from **Settings -> Community plugins -> Browse** inside Obsidian.

### Manual installation

Until the community directory submission is accepted:

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/viggomeesters/obsidian-html-page-viewer/releases/latest).
2. Create this folder in your vault: `.obsidian/plugins/html-page-viewer/`.
3. Put the downloaded files in that folder.
4. Reload Obsidian.
5. Enable **HTML Page Viewer** in **Settings -> Community plugins**.

### BRAT installation

For beta testing, install the plugin with [BRAT](https://github.com/TfTHacker/obsidian42-brat) using this repository URL:

```text
https://github.com/viggomeesters/obsidian-html-page-viewer
```

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

## Release process

Obsidian installs community plugin files from GitHub releases. For each release:

1. Update `manifest.json`, `package.json`, and `versions.json`.
2. Run `npm install`, `npm run build`, `npx tsc --noEmit`, and `npm test`.
3. Create a GitHub release whose tag exactly matches `manifest.json.version`.
4. Attach `main.js`, `manifest.json`, and `styles.css` as release assets.

The repository includes a GitHub Actions release workflow with artifact attestation support. If GitHub Actions is disabled for the owner account, manual releases are still usable for Obsidian, but the Community automated review may show a recommendation about missing artifact attestations.

## Community directory submission

The repository is prepared for Obsidian Community plugin submission. The remaining submission step must be completed by the repository owner in the Obsidian Community site because it requires signing in, linking GitHub, and confirming the developer policies/support commitment.

Submit this repository URL:

```text
https://github.com/viggomeesters/obsidian-html-page-viewer
```

Steps:

1. Sign in to [community.obsidian.md](https://community.obsidian.md).
2. Link the GitHub account that owns this repository.
3. Open **Plugins -> New plugin**.
4. Enter the repository URL above.
5. Confirm the developer policies and submit.
6. Address any automated review feedback.

The current release is ready for review:

- root `README.md`, `LICENSE`, and `manifest.json` exist
- `manifest.json.version` is `0.2.0`
- a GitHub release whose tag matches `manifest.json.version` must exist before submission
- release assets include `main.js`, `manifest.json`, and `styles.css`
- `versions.json` maps supported Obsidian versions

Official references:

- [Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin)
- [Obsidian releases repository](https://github.com/obsidianmd/obsidian-releases)

## Acknowledgements

HTML Page Viewer was built independently, but it was informed by the existing Obsidian HTML viewer ecosystem, including the MIT-licensed [JiaLinZhang24/obsidian-html-viewer](https://github.com/JiaLinZhang24/obsidian-html-viewer). No source code from that project is included in this repository.

## License

[MIT](LICENSE)
