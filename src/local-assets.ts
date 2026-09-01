export interface LocalAssetHost {
  /** Size in bytes for an existing vault file path, or null when no file exists there. */
  getFileSize(vaultPath: string): number | null;
  /** Resource URL for an existing vault file path, or null when no file exists there. */
  getResourceUrl(vaultPath: string): string | null;
  /** Obsidian link-text resolution (shortest path match), returning a vault file path. */
  resolveLink(linkText: string, fromPath: string): string | null;
  /** File contents for an existing vault file path, or null when it cannot be read. */
  readBinary(vaultPath: string): Promise<ArrayBuffer | null>;
}

export type AssetMode = "inline" | "direct";

export interface SandboxSettings {
  assetMode: AssetMode;
  enableScripts: boolean;
}

export interface RewriteOptions {
  /**
   * "inline" embeds assets as data: URIs, the only form the opaque-origin sandbox can use.
   * "direct" translates to Obsidian resource URLs, which render only when the iframe is granted
   * allow-same-origin (and therefore never allow-scripts).
   */
  mode: AssetMode;
  /** Element types (lowercase tag names) the rewriting runs on; "style" also covers style attributes. */
  tags: ReadonlySet<string>;
  /** Inline mode leaves files larger than this untouched instead of embedding them. */
  maxInlineBytes: number;
}

export interface RewriteResult {
  html: string;
  assetCount: number;
}

/**
 * The sandboxed iframe never gets allow-same-origin in inline mode, so its opaque origin cannot
 * use responses fetched from Obsidian's app:// resource URLs. Assets up to this size are
 * therefore inlined as data: URIs, which involve no fetch at all; larger files are left
 * untouched, because a rewritten URL that still cannot render is worse than the original.
 */
export const MAX_INLINE_BYTES = 8 * 1024 * 1024;

export const DEFAULT_REWRITE_TAGS: readonly string[] = [
  "a",
  "audio",
  "embed",
  "iframe",
  "image",
  "img",
  "input",
  "link",
  "object",
  "script",
  "source",
  "style",
  "track",
  "use",
  "video",
];

const MAX_CSS_IMPORT_DEPTH = 3;
const MAX_HTML_DEPTH = 2;

const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const CSS_URL_PATTERN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s][^)]*?))\s*\)/g;
const CSS_IMPORT_PATTERN =
  /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s][^)]*?))\s*\)|"([^"]*)"|'([^']*)')([^;]*);/g;

interface AttributeRewriteRule {
  selector: string;
  attributes: readonly string[];
  srcset?: boolean;
  directOnly?: boolean;
}

/**
 * Element/attribute pairs that are plain URL rewrites. Elements needing more than an attribute
 * swap (script inlining, iframe nesting, link-to-style conversion, style blocks) keep bespoke
 * handlers in rewriteLocalAssets.
 */
const ATTRIBUTE_REWRITES: readonly AttributeRewriteRule[] = [
  {
    selector: "img[src], source[src], video[src], audio[src], embed[src], track[src], input[src]",
    attributes: ["src"],
  },
  { selector: "img[srcset], source[srcset]", attributes: ["srcset"], srcset: true },
  { selector: "image, use", attributes: ["href", "xlink:href"] },
  { selector: "video[poster]", attributes: ["poster"] },
  { selector: "object[data]", attributes: ["data"] },
  // Anchors navigate rather than embed, and the opaque-origin sandbox refuses app:// navigation,
  // so inline mode leaves them verbatim.
  { selector: "a[href]", attributes: ["href"], directOnly: true },
];

const MIME_TYPES: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  css: "text/css",
  flac: "audio/flac",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  m4a: "audio/mp4",
  mjs: "text/javascript",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  otf: "font/otf",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  txt: "text/plain",
  vtt: "text/vtt",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
};

/**
 * Never combine with allow-scripts: a same-origin srcdoc inherits Obsidian's own origin, and
 * scripts there could reach the app object and, on desktop, Node via the parent window.
 */
export function sandboxValue(settings: SandboxSettings): string {
  if (settings.assetMode === "direct") return "allow-same-origin";
  return settings.enableScripts ? "allow-scripts" : "";
}

export function parseTagList(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry),
  );
}

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

export function mimeTypeFor(vaultPath: string): string {
  const dotIndex = vaultPath.lastIndexOf(".");
  const extension = dotIndex === -1 ? "" : vaultPath.slice(dotIndex + 1).toLowerCase();
  return MIME_TYPES[extension] ?? "application/octet-stream";
}

