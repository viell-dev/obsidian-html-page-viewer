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

export interface RewriteResult {
  html: string;
  assetCount: number;
}

/**
 * The sandboxed iframe never gets allow-same-origin, so its opaque origin cannot use responses
 * fetched from Obsidian's app:// resource URLs. Assets up to this size are therefore inlined as
 * data: URIs, which involve no fetch at all; larger files fall back to resource URLs.
 */
export const MAX_INLINE_BYTES = 8 * 1024 * 1024;

const MAX_CSS_IMPORT_DEPTH = 3;
const MAX_HTML_DEPTH = 2;

const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const CSS_URL_PATTERN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s][^)]*?))\s*\)/g;
const CSS_IMPORT_PATTERN =
  /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s][^)]*?))\s*\)|"([^"]*)"|'([^']*)')([^;]*);/g;

const INLINE_SRC_SELECTOR =
  "img[src], source[src], video[src], audio[src], embed[src], track[src], input[src]";
const SRCSET_SELECTOR = "img[srcset], source[srcset]";
const SVG_REFERENCE_SELECTOR = "image, use";

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

export function resolveAssetPath(
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

  const direct = decoded.startsWith("/")
    ? normalizeVaultPath(decoded)
    : normalizeVaultPath(ownerDir ? `${ownerDir}/${decoded}` : decoded);
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
): Promise<string | null> {
  const resolved = resolveAssetPath(raw, ownerDir, fromPath, host);
  if (!resolved) return null;

  const { vaultPath, fragment } = resolved;
  const size = host.getFileSize(vaultPath);
  if (size !== null && size <= MAX_INLINE_BYTES) {
    const data = await host.readBinary(vaultPath);
    if (data !== null) {
      return `data:${mimeTypeFor(vaultPath)};base64,${encodeBase64(data)}${fragment}`;
    }
  }

  const resourceUrl = host.getResourceUrl(vaultPath);
  return resourceUrl ? `${resourceUrl}${fragment}` : null;
}

