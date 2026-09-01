import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

import esbuild from "esbuild";

mkdirSync("dist", { recursive: true });
await esbuild.build({
  bundle: true,
  entryPoints: ["src/local-assets.ts"],
  format: "esm",
  logLevel: "silent",
  outfile: "dist/local-assets.test.mjs",
  platform: "neutral",
  target: "es2022",
});

const {
  isLocalUrl,
  normalizeVaultPath,
  parentDir,
  resolveAssetUrl,
  rewriteCssUrls,
  rewriteSrcset,
} = await import(pathToFileURL("dist/local-assets.test.mjs"));

const vaultFiles = new Set([
  "reports/img/chart.png",
  "reports/img/chart@2x.png",
  "reports/style.css",
  "reports/spaced name.png",
  "attachments/logo.svg",
  "root.png",
]);

const host = {
  getResourceUrl: (vaultPath) =>
    vaultFiles.has(vaultPath) ? `app://vault/${vaultPath}?123` : null,
  resolveLink: (linkText, fromPath) => {
    for (const path of vaultFiles) {
      if (path === linkText || path.endsWith(`/${linkText}`)) return path;
    }
    return null;
  },
};

const resolve = (raw) => resolveAssetUrl(raw, "reports", "reports/page.html", host);

const assertions = [
  // URL classification
  [isLocalUrl("img/chart.png"), "relative path is local"],
  [isLocalUrl("/root.png"), "vault-absolute path is local"],
  [!isLocalUrl("https://example.com/a.png"), "https URL is not local"],
  [!isLocalUrl("data:image/png;base64,AAAA"), "data URL is not local"],
  [!isLocalUrl("//cdn.example.com/a.png"), "protocol-relative URL is not local"],
  [!isLocalUrl("#section"), "fragment-only URL is not local"],
  [!isLocalUrl("mailto:me@example.com"), "mailto URL is not local"],
  [!isLocalUrl(""), "empty URL is not local"],

  // Path normalization
  [normalizeVaultPath("a/./b/../c") === "a/c", "dot segments collapse"],
  [normalizeVaultPath("../escape.png") === null, "paths escaping the vault are rejected"],
  [normalizeVaultPath("a//b") === "a/b", "duplicate separators collapse"],
  [parentDir("reports/page.html") === "reports", "parent dir of nested file"],
  [parentDir("page.html") === "", "parent dir of root file is empty"],

  // Resolution against the vault
  [resolve("img/chart.png") === "app://vault/reports/img/chart.png?123", "relative asset resolves"],
  [resolve("./img/chart.png") === "app://vault/reports/img/chart.png?123", "explicit ./ resolves"],
  [resolve("../root.png") === "app://vault/root.png?123", "parent traversal inside vault resolves"],
  [resolve("/attachments/logo.svg") === "app://vault/attachments/logo.svg?123", "vault-absolute path resolves"],
  [resolve("spaced%20name.png") === "app://vault/reports/spaced name.png?123", "percent-encoded name resolves"],
  [resolve("img/chart.png#top") === "app://vault/reports/img/chart.png?123#top", "fragment survives resolution"],
  [resolve("img/chart.png?v=1") === "app://vault/reports/img/chart.png?123", "query string is dropped"],
  [resolve("logo.svg") === "app://vault/attachments/logo.svg?123", "shortest-path link resolution fallback"],
  [resolve("missing.png") === null, "unknown asset stays unresolved"],
  [resolve("https://example.com/a.png") === null, "external URL stays unresolved"],

  // srcset rewriting
  [
    rewriteSrcset(
      "img/chart.png 1x, img/chart@2x.png 2x, https://cdn.example.com/x.png 3x",
      "reports",
      "reports/page.html",
      host,
      () => {},
    ) ===
      "app://vault/reports/img/chart.png?123 1x, app://vault/reports/img/chart@2x.png?123 2x, https://cdn.example.com/x.png 3x",
    "srcset rewrites local candidates and keeps external ones",
  ],

  // CSS rewriting
  [
    rewriteCssUrls("body { background: url('img/chart.png'); }", "reports", "reports/page.html", host, () => {}) ===
      'body { background: url("app://vault/reports/img/chart.png?123"); }',
    "quoted css url() rewrites",
  ],
  [
    rewriteCssUrls("body { background: url(img/chart.png); }", "reports", "reports/page.html", host, () => {}) ===
      'body { background: url("app://vault/reports/img/chart.png?123"); }',
    "bare css url() rewrites",
  ],
  [
    rewriteCssUrls('@import "style.css";', "reports", "reports/page.html", host, () => {}) ===
      '@import "app://vault/reports/style.css?123";',
    "css @import string rewrites",
  ],
  [
    rewriteCssUrls("body { background: url(https://cdn.example.com/x.png); }", "reports", "reports/page.html", host, () => {}) ===
      "body { background: url(https://cdn.example.com/x.png); }",
    "external css url() is untouched",
  ],
];

let rewriteCount = 0;
rewriteCssUrls("a { background: url(img/chart.png) } b { background: url(nope.png) }", "reports", "reports/page.html", host, () => {
  rewriteCount += 1;
});
assertions.push([rewriteCount === 1, "rewrite callback fires once per resolved css url"]);

const failures = assertions.filter(([passes]) => !passes).map(([, label]) => label);

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL: ${failure}`);
  }
  process.exit(1);
}

console.log(`Local asset checks passed (${assertions.length} assertions).`);
