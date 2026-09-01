export interface LocalAssetHost {
  /** Resource URL for an existing vault file path, or null when no file exists there. */
  getResourceUrl(vaultPath: string): string | null;
  /** Obsidian link-text resolution (shortest path match), returning a vault file path. */
  resolveLink(linkText: string, fromPath: string): string | null;
}

export interface RewriteResult {
  html: string;
  assetCount: number;
}

const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const CSS_URL_PATTERN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s][^)]*?))\s*\)/g;
const CSS_IMPORT_PATTERN = /@import\s+(?:"([^"]*)"|'([^']*)')/g;

const SRC_SELECTOR =
  "img[src], script[src], source[src], video[src], audio[src], embed[src], track[src], input[src], iframe[src]";
const HREF_SELECTOR = "link[href], a[href]";
const SRCSET_SELECTOR = "img[srcset], source[srcset]";
const SVG_REFERENCE_SELECTOR = "image, use";

export function isLocalUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value || value.startsWith("#") || value.startsWith("//")) return false;
  return !SCHEME_PATTERN.test(value);
}

/** Collapses `.` and `..` segments; returns null when the path escapes the vault root. */
export function normalizeVaultPath(path: string): string | null {
  const segments: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.join("/");
}

export function parentDir(vaultPath: string): string {
  const index = vaultPath.lastIndexOf("/");
  return index === -1 ? "" : vaultPath.slice(0, index);
}

export function resolveAssetUrl(
  raw: string,
  ownerDir: string,
  fromPath: string,
  host: LocalAssetHost,
): string | null {
  if (!isLocalUrl(raw)) return null;

  const value = raw.trim();
  const hashIndex = value.indexOf("#");
  const fragment = hashIndex === -1 ? "" : value.slice(hashIndex);
  const suffixIndex = findSuffixIndex(value);
  const decoded = safeDecode(value.slice(0, suffixIndex));
  if (!decoded) return null;

  const direct = decoded.startsWith("/")
    ? normalizeVaultPath(decoded)
    : normalizeVaultPath(ownerDir ? `${ownerDir}/${decoded}` : decoded);
  let resourceUrl = direct ? host.getResourceUrl(direct) : null;

  if (!resourceUrl) {
    const linkText = decoded.replace(/^\/+/, "");
    const linked = linkText ? host.resolveLink(linkText, fromPath) : null;
    resourceUrl = linked ? host.getResourceUrl(linked) : null;
  }

  return resourceUrl ? `${resourceUrl}${fragment}` : null;
}

export function rewriteSrcset(
  value: string,
  ownerDir: string,
  fromPath: string,
  host: LocalAssetHost,
  onRewrite: () => void,
): string {
  return value
    .split(",")
    .map((entry) => {
      const trimmed = entry.trim();
      if (!trimmed) return trimmed;
      const [url, ...descriptor] = trimmed.split(/\s+/);
      const resolved = resolveAssetUrl(url, ownerDir, fromPath, host);
      if (!resolved) return trimmed;
      onRewrite();
      return [resolved, ...descriptor].join(" ");
    })
    .filter((entry) => entry)
    .join(", ");
}

export function rewriteCssUrls(
  css: string,
  ownerDir: string,
  fromPath: string,
  host: LocalAssetHost,
  onRewrite: () => void,
): string {
  const withUrls = css.replace(CSS_URL_PATTERN, (match, doubleQuoted, singleQuoted, bare) => {
    const resolved = resolveAssetUrl(doubleQuoted ?? singleQuoted ?? bare, ownerDir, fromPath, host);
    if (!resolved) return match;
    onRewrite();
    return `url("${resolved}")`;
  });
  return withUrls.replace(CSS_IMPORT_PATTERN, (match, doubleQuoted, singleQuoted) => {
    const resolved = resolveAssetUrl(doubleQuoted ?? singleQuoted, ownerDir, fromPath, host);
    if (!resolved) return match;
    onRewrite();
    return `@import "${resolved}"`;
  });
}

/**
 * Rewrites every local vault reference in an HTML document to an Obsidian resource URL so the
 * page can render inside a sandboxed srcdoc iframe. Untouched documents are returned verbatim.
 */
export function rewriteLocalAssets(
  data: string,
  htmlPath: string,
  host: LocalAssetHost,
): RewriteResult {
  const doc = new DOMParser().parseFromString(data, "text/html");
  let ownerDir = parentDir(htmlPath);

  const base = doc.querySelector("base[href]");
  if (base) {
    const baseHref = (base.getAttribute("href") ?? "").trim();
    if (!isLocalUrl(baseHref)) {
      // Relative references target the external base URL, not the vault.
      return { html: data, assetCount: 0 };
    }
    const baseDir = baseHref.startsWith("/")
      ? normalizeVaultPath(baseHref)
      : normalizeVaultPath(ownerDir ? `${ownerDir}/${baseHref}` : baseHref);
    if (baseDir === null) {
      return { html: data, assetCount: 0 };
    }
    ownerDir = baseDir;
    base.remove();
  }

  let assetCount = 0;
  const onRewrite = (): void => {
    assetCount += 1;
  };
  const rewriteAttribute = (element: Element, attribute: string): void => {
    const value = element.getAttribute(attribute);
    if (value === null) return;
    const resolved = resolveAssetUrl(value, ownerDir, htmlPath, host);
    if (!resolved) return;
    element.setAttribute(attribute, resolved);
    onRewrite();
  };

  doc.querySelectorAll(SRC_SELECTOR).forEach((element) => rewriteAttribute(element, "src"));
  doc.querySelectorAll(HREF_SELECTOR).forEach((element) => rewriteAttribute(element, "href"));
  doc.querySelectorAll(SVG_REFERENCE_SELECTOR).forEach((element) => {
    rewriteAttribute(element, "href");
    rewriteAttribute(element, "xlink:href");
  });
  doc.querySelectorAll("video[poster]").forEach((element) => rewriteAttribute(element, "poster"));
  doc.querySelectorAll("object[data]").forEach((element) => rewriteAttribute(element, "data"));
  doc.querySelectorAll(SRCSET_SELECTOR).forEach((element) => {
    const value = element.getAttribute("srcset");
    if (value === null) return;
    element.setAttribute("srcset", rewriteSrcset(value, ownerDir, htmlPath, host, onRewrite));
  });
  doc.querySelectorAll("style").forEach((element) => {
    const css = element.textContent;
    if (css === null) return;
    element.textContent = rewriteCssUrls(css, ownerDir, htmlPath, host, onRewrite);
  });
  doc.querySelectorAll("[style]").forEach((element) => {
    const css = element.getAttribute("style");
    if (css === null) return;
    element.setAttribute("style", rewriteCssUrls(css, ownerDir, htmlPath, host, onRewrite));
  });

  if (assetCount === 0 && !base) {
    return { html: data, assetCount: 0 };
  }

  const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>\n` : "";
  return { html: `${doctype}${doc.documentElement.outerHTML}`, assetCount };
}

function findSuffixIndex(value: string): number {
  const queryIndex = value.indexOf("?");
  const hashIndex = value.indexOf("#");
  if (queryIndex === -1) return hashIndex === -1 ? value.length : hashIndex;
  if (hashIndex === -1) return queryIndex;
  return Math.min(queryIndex, hashIndex);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
