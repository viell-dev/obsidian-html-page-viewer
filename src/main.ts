import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TextFileView,
  WorkspaceLeaf,
  debounce,
  setIcon,
} from "obsidian";

import {
  AssetMode,
  DEFAULT_REWRITE_TAGS,
  LocalAssetHost,
  MAX_INLINE_BYTES,
  RewriteOptions,
  RewriteResult,
  parseTagList,
  rewriteLocalAssets,
} from "./local-assets";

const VIEW_TYPE_HTML_PAGE_VIEWER = "html-page-viewer";
const HTML_EXTENSIONS = ["html", "htm"];

type ViewMode = "rendered" | "source";

export interface HtmlPageViewerSettings {
  assetMode: AssetMode;
  enableScripts: boolean;
  rewriteTags: string;
  maxInlineMib: number;
}

const DEFAULT_SETTINGS: HtmlPageViewerSettings = {
  assetMode: "inline",
  enableScripts: false,
  rewriteTags: DEFAULT_REWRITE_TAGS.join(", "),
  maxInlineMib: MAX_INLINE_BYTES / (1024 * 1024),
};

export default class HtmlPageViewerPlugin extends Plugin {
  settings: HtmlPageViewerSettings = { ...DEFAULT_SETTINGS };

  private readonly queueViewRefresh = debounce(() => this.refreshViews(), 400);

  async onload(): Promise<void> {
    await this.loadSettings();
    this.registerView(
      VIEW_TYPE_HTML_PAGE_VIEWER,
      (leaf) => new HtmlPageViewerView(leaf, this),
    );
    this.registerExtensions(HTML_EXTENSIONS, VIEW_TYPE_HTML_PAGE_VIEWER);
    this.addSettingTab(new HtmlPageViewerSettingTab(this.app, this));

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

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.queueViewRefresh();
  }

  refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_HTML_PAGE_VIEWER)) {
      const view = leaf.view;
      if (view instanceof HtmlPageViewerView) {
        view.refresh();
      }
    }
  }
}

class HtmlPageViewerView extends TextFileView {
  private readonly plugin: HtmlPageViewerPlugin;
  private mode: ViewMode = "rendered";
  private iframe: HTMLIFrameElement | null = null;
  private renderVersion = 0;

