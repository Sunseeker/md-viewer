import "./styles.css";
import { getZero } from "./bridge.js";
import {
  splitFrontmatter,
  renderMarkdownBody,
  renderFrontmatterHtml,
  upgradeCodeBlocks,
  upgradeMermaidBlocks,
  refreshMermaidTheme,
  collectHeadings,
  basename,
  resolveRelativePath,
  escapeHtml,
} from "./md.js";

const zero = getZero();

const els = {
  banner: document.getElementById("banner"),
  doc: document.getElementById("doc"),
  filename: document.getElementById("filename"),
  frontmatter: document.getElementById("frontmatter"),
  content: document.getElementById("content"),
  empty: document.getElementById("empty"),
  toc: document.getElementById("toc"),
};

let currentPath = null;
let currentMtime = 0;
let unreadableStreak = 0;
let mermaidEntries = [];
let statTimer = null;
let pendingTimer = null;

// ---- scroll preservation ----

function captureScrollAnchor() {
  const headings = els.content.querySelectorAll("h1[id], h2[id], h3[id]");
  let anchor = null;
  for (const h of headings) {
    const rect = h.getBoundingClientRect();
    if (rect.top <= 0) {
      anchor = { id: h.id, offset: -rect.top };
    } else {
      break;
    }
  }
  if (anchor) return anchor;
  const doc = document.documentElement;
  const scrollable = doc.scrollHeight - doc.clientHeight;
  return { ratio: scrollable > 0 ? window.scrollY / scrollable : 0 };
}

function restoreScrollAnchor(anchor) {
  if (!anchor) return;
  if (anchor.id) {
    const el = document.getElementById(anchor.id);
    if (el) {
      const rect = el.getBoundingClientRect();
      window.scrollTo({ top: window.scrollY + rect.top + anchor.offset });
      return;
    }
  }
  if (typeof anchor.ratio === "number") {
    const doc = document.documentElement;
    const scrollable = doc.scrollHeight - doc.clientHeight;
    window.scrollTo({ top: scrollable * anchor.ratio });
  }
}

// ---- rendering ----

async function renderPath(path, { preserveScroll } = { preserveScroll: false }) {
  const anchor = preserveScroll ? captureScrollAnchor() : null;

  const fm = splitFrontmatter(await readableContent(path));
  els.frontmatter.innerHTML = renderFrontmatterHtml(fm);
  els.content.innerHTML = renderMarkdownBody(fm.body);

  await upgradeCodeBlocks(els.content);
  mermaidEntries = await upgradeMermaidBlocks(els.content);

  renderToc(collectHeadings(els.content));

  if (preserveScroll) restoreScrollAnchor(anchor);
}

// Reads path and updates currentMtime as a side effect; throws on error so
// callers can treat "unreadable" uniformly.
async function readableContent(path) {
  const res = await zero.invoke("mdv.read", { path });
  if (res.error) throw new Error(res.error);
  currentMtime = res.mtime;
  return res.content;
}

function showDoc(path) {
  els.empty.hidden = true;
  els.doc.hidden = false;
  els.filename.textContent = basename(path);
}

function showBanner() {
  els.banner.hidden = false;
  els.banner.textContent = "file unavailable — watching for it to return";
}

function hideBanner() {
  if (!els.banner.hidden) els.banner.hidden = true;
}

async function openInThisWindow(path) {
  currentPath = path;
  try {
    await renderPath(path, { preserveScroll: false });
  } catch (err) {
    showBanner();
    unreadableStreak = 2;
    startWatching();
    return;
  }
  showDoc(path);
  zero.os.addRecentDocument(path).catch(() => {});
  startWatching();
}

function startWatching() {
  if (statTimer) return;
  statTimer = setInterval(async () => {
    if (!currentPath) return;
    try {
      const st = await zero.invoke("mdv.stat", { path: currentPath });
      if (st.error) {
        unreadableStreak += 1;
        if (unreadableStreak >= 2) showBanner();
        return;
      }
      unreadableStreak = 0;
      hideBanner();
      if (st.mtime !== currentMtime) {
        try {
          await renderPath(currentPath, { preserveScroll: true });
        } catch (err) {
          unreadableStreak += 1;
          if (unreadableStreak >= 2) showBanner();
        }
      }
    } catch (err) {
      unreadableStreak += 1;
      if (unreadableStreak >= 2) showBanner();
    }
  }, 500);
}

