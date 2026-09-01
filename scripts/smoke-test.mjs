import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const main = fs.readFileSync("src/main.ts", "utf8");
const localAssets = fs.readFileSync("src/local-assets.ts", "utf8");
const styles = fs.readFileSync("styles.css", "utf8");
const staticFixture = fs.readFileSync("test-fixtures/static.html", "utf8");
const interactiveFixture = fs.readFileSync("test-fixtures/interactive.html", "utf8");
const localAssetsFixture = fs.readFileSync("test-fixtures/local-assets.html", "utf8");

const assertions = [
  [manifest.id === "html-page-viewer", "manifest id is html-page-viewer"],
  [manifest.version === "0.2.0", "manifest version is 0.2.0"],
  [main.includes("enableScripts: false"), "scripts default to off"],
  [main.includes("sandboxValue(this.plugin.settings)"), "iframe sandbox is derived from settings"],
  // sandboxValue's behavior (scripts never combined with same-origin) is asserted in
  // scripts/local-assets-test.mjs, which tests the function instead of grepping its source.
  [main.includes("renderSource(container, this.data)"), "source view code path exists"],
  [main.includes("iframe.srcdoc = preview.html"), "rendered view loads the rewritten document"],
  [main.includes("this.app.vault.getResourcePath(file)"), "direct vault resource path remains as fallback"],
  [main.includes("getFirstLinkpathDest"), "asset host uses Obsidian link resolution"],
  [localAssets.includes("SCHEME_PATTERN"), "asset rewriting skips URLs with explicit schemes"],
  [localAssets.includes("if (segments.length === 0) return null"), "paths escaping the vault root are rejected"],
  [localAssets.includes("MAX_INLINE_BYTES"), "assets are inlined with a size cap"],
  [localAssets.includes(";base64,"), "assets inline as base64 data URIs"],
  [!main.includes("navigator.clipboard"), "plugin code has no clipboard access"],
  [!localAssets.includes("navigator.clipboard"), "asset module has no clipboard access"],
  [!styles.includes("!important"), "styles do not use important overrides"],
  [staticFixture.includes("<!-- Static fixture"), "static fixture contains an HTML comment for source highlighting"],
  [interactiveFixture.includes("<script>"), "interactive fixture contains script for toggle testing"],
  [localAssetsFixture.includes("srcset="), "local assets fixture exercises srcset rewriting"],
];

const failures = assertions.filter(([passes]) => !passes).map(([, label]) => label);

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL: ${failure}`);
  }
  process.exit(1);
}

console.log("HTML Page Viewer smoke checks passed.");
