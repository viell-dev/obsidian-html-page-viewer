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
  DEFAULT_REWRITE_TAGS,
  MAX_INLINE_BYTES,
  encodeBase64,
  isLocalUrl,
  mimeTypeFor,
  normalizeVaultPath,
  parentDir,
  parseTagList,
  resolveAssetData,
  resolveAssetUrl,
  rewriteCss,
  rewriteSrcset,
  sandboxValue,
} = await import(pathToFileURL("dist/local-assets.test.mjs"));

const sandboxCombinations = [
  { assetMode: "inline", enableScripts: false },
  { assetMode: "inline", enableScripts: true },
  { assetMode: "direct", enableScripts: false },
  { assetMode: "direct", enableScripts: true },
];

const encoder = new TextEncoder();
const vaultFiles = new Map([
  ["reports/img/chart.png", { bytes: new Uint8Array([1, 2, 3]) }],
  ["reports/img/chart@2x.png", { bytes: new Uint8Array([4, 5, 6]) }],
  ["reports/style.css", { bytes: encoder.encode('.a { background: url("img/chart.png"); }') }],
  ["reports/huge.bin", { bytes: new Uint8Array([7]), size: MAX_INLINE_BYTES + 1 }],
  ["reports/spaced name.png", { bytes: new Uint8Array([8]) }],
  ["attachments/logo.svg", { bytes: encoder.encode("<svg/>") }],
  ["root.png", { bytes: new Uint8Array([9]) }],
]);

const host = {
  getFileSize: (vaultPath) => {
    const file = vaultFiles.get(vaultPath);
    return file ? file.size ?? file.bytes.length : null;
  },
  getResourceUrl: (vaultPath) =>
    vaultFiles.has(vaultPath) ? `app://vault/${vaultPath}?123` : null,
  resolveLink: (linkText) => {
    for (const path of vaultFiles.keys()) {
      if (path === linkText || path.endsWith(`/${linkText}`)) return path;
    }
    return null;
  },
  readBinary: async (vaultPath) => {
    const file = vaultFiles.get(vaultPath);
    return file ? file.bytes.buffer.slice(0) : null;
  },
};

const inlineOptions = {
  mode: "inline",
  tags: new Set(DEFAULT_REWRITE_TAGS),
  maxInlineBytes: MAX_INLINE_BYTES,
};
const directOptions = { ...inlineOptions, mode: "direct" };

const resolveUrl = (raw) => resolveAssetUrl(raw, "reports", "reports/page.html", host);
const resolveData = (raw) => resolveAssetData(raw, "reports", "reports/page.html", host);
const chartDataUri = "data:image/png;base64,AQID";

const assertions = [
  // Sandbox invariants
  [sandboxValue({ assetMode: "inline", enableScripts: false }) === "", "strict sandbox by default"],
  [sandboxValue({ assetMode: "inline", enableScripts: true }) === "allow-scripts", "inline mode can enable scripts"],
  [sandboxValue({ assetMode: "direct", enableScripts: false }) === "allow-same-origin", "direct mode grants same-origin"],
  [sandboxValue({ assetMode: "direct", enableScripts: true }) === "allow-same-origin", "direct mode ignores the scripts setting"],
  [
    sandboxCombinations.every((combination) => {
      const sandbox = sandboxValue(combination);
      return !(sandbox.includes("allow-scripts") && sandbox.includes("allow-same-origin"));
    }),
    "scripts and same-origin are never combined",
  ],

  // URL classification
  [isLocalUrl("img/chart.png"), "relative path is local"],
  [isLocalUrl("/root.png"), "vault-absolute path is local"],
  [!isLocalUrl("https://example.com/a.png"), "https URL is not local"],
  [!isLocalUrl("data:image/png;base64,AAAA"), "data URL is not local"],
  [!isLocalUrl("//cdn.example.com/a.png"), "protocol-relative URL is not local"],
  [!isLocalUrl("#section"), "fragment-only URL is not local"],
  [!isLocalUrl("mailto:me@example.com"), "mailto URL is not local"],
  [!isLocalUrl(""), "empty URL is not local"],

  // Tag list parsing
  [parseTagList("img, STYLE ,,link").size === 3, "tag list parses trimmed lowercase entries"],
  [parseTagList("img, STYLE").has("style"), "tag list lowercases entries"],
  [parseTagList("").size === 0, "empty tag list disables everything"],

  // Path normalization and helpers
  [normalizeVaultPath("a/./b/../c") === "a/c", "dot segments collapse"],
  [normalizeVaultPath("../escape.png") === null, "paths escaping the vault are rejected"],
  [normalizeVaultPath("a//b") === "a/b", "duplicate separators collapse"],
  [parentDir("reports/page.html") === "reports", "parent dir of nested file"],
  [parentDir("page.html") === "", "parent dir of root file is empty"],
  [mimeTypeFor("a/b.PNG") === "image/png", "mime lookup is case-insensitive"],
  [mimeTypeFor("a/b.unknown") === "application/octet-stream", "unknown extension gets octet-stream"],
  [encodeBase64(new Uint8Array([1, 2, 3])) === "AQID", "base64 encoding of bytes"],

  // Resource URL resolution (direct mode + anchors)
  [resolveUrl("img/chart.png") === "app://vault/reports/img/chart.png?123", "relative asset resolves to resource URL"],
  [resolveUrl("../root.png") === "app://vault/root.png?123", "parent traversal inside vault resolves"],
  [resolveUrl("/attachments/logo.svg") === "app://vault/attachments/logo.svg?123", "vault-absolute path resolves"],
  [resolveUrl("spaced%20name.png") === "app://vault/reports/spaced name.png?123", "percent-encoded name resolves"],
  [resolveUrl("logo.svg") === "app://vault/attachments/logo.svg?123", "shortest-path link resolution fallback"],
  [resolveUrl("missing.png") === null, "unknown asset stays unresolved"],
  [resolveUrl("https://example.com/a.png") === null, "external URL stays unresolved"],

  // Data URI inlining
  [(await resolveData("img/chart.png")) === chartDataUri, "relative asset inlines as data URI"],
  [(await resolveData("./img/chart.png")) === chartDataUri, "explicit ./ inlines"],
  [(await resolveData("img/chart.png#top")) === `${chartDataUri}#top`, "fragment survives inlining"],
  [(await resolveData("img/chart.png?v=1")) === chartDataUri, "query string is dropped"],
  [(await resolveData("logo.svg")) === `data:image/svg+xml;base64,${btoa("<svg/>")}`, "link-resolved asset inlines"],
  [(await resolveData("huge.bin")) === null, "oversized asset is left untouched, not rewritten"],
  [
    (await resolveAssetData("img/chart.png", "reports", "reports/page.html", host, 1)) === null,
    "custom size cap is honored",
  ],
  [(await resolveData("missing.png")) === null, "unknown asset stays unresolved for inlining"],
];

