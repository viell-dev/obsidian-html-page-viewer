# Contributing

Thanks for helping improve HTML Page Viewer.

## Local setup

```bash
npm install
npm run build
npx tsc --noEmit
npm test
```

For manual testing, copy the repository into `.obsidian/plugins/html-page-viewer/` in a test vault, reload Obsidian, and open `.html` and `.htm` files.

## Pull requests

- Keep the plugin read-only.
- Keep scripts disabled by default.
- Do not add network APIs in plugin code unless the security model and README are updated.
- Do not add clipboard access without an explicit user action and documentation.
- Run build, typecheck, and smoke tests before opening a PR.

This repository is a personal fork and publishes no releases; see the README's fork notice.