export function encodeBase64(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/** Resolves a leading-slash path against the vault root, anything else against ownerDir. */
function resolveAgainstDir(ownerDir: string, path: string): string | null {
  return path.startsWith("/")
    ? normalizeVaultPath(path)
    : normalizeVaultPath(ownerDir ? `${ownerDir}/${path}` : path);
}

function resolveAssetPath(
  raw: string,
  ownerDir: string,
  fromPath: string,
  host: LocalAssetHost,
): { vaultPath: string; fragment: string } | null {
  if (!isLocalUrl(raw)) return null;

  const value = raw.trim();
  const hashIndex = value.indexOf("#");
  const fragment = hashIndex === -1 ? "" : value.slice(hashIndex);
  const suffixIndex = findSuffixIndex(value);
  const decoded = safeDecode(value.slice(0, suffixIndex));
  if (!decoded) return null;

  const direct = resolveAgainstDir(ownerDir, decoded);
  if (direct && host.getFileSize(direct) !== null) {
    return { vaultPath: direct, fragment };
  }

  const linkText = decoded.replace(/^\/+/, "");
  const linked = linkText ? host.resolveLink(linkText, fromPath) : null;
  return linked ? { vaultPath: linked, fragment } : null;
}

export function resolveAssetUrl(
  raw: string,
  ownerDir: string,
  fromPath: string,
  host: LocalAssetHost,
): string | null {
  const resolved = resolveAssetPath(raw, ownerDir, fromPath, host);
  if (!resolved) return null;
  const resourceUrl = host.getResourceUrl(resolved.vaultPath);
  return resourceUrl ? `${resourceUrl}${resolved.fragment}` : null;
}

export async function resolveAssetData(
  raw: string,
  ownerDir: string,
  fromPath: string,
  host: LocalAssetHost,
  maxInlineBytes = MAX_INLINE_BYTES,
): Promise<string | null> {
  const resolved = resolveAssetPath(raw, ownerDir, fromPath, host);
  if (!resolved) return null;
  const data = await readAssetBytes(resolved.vaultPath, host, maxInlineBytes);
  if (data === null) return null;
  return `data:${mimeTypeFor(resolved.vaultPath)};base64,${encodeBase64(data)}${resolved.fragment}`;
}

async function resolveAssetRef(
  raw: string,
  ownerDir: string,
  fromPath: string,
  host: LocalAssetHost,
  options: RewriteOptions,
): Promise<string | null> {
  return options.mode === "direct"
    ? resolveAssetUrl(raw, ownerDir, fromPath, host)
    : resolveAssetData(raw, ownerDir, fromPath, host, options.maxInlineBytes);
}

export async function rewriteSrcset(
  value: string,
  ownerDir: string,
  fromPath: string,
  host: LocalAssetHost,
  options: RewriteOptions,
  onRewrite: () => void,
): Promise<string> {
  const entries = await Promise.all(
    value.split(",").map(async (entry) => {
      const trimmed = entry.trim();
      if (!trimmed) return trimmed;
      const [url, ...descriptor] = trimmed.split(/\s+/);
      const resolved = await resolveAssetRef(url, ownerDir, fromPath, host, options);
      if (!resolved) return trimmed;
      onRewrite();
      return [resolved, ...descriptor].join(" ");
    }),
  );
  return entries.filter((entry) => entry).join(", ");
}

export async function rewriteCss(
  css: string,
  ownerDir: string,
  fromPath: string,
  host: LocalAssetHost,
  options: RewriteOptions,
  onRewrite: () => void,
  depth = 0,
): Promise<string> {
  const withImports = await replaceAsync(css, CSS_IMPORT_PATTERN, async (match) => {
    const raw = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];
    const condition = match[6] ?? "";
    if (options.mode === "direct") {
      const resolved = resolveAssetUrl(raw, ownerDir, fromPath, host);
      if (!resolved) return null;
      onRewrite();
      return `@import url("${resolved}")${condition};`;
    }
    if (depth >= MAX_CSS_IMPORT_DEPTH) return null;
    const resolved = resolveAssetPath(raw, ownerDir, fromPath, host);
    if (!resolved) return null;
    const text = await readTextAsset(resolved.vaultPath, host, options.maxInlineBytes);
    if (text === null) return null;
    const rewritten = await rewriteCss(
      text,
      parentDir(resolved.vaultPath),
      resolved.vaultPath,
      host,
      options,
      onRewrite,
      depth + 1,
    );
    onRewrite();
    // Inlining as a data: stylesheet rather than splicing the text keeps @import semantics
    // (media and supports() conditions) intact, at ~33% base64 overhead per nesting level.
    return `@import url("${textToDataUri("text/css", rewritten)}")${condition};`;
  });

  return replaceAsync(withImports, CSS_URL_PATTERN, async (match) => {
    const resolved = await resolveAssetRef(
      match[1] ?? match[2] ?? match[3],
      ownerDir,
      fromPath,
      host,
      options,
    );
    if (!resolved) return null;
    onRewrite();
    return `url("${resolved}")`;
  });
}

