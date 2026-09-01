# Changelog

All notable changes to HTML Page Viewer are documented here.

## 0.2.0 - 2026-09-01

- Add local asset support: the rendered preview now inlines local references as `data:` URIs, so
  vault-stored images, stylesheets, scripts, media, and SVG references display inside the
  sandboxed iframe. Inlining is required because the sandbox's opaque origin cannot use responses
  from Obsidian's `app://` resource URLs.
- Cap inlining at 8 MiB per file; larger files fall back to Obsidian resource URLs.
- Resolve relative paths (including `.`/`..`), vault-absolute paths, percent-encoded names, and
  Obsidian shortest-path links (for example attachments stored in a configured attachment folder).
- Rewrite `src`, `href`, `srcset`, `poster`, `object` `data`, SVG `href`/`xlink:href`, inline
  `style` attributes, `<style>` blocks, and CSS `@import` references.
- Respect `<base href>`: documents with an external base URL are left untouched, and a local base
  path changes the resolution root.
- Show a note in the security strip with the number of local links resolved for the current
  preview.
- Add a settings tab: asset loading mode ("Inline assets" data URIs vs "Direct vault links" with
  `allow-same-origin` granted and scripts unconditionally disabled), the JavaScript setting
  (moved from the per-view toolbar), a comma-separated list of element types the rewriting runs
  on, and the maximum inline size.
- Leave references verbatim when they cannot be made to work: oversized files, unresolvable
  paths, and anchors in inline mode.
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
