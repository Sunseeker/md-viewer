// Rendering pipeline: YAML frontmatter, GFM markdown, lazy syntax
// highlighting (shiki), lazy Mermaid diagrams, and TOC/heading extraction.

import MarkdownIt from "markdown-it";
import markdownItAnchor from "markdown-it-anchor";
import markdownItTaskLists from "markdown-it-task-lists";
import { load as loadYaml } from "js-yaml";

const SUPPORTED_LANGS = [
  "javascript",
  "typescript",
  "python",
  "bash",
  "json",
  "yaml",
  "sql",
  "html",
  "css",
  "markdown",
  "diff",
  "zig",
];

const LANG_ALIASES = {
  js: "javascript",
  ts: "typescript",
  sh: "bash",
  shell: "bash",
  yml: "yaml",
  md: "markdown",
};

function normalizeLang(info) {
  const lang = (info || "").trim().split(/\s+/)[0].toLowerCase();
  if (!lang) return null;
  const resolved = LANG_ALIASES[lang] || lang;
  return SUPPORTED_LANGS.includes(resolved) ? resolved : null;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[c]);
}

// Reads the data-line / data-line-end attrs a custom render rule's token
// carries (stamped by the mdv_line_map core rule below) and renders them
// as HTML attributes on the root element that rule returns. Custom render
// rules bypass markdown-it's default attr renderer, so they have to splice
// these back in by hand.
function lineAttrsHtml(token) {
  const line = token.attrGet("data-line");
  if (line == null) return "";
  const lineEnd = token.attrGet("data-line-end");
  return ` data-line="${line}"${lineEnd != null ? ` data-line-end="${lineEnd}"` : ""}`;
}

// ---- markdown-it instance ----

let mdInstance = null;

function getMarkdownIt() {
  if (mdInstance) return mdInstance;
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
  md.use(markdownItAnchor);
  md.use(markdownItTaskLists);

  // Stamps every block token that carries a source-line range (token.map)
  // with data-line / data-line-end, 1-based and shifted by env.lineOffset
  // (the number of source lines the stripped frontmatter block consumed).
  // token.map is [startLine, endLine) 0-based, so 1-based start is
  // map[0]+1 and 1-based inclusive end is map[1] -- both offset the same
  // way. Runs after the "block" core rule has built state.tokens, so every
  // renderer rule (default or custom) sees the attrs already set.
  md.core.ruler.push("mdv_line_map", (state) => {
    const offset = (state.env && state.env.lineOffset) || 0;
    for (const token of state.tokens) {
      if (!token.map) continue;
      token.attrSet("data-line", String(token.map[0] + 1 + offset));
      token.attrSet("data-line-end", String(token.map[1] + offset));
    }
  });

  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const rawInfo = token.info ? token.info.trim() : "";
    const langToken = rawInfo.split(/\s+/)[0] || "";
    const code = token.content;
    const escaped = escapeHtml(code);
    const lineAttrs = lineAttrsHtml(token);

    if (langToken.toLowerCase() === "mermaid") {
      // data-line goes on the wrapper (the element actually reachable as a
      // direct child of #content), not the hidden source <pre> -- mirrors
      // the table_open wrapper below.
      return `<div class="mermaid-block"${lineAttrs}><pre class="mermaid-source" hidden>${escaped}</pre><div class="mermaid-render">Rendering diagram…</div></div>\n`;
    }

    // data-line lives on .code-block, not on the <pre> itself: <pre> keeps
    // overflow-x:auto for horizontal scroll, and a scrolling element clips
    // its own descendants (including a ::before positioned outside its box
    // via a negative left offset) -- the gutter number would render but
    // never be visible. The non-scrolling wrapper is the attribute host.
    const lang = normalizeLang(langToken);
    if (lang) {
      return `<div class="code-block"${lineAttrs}><pre class="shiki-pending" data-lang="${lang}"><code>${escaped}</code></pre></div>\n`;
    }
    return `<div class="code-block"${lineAttrs}><pre><code>${escaped}</code></pre></div>\n`;
  };

  // Same clipping reason as the code-block wrapper above: .table-wrap
  // carries data-line and must not scroll itself, so the horizontal
  // scroll lives on the inner .table-scroll instead.
  md.renderer.rules.table_open = (tokens, idx) => `<div class="table-wrap"${lineAttrsHtml(tokens[idx])}><div class="table-scroll"><table>\n`;
  md.renderer.rules.table_close = () => "</table></div></div>\n";

  mdInstance = md;
  return md;
}

export function renderMarkdownBody(body, lineOffset = 0) {
  return getMarkdownIt().render(body, { lineOffset });
}

// ---- frontmatter ----

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

export function splitFrontmatter(raw) {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return { raw: null, body: raw, data: null, error: null, lineOffset: 0 };
  const yamlText = match[1];
  const body = raw.slice(match[0].length);
  // Lines fully consumed by the matched frontmatter block (opening ---
  // through the newline after the closing ---), so body's own line 1 maps
  // back to lineOffset + 1 in the original file.
  const lineOffset = (match[0].match(/\n/g) || []).length;
  try {
    const data = loadYaml(yamlText);
    const isObj = data != null && typeof data === "object" && !Array.isArray(data);
    return { raw: yamlText, body, data: isObj ? data : null, error: null, lineOffset };
  } catch (err) {
    return { raw: yamlText, body, data: null, error: (err && err.message) || String(err), lineOffset };
  }
}