/**
 * Rewrites local vault references in an HTML document so the page can render inside the
 * sandboxed srcdoc iframe. References that cannot be made to work (unresolvable, oversized in
 * inline mode, or anchors/scripts the sandbox would refuse anyway) are left verbatim.
 * Untouched documents are returned verbatim.
 */
export async function rewriteLocalAssets(
  data: string,
  htmlPath: string,
  host: LocalAssetHost,
  options: RewriteOptions,
  depth = 0,
): Promise<RewriteResult> {
  host = cacheAssetReads(host);
  const doc = new DOMParser().parseFromString(data, "text/html");
  let ownerDir = parentDir(htmlPath);

  const base = doc.querySelector("base[href]");
  if (base) {
    const baseHref = (base.getAttribute("href") ?? "").trim();
    if (!isLocalUrl(baseHref)) {
      // Relative references target the external base URL, not the vault.
      return { html: data, assetCount: 0 };
    }
    const baseDir = resolveAgainstDir(ownerDir, baseHref);
    if (baseDir === null) {
      return { html: data, assetCount: 0 };
    }
    ownerDir = baseDir;
    base.remove();
  }

  const enabled = (tag: string): boolean => options.tags.has(tag);
  let assetCount = 0;
  const onRewrite = (): void => {
    assetCount += 1;
  };
  const rewriteRef = async (element: Element, attribute: string): Promise<void> => {
    const value = element.getAttribute(attribute);
    if (value === null) return;
    const resolved = await resolveAssetRef(value, ownerDir, htmlPath, host, options);
    if (!resolved) return;
    element.setAttribute(attribute, resolved);
    onRewrite();
  };

  for (const rule of ATTRIBUTE_REWRITES) {
    if (rule.directOnly && options.mode !== "direct") continue;
    for (const element of Array.from(doc.querySelectorAll(rule.selector))) {
      if (!enabled(element.tagName.toLowerCase())) continue;
      for (const attribute of rule.attributes) {
        if (!rule.srcset) {
          await rewriteRef(element, attribute);
          continue;
        }
        const value = element.getAttribute(attribute);
        if (value === null) continue;
        element.setAttribute(
          attribute,
          await rewriteSrcset(value, ownerDir, htmlPath, host, options, onRewrite),
        );
      }
    }
  }

  if (enabled("script") && options.mode === "inline") {
    // Direct mode never grants allow-scripts, so scripts are left verbatim there.
    for (const element of Array.from(doc.querySelectorAll("script[src]"))) {
      const src = element.getAttribute("src");
      if (src === null) continue;
      const resolved = resolveAssetPath(src, ownerDir, htmlPath, host);
      if (!resolved) continue;
      const text = await readTextAsset(resolved.vaultPath, host, options.maxInlineBytes);
      if (text === null) continue;
      element.removeAttribute("src");
      element.textContent = escapeClosingTag(text, "script");
      onRewrite();
    }
  }

  if (enabled("iframe")) {
    for (const element of Array.from(doc.querySelectorAll("iframe[src]"))) {
      const src = element.getAttribute("src");
      if (src === null) continue;
      if (options.mode === "direct") {
        await rewriteRef(element, "src");
        continue;
      }
      const resolved = resolveAssetPath(src, ownerDir, htmlPath, host);
      if (!resolved || mimeTypeFor(resolved.vaultPath) !== "text/html" || depth >= MAX_HTML_DEPTH) {
        continue;
      }
      const text = await readTextAsset(resolved.vaultPath, host, options.maxInlineBytes);
      if (text === null) continue;
      const nested = await rewriteLocalAssets(text, resolved.vaultPath, host, options, depth + 1);
      element.removeAttribute("src");
      element.setAttribute("srcdoc", nested.html);
      assetCount += nested.assetCount;
      onRewrite();
    }
  }

  if (enabled("link")) {
    for (const element of Array.from(doc.querySelectorAll("link[href]"))) {
      const rel = (element.getAttribute("rel") ?? "").toLowerCase();
      if (options.mode === "direct" || !rel.split(/\s+/).includes("stylesheet")) {
        await rewriteRef(element, "href");
        continue;
      }
      const href = element.getAttribute("href");
      if (href === null) continue;
      const resolved = resolveAssetPath(href, ownerDir, htmlPath, host);
      if (!resolved) continue;
      const text = await readTextAsset(resolved.vaultPath, host, options.maxInlineBytes);
      if (text === null) continue;
      const rewritten = await rewriteCss(
        text,
        parentDir(resolved.vaultPath),
        resolved.vaultPath,
        host,
        options,
        onRewrite,
        1,
      );
      const style = doc.createElement("style");
      const media = element.getAttribute("media");
      if (media) style.setAttribute("media", media);
      style.textContent = escapeClosingTag(rewritten, "style");
      element.replaceWith(style);
      onRewrite();
    }
  }

  if (enabled("style")) {
    for (const element of Array.from(doc.querySelectorAll("style"))) {
      const css = element.textContent;
      if (css === null) continue;
      element.textContent = await rewriteCss(css, ownerDir, htmlPath, host, options, onRewrite);
    }
    for (const element of Array.from(doc.querySelectorAll("[style]"))) {
      const css = element.getAttribute("style");
      if (css === null) continue;
      element.setAttribute(
        "style",
        await rewriteCss(css, ownerDir, htmlPath, host, options, onRewrite),
      );
    }
  }

  if (assetCount === 0) {
    return { html: data, assetCount: 0 };
  }

  const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>\n` : "";
  return { html: `${doctype}${doc.documentElement.outerHTML}`, assetCount };
}

const cachedHosts = new WeakSet<LocalAssetHost>();

/**
 * Memoizes size lookups and file reads for one rewrite pass, so a document referencing the same
 * asset many times reads it once. Created fresh per top-level rewrite, so refreshes stay fresh.
 */
function cacheAssetReads(host: LocalAssetHost): LocalAssetHost {
  if (cachedHosts.has(host)) return host;
  const sizes = new Map<string, number | null>();
  const reads = new Map<string, Promise<ArrayBuffer | null>>();
  const cached: LocalAssetHost = {
    getFileSize: (vaultPath) => {
      if (!sizes.has(vaultPath)) sizes.set(vaultPath, host.getFileSize(vaultPath));
      return sizes.get(vaultPath) ?? null;
    },
    getResourceUrl: (vaultPath) => host.getResourceUrl(vaultPath),
    resolveLink: (linkText, fromPath) => host.resolveLink(linkText, fromPath),
    readBinary: (vaultPath) => {
      let read = reads.get(vaultPath);
      if (!read) {
        read = host.readBinary(vaultPath);
        reads.set(vaultPath, read);
      }
      return read;
    },
  };
  cachedHosts.add(cached);
  return cached;
}

async function readAssetBytes(
  vaultPath: string,
  host: LocalAssetHost,
  maxBytes: number,
): Promise<ArrayBuffer | null> {
  const size = host.getFileSize(vaultPath);
  if (size === null || size > maxBytes) return null;
  return host.readBinary(vaultPath);
}

async function readTextAsset(
  vaultPath: string,
  host: LocalAssetHost,
  maxInlineBytes: number,
): Promise<string | null> {
  const data = await readAssetBytes(vaultPath, host, maxInlineBytes);
  return data === null ? null : new TextDecoder("utf-8").decode(data);
}

function textToDataUri(mime: string, text: string): string {
  return `data:${mime};charset=utf-8;base64,${encodeBase64(new TextEncoder().encode(text))}`;
}

/** Keeps inlined content from terminating its host element; valid inside JS and CSS strings. */
function escapeClosingTag(text: string, tag: string): string {
  return text.replace(new RegExp(`</${tag}`, "gi"), `<\\/${tag}`);
}

async function replaceAsync(
  input: string,
  pattern: RegExp,
  replacer: (match: RegExpMatchArray) => Promise<string | null>,
): Promise<string> {
  const matches = Array.from(input.matchAll(pattern));
  const replacements = await Promise.all(matches.map((match) => replacer(match)));
  let result = "";
  let lastIndex = 0;
  matches.forEach((match, matchIndex) => {
    const index = match.index ?? 0;
    result += input.slice(lastIndex, index) + (replacements[matchIndex] ?? match[0]);
    lastIndex = index + match[0].length;
  });
  return result + input.slice(lastIndex);
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