  constructor(leaf: WorkspaceLeaf, plugin: HtmlPageViewerPlugin) {
    super(leaf);
    this.plugin = plugin;
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

  refresh(): void {
    this.render();
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

    const settings = this.plugin.settings;
    const direct = settings.assetMode === "direct";
    const scriptsEnabled = !direct && settings.enableScripts;
    const security = container.createDiv({ cls: "html-page-viewer__security" });
    security.createSpan({
      cls: "html-page-viewer__security-pill",
      text: direct ? "Same-origin" : scriptsEnabled ? "Scripts ON" : "Scripts OFF",
    });
    security.createSpan({
      text: direct
        ? "Sandbox grants same-origin access so direct vault links can load; scripts, forms, popups, and top navigation remain blocked."
        : scriptsEnabled
          ? "Sandbox allows scripts only; forms, popups, top navigation, and same-origin access remain blocked."
          : "Sandbox blocks scripts, forms, popups, top navigation, and same-origin access.",
    });

    if (this.mode === "source") {
      renderSource(container, this.data);
      return;
    }

    const assetsNote = security.createSpan({ cls: "html-page-viewer__assets-note" });
    this.renderIframe(container, this.file, assetsNote);
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
  }

  private renderIframe(parent: HTMLElement, file: TFile, assetsNote: HTMLElement): void {
    const frameWrap = parent.createDiv({ cls: "html-page-viewer__frame-wrap" });
    const iframe = frameWrap.createEl("iframe", {
      cls: "html-page-viewer__frame",
      attr: {
        title: file.name,
        referrerpolicy: "no-referrer",
      },
    });
    iframe.setAttribute("sandbox", sandboxValue(this.plugin.settings));
    this.iframe = iframe;
    void this.populatePreview(iframe, file, ++this.renderVersion, assetsNote);
  }

  private async populatePreview(
    iframe: HTMLIFrameElement,
    file: TFile,
    version: number,
    assetsNote: HTMLElement,
  ): Promise<void> {
    let preview: RewriteResult | null = null;
    try {
      preview = await rewriteLocalAssets(
        this.data,
        file.path,
        this.createAssetHost(),
        this.rewriteOptions(),
      );
    } catch (error) {
      console.error("HTML Page Viewer: local asset rewrite failed, loading file directly", error);
    }

    if (version !== this.renderVersion || !iframe.isConnected) return;

    if (preview) {
      iframe.srcdoc = preview.html;
      if (preview.assetCount > 0) {
        assetsNote.setText(
          `${preview.assetCount} local vault ${preview.assetCount === 1 ? "link" : "links"} resolved for this preview.`,
        );
      }
    } else {
      iframe.src = withCacheBust(this.app.vault.getResourcePath(file));
    }
  }

  private rewriteOptions(): RewriteOptions {
    const settings = this.plugin.settings;
    return {
      mode: settings.assetMode,
      tags: parseTagList(settings.rewriteTags),
      maxInlineBytes: settings.maxInlineMib * 1024 * 1024,
    };
  }

  private createAssetHost(): LocalAssetHost {
    const findFile = (vaultPath: string): TFile | null => {
      const target = this.app.vault.getAbstractFileByPath(vaultPath);
      return target instanceof TFile ? target : null;
    };
    return {
      getFileSize: (vaultPath) => findFile(vaultPath)?.stat.size ?? null,
      getResourceUrl: (vaultPath) => {
        const target = findFile(vaultPath);
        return target ? this.app.vault.getResourcePath(target) : null;
      },
      resolveLink: (linkText, fromPath) =>
        this.app.metadataCache.getFirstLinkpathDest(linkText, fromPath)?.path ?? null,
      readBinary: async (vaultPath) => {
        const target = findFile(vaultPath);
        return target ? this.app.vault.readBinary(target) : null;
      },
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

class HtmlPageViewerSettingTab extends PluginSettingTab {
  private readonly plugin: HtmlPageViewerPlugin;

  constructor(app: App, plugin: HtmlPageViewerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Asset loading mode")
      .setDesc(
        "How local vault references are made to render inside the sandbox. Inline assets embeds them as data: URIs under the strictest sandbox. Direct vault links grants the preview same-origin access so Obsidian resource URLs load directly; JavaScript is always disabled in that mode.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("inline", "Inline assets (recommended)")
          .addOption("direct", "Direct vault links (same-origin, scripts disabled)")
          .setValue(this.plugin.settings.assetMode)
          .onChange(async (value) => {
            this.plugin.settings.assetMode = value === "direct" ? "direct" : "inline";
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("Enable JavaScript")
      .setDesc(
        "Adds allow-scripts to the sandbox for rendered previews. Available only in inline mode; scripts are never combined with same-origin access.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableScripts)
          .setDisabled(this.plugin.settings.assetMode === "direct")
          .onChange(async (value) => {
            this.plugin.settings.enableScripts = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Rewritten elements")
      .setDesc(
        'Comma-separated element types the URL rewriting runs on. Supported: a, audio, embed, iframe, image, img, input, link, object, script, source, style, track, use, video. "style" covers style blocks and style attributes. Clear the list to disable rewriting.',
      )
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_REWRITE_TAGS.join(", "))
          .setValue(this.plugin.settings.rewriteTags)
          .onChange(async (value) => {
            this.plugin.settings.rewriteTags = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Maximum inline size (MiB)")
      .setDesc("Inline mode leaves files larger than this untouched instead of embedding them.")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.maxInlineMib))
          .setValue(String(this.plugin.settings.maxInlineMib))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed <= 0) return;
            this.plugin.settings.maxInlineMib = parsed;
            await this.plugin.saveSettings();
          }),
      );
  }
}

export function sandboxValue(
  settings: Pick<HtmlPageViewerSettings, "assetMode" | "enableScripts">,
): string {
  // Never combine with allow-scripts: a same-origin srcdoc inherits Obsidian's own origin, and
  // scripts there could reach the app object and, on desktop, Node via the parent window.
  if (settings.assetMode === "direct") return "allow-same-origin";
  return settings.enableScripts ? "allow-scripts" : "";
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
