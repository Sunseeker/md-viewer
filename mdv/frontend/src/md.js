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

// ---- markdown-it instance ----

let mdInstance = null;

function getMarkdownIt() {
  if (mdInstance) return mdInstance;
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
  md.use(markdownItAnchor);
  md.use(markdownItTaskLists);

  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const rawInfo = token.info ? token.info.trim() : "";
    const langToken = rawInfo.split(/\s+/)[0] || "";
    const code = token.content;
    const escaped = escapeHtml(code);

    if (langToken.toLowerCase() === "mermaid") {
      return `<div class="mermaid-block"><pre class="mermaid-source" hidden>${escaped}</pre><div class="mermaid-render">Rendering diagram…</div></div>\n`;
    }

    const lang = normalizeLang(langToken);
    if (lang) {
      return `<pre class="shiki-pending" data-lang="${lang}"><code>${escaped}</code></pre>\n`;
    }
    return `<pre><code>${escaped}</code></pre>\n`;
  };

  md.renderer.rules.table_open = () => '<div class="table-wrap"><table>\n';
  md.renderer.rules.table_close = () => "</table></div>\n";

  mdInstance = md;
  return md;
}

export function renderMarkdownBody(body) {
  return getMarkdownIt().render(body);
}

// ---- frontmatter ----

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

export function splitFrontmatter(raw) {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return { raw: null, body: raw, data: null, error: null };
  const yamlText = match[1];
  const body = raw.slice(match[0].length);
  try {
    const data = loadYaml(yamlText);
    const isObj = data != null && typeof data === "object" && !Array.isArray(data);
    return { raw: yamlText, body, data: isObj ? data : null, error: null };
  } catch (err) {
    return { raw: yamlText, body, data: null, error: (err && err.message) || String(err) };
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