function truncate(value, max = 60) {
  const s = String(value);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function stringifyValue(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(stringifyValue).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function renderFrontmatterHtml(fm) {
  if (!fm) return "";
  if (fm.error) {
    return `<div class="frontmatter frontmatter-error">
      <div class="frontmatter-error-label">frontmatter (unparsed)</div>
      <pre><code>${escapeHtml(fm.raw || "")}</code></pre>
    </div>`;
  }
  if (!fm.data) return "";
  const entries = [];
  for (const [key, value] of Object.entries(fm.data)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [subKey, subValue] of Object.entries(value)) {
        entries.push([`${key}.${subKey}`, subValue]);
      }
    } else {
      entries.push([key, value]);
    }
  }
  if (entries.length === 0) return "";
  const chips = entries
    .map(([key, value]) => {
      const full = stringifyValue(value);
      const shown = truncate(full);
      return `<div class="chip"><div class="chip-key">${escapeHtml(key)}</div><div class="chip-value" title="${escapeHtml(full)}">${escapeHtml(shown)}</div></div>`;
    })
    .join("");
  return `<div class="frontmatter">${chips}</div>`;
}

// ---- syntax highlighting (shiki, lazy, JS regex engine -- no wasm) ----

let highlighterPromise = null;

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then(({ createHighlighter, createJavaScriptRegexEngine }) =>
      createHighlighter({
        themes: ["github-light", "github-dark"],
        langs: SUPPORTED_LANGS,
        engine: createJavaScriptRegexEngine(),
      }),
    );
  }
  return highlighterPromise;
}

export async function upgradeCodeBlocks(container) {
  const pending = container.querySelectorAll("pre.shiki-pending");
  if (pending.length === 0) return;
  let highlighter;
  try {
    highlighter = await getHighlighter();
  } catch (err) {
    return; // keep the plain escaped code blocks on load failure
  }
  for (const el of pending) {
    const lang = el.dataset.lang;
    const code = el.querySelector("code")?.textContent ?? "";
    try {
      const html = highlighter.codeToHtml(code, {
        lang,
        themes: { light: "github-light", dark: "github-dark" },
      });
      const wrapper = document.createElement("div");
      wrapper.innerHTML = html;
      const rendered = wrapper.firstElementChild;
      // data-line / data-line-end live on the surrounding .code-block, not
      // this <pre>, so replacing it in place is all that's needed -- no
      // attributes to carry over.
      if (rendered) el.replaceWith(rendered);
    } catch (err) {
      el.classList.remove("shiki-pending");
    }
  }
}

// ---- mermaid (lazy) ----

let mermaidPromise = null;
let mermaidSeq = 0;

function getMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => m.default || m);
  }
  return mermaidPromise;
}

export async function renderMermaidEntries(mermaid, entries) {
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral" });
  for (const { block, source } of entries) {
    const target = block.querySelector(".mermaid-render");
    if (!target) continue;
    const id = `mdv-mermaid-${mermaidSeq++}`;
    try {
      const { svg } = await mermaid.render(id, source);
      target.classList.remove("mermaid-error");
      target.innerHTML = svg;
    } catch (err) {
      const stray = document.getElementById(id);
      if (stray) stray.remove();
      target.classList.add("mermaid-error");
      target.innerHTML = `<pre><code>${escapeHtml(source)}</code></pre><p class="mermaid-error-note">Mermaid diagram could not be rendered.</p>`;
    }
  }
}

export async function upgradeMermaidBlocks(container) {
  const blocks = container.querySelectorAll(".mermaid-block");
  if (blocks.length === 0) return [];
  const entries = Array.from(blocks).map((block) => ({
    block,
    source: block.querySelector(".mermaid-source")?.textContent ?? "",
  }));
  try {
    const mermaid = await getMermaid();
    await renderMermaidEntries(mermaid, entries);
  } catch (err) {
    for (const { block, source } of entries) {
      const target = block.querySelector(".mermaid-render");
      if (target) target.innerHTML = `<pre><code>${escapeHtml(source)}</code></pre><p class="mermaid-error-note">Mermaid diagram could not be rendered.</p>`;
    }
  }
  return entries;
}

export async function refreshMermaidTheme(entries) {
  if (!entries || entries.length === 0) return;
  try {
    const mermaid = await getMermaid();
    await renderMermaidEntries(mermaid, entries);
  } catch (err) {
    // module already failed to load once; nothing more to do
  }
}

// ---- headings / TOC ----

export function collectHeadings(container) {
  const nodes = container.querySelectorAll("h1[id], h2[id], h3[id]");
  return Array.from(nodes).map((el) => ({
    id: el.id,
    text: el.textContent,
    level: Number(el.tagName.slice(1)),
  }));
}

// ---- path helpers ----

export function basename(path) {
  const clean = String(path).replace(/\/+$/, "");
  const parts = clean.split("/");
  return parts[parts.length - 1] || clean;
}

export function dirname(path) {
  const idx = String(path).lastIndexOf("/");
  return idx >= 0 ? path.slice(0, idx) : "";
}

function normalizePath(path, isAbsolute) {
  const parts = path.split("/");
  const out = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!isAbsolute) out.push("..");
      continue;
    }
    out.push(part);
  }
  return (isAbsolute ? "/" : "") + out.join("/");
}

export function resolveRelativePath(basePath, relPath) {
  if (relPath.startsWith("/")) return normalizePath(relPath, true);
  const base = dirname(basePath);
  return normalizePath(base ? `${base}/${relPath}` : relPath, base.startsWith("/"));
}
