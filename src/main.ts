import {
  Notice,
  Plugin,
  TFile,
  TextFileView,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";

import { LocalAssetHost, RewriteResult, rewriteLocalAssets } from "./local-assets";

const VIEW_TYPE_HTML_PAGE_VIEWER = "html-page-viewer";
const HTML_EXTENSIONS = ["html", "htm"];

type ViewMode = "rendered" | "source";

export default class HtmlPageViewerPlugin extends Plugin {
  async onload(): Promise<void> {
    this.registerView(
      VIEW_TYPE_HTML_PAGE_VIEWER,
      (leaf) => new HtmlPageViewerView(leaf),
    );
    this.registerExtensions(HTML_EXTENSIONS, VIEW_TYPE_HTML_PAGE_VIEWER);

    this.addCommand({
      id: "open-current-html-in-viewer",
      name: "Open current HTML file in viewer",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!isHtmlFile(file)) return false;

        if (!checking) {
          void this.openHtmlFile(file);
        }
        return true;
      },
    });
  }

  async openHtmlFile(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({
      type: VIEW_TYPE_HTML_PAGE_VIEWER,
      state: { file: file.path },
      active: true,
    });
  }
}

class HtmlPageViewerView extends TextFileView {
  private mode: ViewMode = "rendered";
  private scriptsEnabled = false;
  private iframe: HTMLIFrameElement | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_HTML_PAGE_VIEWER;
  }

  getDisplayText(): string {
    return this.file?.basename ?? "HTML page viewer";
  }

  getIcon(): string {
    return "file-code-2";
  }

  setViewData(data: string): void {
    this.data = data;
    this.render();
  }

  getViewData(): string {
    return this.data;
  }

  clear(): void {
    this.data = "";
    this.iframe = null;
    this.contentEl.empty();
  }

  private render(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("html-page-viewer");

    const header = container.createDiv({ cls: "html-page-viewer__header" });
    this.renderTitle(header);
    this.renderToolbar(header);

    if (!this.file) {
      renderMessage(container, "No HTML file is attached to this viewer.");
      return;
    }

    if (!isHtmlFile(this.file)) {
      renderMessage(container, "This viewer only supports .html and .htm files.");
      return;
    }

    if (!this.data.trim()) {
      renderMessage(container, "This HTML file is empty.");
      return;
    }

    const preview = this.mode === "rendered" ? this.buildPreview(this.file) : null;

    const security = container.createDiv({ cls: "html-page-viewer__security" });
    security.createSpan({
      cls: "html-page-viewer__security-pill",
      text: this.scriptsEnabled ? "Scripts ON" : "Scripts OFF",
    });
    security.createSpan({
      text: this.scriptsEnabled
        ? "Sandbox allows scripts only; forms, popups, top navigation, and same-origin access remain blocked."
        : "Sandbox blocks scripts, forms, popups, top navigation, and same-origin access.",
    });
    if (preview && preview.assetCount > 0) {
      security.createSpan({
        cls: "html-page-viewer__assets-note",
        text: `${preview.assetCount} local vault ${preview.assetCount === 1 ? "link" : "links"} resolved for this preview.`,
      });
    }

    if (this.mode === "source") {
      renderSource(container, this.data);
      return;
    }

    this.renderIframe(container, this.file, preview);
  }

  private renderTitle(parent: HTMLElement): void {
    const title = parent.createDiv({ cls: "html-page-viewer__title" });
    title.createDiv({
      cls: "html-page-viewer__filename",
      text: this.file?.name ?? "HTML file",
    });
    title.createDiv({
      cls: "html-page-viewer__path",
      text: this.file?.path ?? "",
    });
  }

  private renderToolbar(parent: HTMLElement): void {
    const toolbar = parent.createDiv({ cls: "html-page-viewer__toolbar" });
    const modeGroup = toolbar.createDiv({
      cls: "html-page-viewer__segmented",
      attr: { "aria-label": "View mode" },
    });
    const renderedButton = createTextButton(modeGroup, "Rendered");
    const sourceButton = createTextButton(modeGroup, "Source");
    renderedButton.toggleClass("is-active", this.mode === "rendered");
    sourceButton.toggleClass("is-active", this.mode === "source");

    renderedButton.addEventListener("click", () => {
      this.mode = "rendered";
      this.render();
    });
    sourceButton.addEventListener("click", () => {
      this.mode = "source";
      this.render();
    });

    const refreshButton = createIconButton(toolbar, "refresh-cw", "Refresh preview");
    refreshButton.addEventListener("click", () => {
      void this.reloadFile();
    });

    const scriptsButton = createTextButton(toolbar, this.scriptsEnabled ? "Scripts ON" : "Scripts OFF");
    scriptsButton.addClass("html-page-viewer__scripts-toggle");
    scriptsButton.toggleClass("is-enabled", this.scriptsEnabled);
    scriptsButton.setAttribute("aria-pressed", String(this.scriptsEnabled));
    scriptsButton.setAttribute("title", "Toggle JavaScript for this viewer tab");
    scriptsButton.addEventListener("click", () => {
      this.scriptsEnabled = !this.scriptsEnabled;
      this.render();
    });
  }

  private renderIframe(parent: HTMLElement, file: TFile, preview: RewriteResult | null): void {
    const frameWrap = parent.createDiv({ cls: "html-page-viewer__frame-wrap" });
    const iframe = frameWrap.createEl("iframe", {
      cls: "html-page-viewer__frame",
      attr: {
        title: file.name,
        referrerpolicy: "no-referrer",
      },
    });
    iframe.setAttribute("sandbox", sandboxValue(this.scriptsEnabled));
    if (preview) {
      iframe.srcdoc = preview.html;
    } else {
      iframe.src = withCacheBust(this.app.vault.getResourcePath(file));
    }
    this.iframe = iframe;
  }

  private buildPreview(file: TFile): RewriteResult | null {
    try {
      return rewriteLocalAssets(this.data, file.path, this.createAssetHost());
    } catch (error) {
      console.error("HTML Page Viewer: local asset rewrite failed, loading file directly", error);
      return null;
    }
  }

  private createAssetHost(): LocalAssetHost {
    return {
      getResourceUrl: (vaultPath) => {
        const target = this.app.vault.getAbstractFileByPath(vaultPath);
        return target instanceof TFile ? this.app.vault.getResourcePath(target) : null;
      },
      resolveLink: (linkText, fromPath) =>
        this.app.metadataCache.getFirstLinkpathDest(linkText, fromPath)?.path ?? null,
    };
  }

  private async reloadFile(): Promise<void> {
    if (!this.file) {
      new Notice("No HTML file to refresh");
      return;
    }

    try {
      this.data = await this.app.vault.read(this.file);
      this.render();
    } catch (error) {
      this.contentEl.empty();
      this.contentEl.addClass("html-page-viewer");
      renderMessage(this.contentEl, `Unable to read HTML file: ${getErrorMessage(error)}`);
    }
  }
}