// ---- window / doc dispatch ----

function newWindowLabel() {
  const id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random())).slice(0, 8);
  return `doc-${id}`;
}

async function openInNewWindow(path) {
  const created = await zero.windows.create({
    label: newWindowLabel(),
    title: basename(path),
    width: 860,
    height: 900,
    restoreState: false,
  });
  await zero.invoke("mdv.assign", { windowId: created.id, path });
}

async function dispatchPaths(paths) {
  for (const path of paths) {
    await openInNewWindow(path);
  }
}

async function pollPending() {
  try {
    const res = await zero.invoke("mdv.pending", {});
    const paths = (res && res.paths) || [];
    if (paths.length === 0) return;
    if (currentPath === null) {
      const [first, ...rest] = paths;
      await openInThisWindow(first);
      await dispatchPaths(rest);
    } else {
      await dispatchPaths(paths);
    }
  } catch (err) {
    // transient bridge hiccup -- retry next tick
  }
}

function startPendingPoll() {
  if (pendingTimer) return;
  pendingTimer = setInterval(pollPending, 400);
  pollPending();
}

async function boot() {
  try {
    const claimed = await zero.invoke("mdv.claim", {});
    if (claimed && claimed.path) {
      await openInThisWindow(claimed.path);
    }
  } catch (err) {
    // no assignment yet; fall through to pending poll
  }
  startPendingPoll();
}

// ---- TOC popover ----

function renderToc(headings) {
  if (headings.length === 0) {
    els.toc.innerHTML = "";
    return;
  }
  els.toc.innerHTML = headings
    .map((h) => `<div class="toc-item toc-level-${h.level}" data-id="${escapeHtml(h.id)}">${escapeHtml(h.text)}</div>`)
    .join("");
}

function openToc() {
  if (!els.toc.innerHTML) return;
  els.toc.hidden = false;
  requestAnimationFrame(() => els.toc.classList.add("open"));
}

function closeToc() {
  els.toc.classList.remove("open");
  els.toc.hidden = true;
}

function toggleToc() {
  if (els.toc.classList.contains("open")) closeToc();
  else openToc();
}

els.toc.addEventListener("click", (e) => {
  const item = e.target.closest(".toc-item");
  if (!item) return;
  const target = document.getElementById(item.dataset.id);
  if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  closeToc();
});

// ---- open dialog ----

async function openViaDialog() {
  const result = await zero.dialogs.openFile({
    title: "Open Markdown File",
    extensions: ["md", "markdown"],
    allowMultiple: false,
  });
  if (!result) return;
  const path = Array.isArray(result) ? result[0] : result;
  if (!path) return;
  if (currentPath === null) {
    await openInThisWindow(path);
  } else {
    await openInNewWindow(path);
  }
}

// ---- keyboard shortcuts ----

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeToc();
    return;
  }
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const key = e.key.toLowerCase();
  if (key === "o" && e.shiftKey) {
    e.preventDefault();
    toggleToc();
  } else if (key === "o") {
    e.preventDefault();
    openViaDialog();
  }
});

// ---- link interception ----

els.content.addEventListener("click", (e) => {
  const anchor = e.target.closest("a");
  if (!anchor) return;
  const href = anchor.getAttribute("href");
  if (!href) return;

  if (/^https?:\/\//i.test(href)) {
    e.preventDefault();
    zero.os.openUrl(href).catch(() => {});
    return;
  }
  if (href.startsWith("#")) {
    e.preventDefault();
    const target = document.getElementById(href.slice(1));
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  e.preventDefault();
  const resolved = resolveRelativePath(currentPath || "", href);
  const pathOnly = href.split(/[?#]/)[0];
  if (/\.(md|markdown)$/i.test(pathOnly)) {
    openInNewWindow(resolved).catch(() => {});
  } else {
    zero.os.revealPath(resolved).catch(() => {});
  }
});

// ---- dark/light mermaid re-theme ----

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  refreshMermaidTheme(mermaidEntries).catch(() => {});
});

boot();