// srcset rewriting
assertions.push([
  (await rewriteSrcset(
    "img/chart.png 1x, img/chart@2x.png 2x, https://cdn.example.com/x.png 3x",
    "reports",
    "reports/page.html",
    host,
    inlineOptions,
    () => {},
  )) === `${chartDataUri} 1x, data:image/png;base64,BAUG 2x, https://cdn.example.com/x.png 3x`,
  "srcset inlines local candidates and keeps external ones",
]);

// CSS rewriting
const css = (input, options = inlineOptions) =>
  rewriteCss(input, "reports", "reports/page.html", host, options, () => {});
assertions.push(
  [
    (await css("body { background: url('img/chart.png'); }")) ===
      `body { background: url("${chartDataUri}"); }`,
    "quoted css url() inlines",
  ],
  [
    (await css("body { background: url(img/chart.png); }")) ===
      `body { background: url("${chartDataUri}"); }`,
    "bare css url() inlines",
  ],
  [
    (await css("body { background: url(https://cdn.example.com/x.png); }")) ===
      "body { background: url(https://cdn.example.com/x.png); }",
    "external css url() is untouched",
  ],
  [
    (await css("body { background: url(img/chart.png); }", directOptions)) ===
      'body { background: url("app://vault/reports/img/chart.png?123"); }',
    "direct mode css url() translates to resource URL",
  ],
  [
    (await css('@import "style.css" screen;', directOptions)) ===
      '@import url("app://vault/reports/style.css?123") screen;',
    "direct mode css @import translates to resource URL",
  ],
);

const imported = await css('@import "style.css" screen;');
const importedInner = /data:text\/css;charset=utf-8;base64,([A-Za-z0-9+/=]+)/.exec(imported);
assertions.push(
  [imported.startsWith('@import url("data:text/css;charset=utf-8;base64,'), "css @import inlines as data css"],
  [imported.endsWith('") screen;'), "css @import keeps its media condition"],
  [
    importedInner !== null && atob(importedInner[1]) === `.a { background: url("${chartDataUri}"); }`,
    "imported css has its own urls inlined relative to the css file",
  ],
);

let rewriteCount = 0;
await rewriteCss(
  "a { background: url(img/chart.png) } b { background: url(nope.png) }",
  "reports",
  "reports/page.html",
  host,
  inlineOptions,
  () => {
    rewriteCount += 1;
  },
);
assertions.push([rewriteCount === 1, "rewrite callback fires once per resolved css url"]);

const failures = assertions.filter(([passes]) => !passes).map(([, label]) => label);

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL: ${failure}`);
  }
  process.exit(1);
}

console.log(`Local asset checks passed (${assertions.length} assertions).`);