export function sandboxValue(scriptsEnabled: boolean): string {
  return scriptsEnabled ? "allow-scripts" : "";
}

function renderSource(parent: HTMLElement, data: string): void {
  const source = parent.createDiv({ cls: "html-page-viewer__source" });
  const pre = source.createEl("pre");
  data.split("\n").forEach((line, index) => {
    const lineEl = pre.createDiv({ cls: "html-page-viewer__source-line" });
    lineEl.createSpan({ cls: "html-page-viewer__line-number", text: String(index + 1) });
    const code = lineEl.createSpan({ cls: "html-page-viewer__source-code" });
    highlightHtmlLine(code, line);
  });
}

function highlightHtmlLine(parent: HTMLElement, line: string): void {
  let cursor = 0;

  while (cursor < line.length) {
    const commentStart = line.indexOf("<!--", cursor);
    const tagStart = line.indexOf("<", cursor);
    const nextStart = nextTokenStart(commentStart, tagStart);

    if (nextStart === -1) {
      parent.appendText(line.slice(cursor));
      return;
    }

    if (nextStart > cursor) {
      parent.appendText(line.slice(cursor, nextStart));
    }

    if (nextStart === commentStart) {
      const commentEnd = line.indexOf("-->", commentStart + 4);
      const end = commentEnd === -1 ? line.length : commentEnd + 3;
      parent.createSpan({
        cls: "html-page-viewer__tok-comment",
        text: line.slice(commentStart, end),
      });
      cursor = end;
      continue;
    }

    const tagEnd = line.indexOf(">", tagStart + 1);
    const end = tagEnd === -1 ? line.length : tagEnd + 1;
    highlightTag(parent, line.slice(tagStart, end));
    cursor = end;
  }
}

