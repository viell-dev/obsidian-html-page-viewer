# Changelog

All notable changes to HTML Page Viewer are documented here.

## 0.2.0 - 2026-09-01

- Add local asset support: the rendered preview now rewrites local references to Obsidian resource
  URLs, so vault-stored images, stylesheets, scripts, media, and SVG references display inside the
  sandboxed iframe.
- Resolve relative paths (including `.`/`..`), vault-absolute paths, percent-encoded names, and
  Obsidian shortest-path links (for example attachments stored in a configured attachment folder).
- Rewrite `src`, `href`, `srcset`, `poster`, `object` `data`, SVG `href`/`xlink:href`, inline
  `style` attributes, `<style>` blocks, and CSS `@import` references.
- Respect `<base href>`: documents with an external base URL are left untouched, and a local base
  path changes the resolution root.
- Show a note in the security strip with the number of local links resolved for the current
  preview.
- Fall back to the previous direct resource-path loading if rewriting fails.
- Add a local-assets test fixture and a unit test suite for the path translation logic.

## 0.1.1 - 2026-06-07

- Remove the redundant product name from the manifest description for Community review compatibility.

## 0.1.0 - 2026-06-07

- Initial public release.
- Add read-only `.html` and `.htm` file view.
- Add sandboxed rendered preview with scripts disabled by default.
- Add per-viewer Scripts OFF/ON toggle that never grants same-origin, forms, popups, or top-level navigation.
- Add rendered/source toggle, manual refresh, empty/error states, and lightweight HTML syntax highlighting.