export async function rewriteSrcset(
  value: string,
  ownerDir: string,
  fromPath: string,
  host: LocalAssetHost,
  onRewrite: () => void,
): Promise<string> {
  const entries = await Promise.all(
    value.split(",").map(async (entry) => {
      const trimmed = entry.trim();
      if (!trimmed) return trimmed;
      const [url, ...descriptor] = trimmed.split(/\s+/);
      const resolved = await resolveAssetData(url, ownerDir, fromPath, host);
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
  onRewrite: () => void,
  depth = 0,
): Promise<string> {
  const withImports = await replaceAsync(css, CSS_IMPORT_PATTERN, async (match) => {
    const raw = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];
    const condition = match[6] ?? "";
    if (depth >= MAX_CSS_IMPORT_DEPTH) return null;
    const resolved = resolveAssetPath(raw, ownerDir, fromPath, host);
    if (!resolved) return null;
    const text = await readTextAsset(resolved.vaultPath, host);
    if (text === null) return null;
    const rewritten = await rewriteCss(
      text,
      parentDir(resolved.vaultPath),
      resolved.vaultPath,
      host,
      onRewrite,
      depth + 1,
    );
    onRewrite();
    return `@import url("${textToDataUri("text/css", rewritten)}")${condition};`;
  });

  return replaceAsync(withImports, CSS_URL_PATTERN, async (match) => {
    const resolved = await resolveAssetData(
      match[1] ?? match[2] ?? match[3],
      ownerDir,
      fromPath,
      host,
    );
    if (!resolved) return null;
    onRewrite();
    return `url("${resolved}")`;
  });
}

/**
 * Inlines every local vault reference in an HTML document so the page can render inside a
 * sandboxed srcdoc iframe with an opaque origin. Untouched documents are returned verbatim.
 */
export async function rewriteLocalAssets(
  data: string,
  htmlPath: string,
  host: LocalAssetHost,
  depth = 0,
): Promise<RewriteResult> {
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
  const inlineAttribute = async (element: Element, attribute: string): Promise<void> => {
    const value = element.getAttribute(attribute);
    if (value === null) return;
    const resolved = await resolveAssetData(value, ownerDir, htmlPath, host);
    if (!resolved) return;
    element.setAttribute(attribute, resolved);
    onRewrite();
  };

  for (const element of Array.from(doc.querySelectorAll(INLINE_SRC_SELECTOR))) {
    await inlineAttribute(element, "src");
  }

  for (const element of Array.from(doc.querySelectorAll("script[src]"))) {
    const src = element.getAttribute("src");
    if (src === null) continue;
    const resolved = resolveAssetPath(src, ownerDir, htmlPath, host);
    if (!resolved) continue;
    const text = await readTextAsset(resolved.vaultPath, host);
    if (text === null) {
      await inlineAttribute(element, "src");
      continue;
    }
    element.removeAttribute("src");
    element.textContent = text.replace(/<\/script/gi, "<\\/script");
    onRewrite();
  }

  for (const element of Array.from(doc.querySelectorAll("iframe[src]"))) {
    const src = element.getAttribute("src");
    if (src === null) continue;
    const resolved = resolveAssetPath(src, ownerDir, htmlPath, host);
    if (resolved && mimeTypeFor(resolved.vaultPath) === "text/html" && depth < MAX_HTML_DEPTH) {
      const text = await readTextAsset(resolved.vaultPath, host);
      if (text !== null) {
        const nested = await rewriteLocalAssets(text, resolved.vaultPath, host, depth + 1);
        element.removeAttribute("src");
        element.setAttribute("srcdoc", nested.html);
        assetCount += nested.assetCount;
        onRewrite();
        continue;
      }
    }
    await inlineAttribute(element, "src");
  }

  for (const element of Array.from(doc.querySelectorAll("link[href]"))) {
    const rel = (element.getAttribute("rel") ?? "").toLowerCase();
    if (!rel.split(/\s+/).includes("stylesheet")) {
      await inlineAttribute(element, "href");
      continue;
    }
    const href = element.getAttribute("href");
    if (href === null) continue;
    const resolved = resolveAssetPath(href, ownerDir, htmlPath, host);
    if (!resolved) continue;
    const text = await readTextAsset(resolved.vaultPath, host);
    if (text === null) {
      await inlineAttribute(element, "href");
      continue;
    }
    const rewritten = await rewriteCss(
      text,
      parentDir(resolved.vaultPath),
      resolved.vaultPath,
      host,
      onRewrite,
      1,
    );
    const style = doc.createElement("style");
    const media = element.getAttribute("media");
    if (media) style.setAttribute("media", media);
    style.textContent = rewritten.replace(/<\/style/gi, "<\\/style");
    element.replaceWith(style);
    onRewrite();
  }

  for (const element of Array.from(doc.querySelectorAll("a[href]"))) {
    // Anchors navigate rather than embed; data: navigation is blocked, so use resource URLs.
    const value = element.getAttribute("href");
    if (value === null) continue;
    const resolved = resolveAssetUrl(value, ownerDir, htmlPath, host);
    if (!resolved) continue;
    element.setAttribute("href", resolved);
    onRewrite();
  }

  for (const element of Array.from(doc.querySelectorAll(SVG_REFERENCE_SELECTOR))) {
    await inlineAttribute(element, "href");
    await inlineAttribute(element, "xlink:href");
  }
  for (const element of Array.from(doc.querySelectorAll("video[poster]"))) {
    await inlineAttribute(element, "poster");
  }
  for (const element of Array.from(doc.querySelectorAll("object[data]"))) {
    await inlineAttribute(element, "data");
  }
  for (const element of Array.from(doc.querySelectorAll(SRCSET_SELECTOR))) {
    const value = element.getAttribute("srcset");
    if (value === null) continue;
    element.setAttribute("srcset", await rewriteSrcset(value, ownerDir, htmlPath, host, onRewrite));
  }
  for (const element of Array.from(doc.querySelectorAll("style"))) {
    const css = element.textContent;
    if (css === null) continue;
    element.textContent = await rewriteCss(css, ownerDir, htmlPath, host, onRewrite);
  }
  for (const element of Array.from(doc.querySelectorAll("[style]"))) {
    const css = element.getAttribute("style");
    if (css === null) continue;
    element.setAttribute("style", await rewriteCss(css, ownerDir, htmlPath, host, onRewrite));
  }

  if (assetCount === 0 && !base) {
    return { html: data, assetCount: 0 };
  }

  const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>\n` : "";
  return { html: `${doctype}${doc.documentElement.outerHTML}`, assetCount };
}

async function readTextAsset(vaultPath: string, host: LocalAssetHost): Promise<string | null> {
  const size = host.getFileSize(vaultPath);
  if (size === null || size > MAX_INLINE_BYTES) return null;
  const data = await host.readBinary(vaultPath);
  return data === null ? null : new TextDecoder("utf-8").decode(data);
}

function textToDataUri(mime: string, text: string): string {
  return `data:${mime};charset=utf-8;base64,${encodeBase64(new TextEncoder().encode(text))}`;
}

async function replaceAsync(
  input: string,
  pattern: RegExp,
  replacer: (match: RegExpMatchArray) => Promise<string | null>,
): Promise<string> {
  let result = "";
  let lastIndex = 0;
  for (const match of input.matchAll(pattern)) {
    const index = match.index ?? 0;
    const replacement = await replacer(match);
    result += input.slice(lastIndex, index);
    result += replacement ?? match[0];
    lastIndex = index + match[0].length;
  }
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