function nextTokenStart(commentStart: number, tagStart: number): number {
  if (commentStart === -1) return tagStart;
  if (tagStart === -1) return commentStart;
  return Math.min(commentStart, tagStart);
}

function highlightTag(parent: HTMLElement, tag: string): void {
  let cursor = 0;
  const tagName = tag.match(/^<\s*\/?\s*([A-Za-z][A-Za-z0-9:._-]*)/);

  if (!tagName) {
    parent.createSpan({ cls: "html-page-viewer__tok-punctuation", text: tag });
    return;
  }

  const matchIndex = tagName.index ?? 0;
  const nameStart = matchIndex + tagName[0].lastIndexOf(tagName[1]);
  const nameEnd = nameStart + tagName[1].length;
  parent.createSpan({ cls: "html-page-viewer__tok-punctuation", text: tag.slice(0, nameStart) });
  parent.createSpan({ cls: "html-page-viewer__tok-tag", text: tag.slice(nameStart, nameEnd) });
  cursor = nameEnd;

  while (cursor < tag.length) {
    const attr = nextAttributeToken(tag, cursor);
    if (!attr) {
      parent.createSpan({ cls: "html-page-viewer__tok-punctuation", text: tag.slice(cursor) });
      return;
    }

    if (attr.start > cursor) {
      parent.createSpan({ cls: "html-page-viewer__tok-punctuation", text: tag.slice(cursor, attr.start) });
    }
    parent.createSpan({ cls: "html-page-viewer__tok-attr", text: attr.name });
    if (attr.value) {
      parent.createSpan({ cls: "html-page-viewer__tok-punctuation", text: attr.separator });
      parent.createSpan({ cls: "html-page-viewer__tok-string", text: attr.value });
    }
    cursor = attr.end;
  }
}

function nextAttributeToken(
  tag: string,
  start: number,
): { start: number; end: number; name: string; separator: string; value: string } | null {
  let cursor = start;
  while (cursor < tag.length && /\s/.test(tag[cursor])) cursor += 1;
  if (cursor >= tag.length || tag[cursor] === ">" || tag[cursor] === "/") return null;

  const nameStart = cursor;
  while (cursor < tag.length && isAttributeNameChar(tag[cursor])) cursor += 1;
  if (cursor === nameStart) return null;

  const name = tag.slice(nameStart, cursor);
  let separator = "";
  let value = "";

  while (cursor < tag.length && /\s/.test(tag[cursor])) cursor += 1;
  if (tag[cursor] === "=") {
    const separatorStart = cursor;
    cursor += 1;
    while (cursor < tag.length && /\s/.test(tag[cursor])) cursor += 1;
    separator = tag.slice(separatorStart, cursor);

    if (tag[cursor] === "\"" || tag[cursor] === "'") {
      const quote = tag[cursor];
      const valueStart = cursor;
      cursor += 1;
      while (cursor < tag.length && tag[cursor] !== quote) cursor += 1;
      if (cursor < tag.length) cursor += 1;
      value = tag.slice(valueStart, cursor);
    } else {
      const valueStart = cursor;
      while (cursor < tag.length && !/\s|>/.test(tag[cursor])) cursor += 1;
      value = tag.slice(valueStart, cursor);
    }
  }

  return { start: nameStart, end: cursor, name, separator, value };
}

function isAttributeNameChar(char: string): boolean {
  return /[A-Za-z0-9:._-]/.test(char);
}

function createIconButton(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
  const button = parent.createEl("button", {
    cls: "clickable-icon html-page-viewer__button",
    attr: { "aria-label": label, title: label, type: "button" },
  });
  setIcon(button, icon);
  return button;
}

function createTextButton(parent: HTMLElement, label: string): HTMLButtonElement {
  return parent.createEl("button", {
    cls: "html-page-viewer__text-button",
    text: label,
    attr: { type: "button" },
  });
}

function renderMessage(parent: HTMLElement, message: string): void {
  parent.createDiv({ cls: "html-page-viewer__message", text: message });
}

function withCacheBust(url: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}html-page-viewer-refresh=${Date.now()}`;
}

function isHtmlFile(file: TFile | null): file is TFile {
  return Boolean(file && HTML_EXTENSIONS.includes(file.extension.toLowerCase()));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
