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
  decorateSections();
  applyCollapse();

  // Re-render just replaced els.content.innerHTML, wiping any highlights --
  // rebuild them and land as close as possible to the previous position.
  if (!findEls.bar.hidden && findQuery) {
    const prevIndex = findIndex;
    runSearch(findQuery);
    if (findHits.length > 0) focusMatch(Math.max(0, Math.min(prevIndex, findHits.length - 1)));
  }

  if (preserveScroll) restoreScrollAnchor(anchor);
}

// Reads path in escape-bounded chunks (mdv.read caps a single response at
// 1 MiB) and updates currentMtime as a side effect; throws on error so
// callers can treat "unreadable" uniformly.
async function readableContent(path) {
  let restarts = 0;
  outer: while (true) {
    const parts = [];
    let offset = 0;
    let mtime = null;
    while (true) {
      const res = await zero.invoke("mdv.read", { path, offset });
      if (res.error) {
        const err = new Error(res.error);
        if (res.size != null) err.size = res.size;
        throw err;
      }
      if (mtime === null) {
        mtime = res.mtime;
      } else if (res.mtime !== mtime) {
        // file changed mid-read -- the chunks no longer agree; restart.
        restarts += 1;
        if (restarts > 5) throw new Error("unreadable");
        continue outer;
      }
      parts.push(res.content);
      if (res.eof) {
        currentMtime = mtime;
        return parts.join("");
      }
      if (!(res.next > offset)) throw new Error("unreadable");
      offset = res.next;
    }
  }
}

function showDoc(path) {
  els.empty.hidden = true;
  els.doc.hidden = false;
  els.filename.textContent = basename(path);
}

// A too-large file won't fix itself by waiting, so it gets its own text
// (with the actual size when the error carries one); every other failure
// keeps the generic "watching for it to return" message.
function bannerMessageFor(err) {
  if (err && err.message === "too_large") {
    if (err.size != null) {
      const mb = (err.size / (1024 * 1024)).toFixed(1);
      return `file is too large to display (${mb} MB; limit 32 MB)`;
    }
    return "file is too large to display";
  }
  return "file unavailable — watching for it to return";
}

function showBanner(message) {
  els.banner.hidden = false;
  els.banner.textContent = message;
}

function hideBanner() {
  if (!els.banner.hidden) els.banner.hidden = true;
}

async function openInThisWindow(path) {
  currentPath = path;
  try {
    await renderPath(path, { preserveScroll: false });
  } catch (err) {
    showBanner(bannerMessageFor(err));
    if (err && err.message === "too_large") {
      // A watcher left over from the previously open file would stat this
      // one successfully every tick, hideBanner() away the explanation, and
      // re-fail the render forever. Too-large won't fix itself: stop polling.
      stopWatching();
      return;
    }
    unreadableStreak = 2;
    startWatching();
    return;
  }
  showDoc(path);
  zero.os.addRecentDocument(path).catch(() => {});
  startWatching();
}

function stopWatching() {
  if (!statTimer) return;
  clearInterval(statTimer);
  statTimer = null;
}

function startWatching() {
  if (statTimer) return;
  statTimer = setInterval(async () => {
    if (!currentPath) return;
    try {
      const st = await zero.invoke("mdv.stat", { path: currentPath });
      if (st.error) {
        // mdv.stat only ever reports "unreadable" -- no err.message to select on.
        unreadableStreak += 1;
        if (unreadableStreak >= 2) showBanner(bannerMessageFor(null));
        return;
      }
      unreadableStreak = 0;
      hideBanner();
      if (st.mtime !== currentMtime) {
        try {
          await renderPath(currentPath, { preserveScroll: true });
        } catch (err) {
          unreadableStreak += 1;
          if (unreadableStreak >= 2) showBanner(bannerMessageFor(err));
        }
      }
    } catch (err) {
      unreadableStreak += 1;
      if (unreadableStreak >= 2) showBanner(bannerMessageFor(err));
    }
  }, 500);
}

// ---- doc dispatch: single-window, replace in place ----
//
// SDK 0.5.4's dynamic window.create hides the previous window on macOS
// (created windows also ignore the requested frame), so one-window-per-file
// is not viable yet. A newly opened file replaces the current document;
// Cmd+[ / Cmd+] walk the in-window history. Revisit when the SDK's
// multi-window surface matures.

const docHistory = [];
const docFuture = [];

async function openDoc(path, { remember } = { remember: true }) {
  if (path === currentPath) return;
  if (remember && currentPath) {
    docHistory.push(currentPath);
    docFuture.length = 0;
  }
  await openInThisWindow(path);
}

async function goBack() {
  if (docHistory.length === 0) return;
  const prev = docHistory.pop();
  if (currentPath) docFuture.push(currentPath);
  await openInThisWindow(prev);
}

async function goForward() {
  if (docFuture.length === 0) return;
  const next = docFuture.pop();
  if (currentPath) docHistory.push(currentPath);
  await openInThisWindow(next);
}

async function pollPending() {
  try {
    const res = await zero.invoke("mdv.pending", {});
    const paths = (res && res.paths) || [];
    if (paths.length === 0) return;
    // Newest open wins the window; earlier ones stay reachable via
    // history and File > Open Recent.
    for (const path of paths.slice(0, -1)) {
      zero.os.addRecentDocument(path).catch(() => {});
      if (path !== currentPath) docHistory.push(path);
    }
    await openDoc(paths[paths.length - 1]);
  } catch (err) {
    // transient bridge hiccup -- retry next tick
  }
}

function startPendingPoll() {
  if (pendingTimer) return;
  pendingTimer = setInterval(pollPending, 400);
  pollPending();
}

// ---- user config: fonts + sizing ----
// Source of truth is ~/.config/mdv/config.json. The settings panel (Cmd+,)
// applies edits instantly and persists them through mdv.configWrite; the
// 2s poll keeps external file edits working too.

const CFG_DEFAULTS = { fontFamily: "", monoFamily: "", fontSize: 17, lineHeight: 1.65, contentWidth: 72 };
const CFG_VARS = ["--mdv-font-body", "--mdv-font-mono", "--mdv-font-size", "--mdv-line-height", "--mdv-content-width"];
let cfgState = { ...CFG_DEFAULTS };
let configMtime = 0;

function applyConfigVars(cfg) {
  const root = document.documentElement.style;
  for (const v of CFG_VARS) root.removeProperty(v);
  if (typeof cfg.fontFamily === "string" && cfg.fontFamily) root.setProperty("--mdv-font-body", cfg.fontFamily);
  if (typeof cfg.monoFamily === "string" && cfg.monoFamily) root.setProperty("--mdv-font-mono", cfg.monoFamily);
  if (Number.isFinite(cfg.fontSize)) root.setProperty("--mdv-font-size", `${cfg.fontSize}px`);
  if (Number.isFinite(cfg.lineHeight)) root.setProperty("--mdv-line-height", String(cfg.lineHeight));
  if (Number.isFinite(cfg.contentWidth)) root.setProperty("--mdv-content-width", `${cfg.contentWidth}ch`);
}

function cfgFromParsed(parsed) {
  const cfg = { ...CFG_DEFAULTS };
  if (typeof parsed.fontFamily === "string") cfg.fontFamily = parsed.fontFamily;
  if (typeof parsed.monoFamily === "string") cfg.monoFamily = parsed.monoFamily;
  if (Number.isFinite(parsed.fontSize)) cfg.fontSize = parsed.fontSize;
  if (Number.isFinite(parsed.lineHeight)) cfg.lineHeight = parsed.lineHeight;
  if (Number.isFinite(parsed.contentWidth)) cfg.contentWidth = parsed.contentWidth;
  return cfg;
}

async function refreshConfig() {
  try {
    const res = await zero.invoke("mdv.config", {});
    if (!res || res.error) {
      if (configMtime !== 0) {
        configMtime = 0;
        cfgState = { ...CFG_DEFAULTS };
        applyConfigVars(cfgState);
      }
      return;
    }
    if (res.mtime === configMtime) return;
    configMtime = res.mtime;
    let parsed;
    try {
      parsed = JSON.parse(res.raw);
    } catch (err) {
      console.warn("mdv config is not valid JSON, ignoring");
      return;
    }
    cfgState = cfgFromParsed(parsed);
    applyConfigVars(cfgState);
  } catch (err) {
    // config is best-effort; defaults always work
  }
}

// ---- settings panel ----

const cfgEls = {
  panel: document.getElementById("settings"),
  fontFamily: document.getElementById("cfg-fontFamily"),
  monoFamily: document.getElementById("cfg-monoFamily"),
  fontSize: document.getElementById("cfg-fontSize"),
  lineHeight: document.getElementById("cfg-lineHeight"),
  contentWidth: document.getElementById("cfg-contentWidth"),
  reset: document.getElementById("cfg-reset"),
};

// Curated font choices; `probe` filters to fonts actually installed
// (document.fonts.check). Values are full CSS stacks so the config file
// stays portable and hand-editable.
const BODY_FONTS = [
  { label: "System (SF Pro)", value: "" },
  { label: "New York (serif)", value: "ui-serif, 'New York', Georgia, serif" },
  { label: "Charter", value: "Charter, Georgia, serif", probe: "Charter" },
  { label: "Georgia", value: "Georgia, serif", probe: "Georgia" },
  { label: "Iowan Old Style", value: "'Iowan Old Style', Georgia, serif", probe: "Iowan Old Style" },
  { label: "Palatino", value: "Palatino, 'Palatino Linotype', Georgia, serif", probe: "Palatino" },
  { label: "Athelas", value: "Athelas, Georgia, serif", probe: "Athelas" },
  { label: "Baskerville", value: "Baskerville, Georgia, serif", probe: "Baskerville" },
  { label: "Hoefler Text", value: "'Hoefler Text', Georgia, serif", probe: "Hoefler Text" },
  { label: "Helvetica Neue", value: "'Helvetica Neue', Helvetica, Arial, sans-serif", probe: "Helvetica Neue" },
  { label: "Avenir Next", value: "'Avenir Next', 'Helvetica Neue', sans-serif", probe: "Avenir Next" },
  { label: "Optima", value: "Optima, 'Helvetica Neue', sans-serif", probe: "Optima" },
  { label: "Seravek", value: "Seravek, 'Helvetica Neue', sans-serif", probe: "Seravek" },
];

const MONO_FONTS = [
  { label: "System (SF Mono)", value: "" },
  { label: "Menlo", value: "Menlo, monospace", probe: "Menlo" },
  { label: "Monaco", value: "Monaco, monospace", probe: "Monaco" },
  { label: "JetBrains Mono", value: "'JetBrains Mono', Menlo, monospace", probe: "JetBrains Mono" },
  { label: "Fira Code", value: "'Fira Code', Menlo, monospace", probe: "Fira Code" },
  { label: "Source Code Pro", value: "'Source Code Pro', Menlo, monospace", probe: "Source Code Pro" },
  { label: "IBM Plex Mono", value: "'IBM Plex Mono', Menlo, monospace", probe: "IBM Plex Mono" },
  { label: "Hack", value: "Hack, Menlo, monospace", probe: "Hack" },
  { label: "Cascadia Code", value: "'Cascadia Code', Menlo, monospace", probe: "Cascadia Code" },
  { label: "Courier New", value: "'Courier New', monospace", probe: "Courier New" },
];

function fontInstalled(name) {
  try {
    return document.fonts.check(`16px "${name}"`);
  } catch (err) {
    return true;
  }
}

function populateFontSelect(select, fonts) {
  select.innerHTML = "";
  for (const font of fonts) {
    if (font.probe && !fontInstalled(font.probe)) continue;
    const opt = document.createElement("option");
    opt.value = font.value;
    opt.textContent = font.label;
    select.appendChild(opt);
  }
}

// Keeps a hand-edited config stack selectable instead of clobbering it.
function ensureFontOption(select, value) {
  if ([...select.options].some((o) => o.value === value)) return;
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = "Custom (config file)";
  select.appendChild(opt);
}

populateFontSelect(cfgEls.fontFamily, BODY_FONTS);
populateFontSelect(cfgEls.monoFamily, MONO_FONTS);

let cfgWriteTimer = null;

function persistConfig() {
  clearTimeout(cfgWriteTimer);
  cfgWriteTimer = setTimeout(() => {
    const out = {};
    if (cfgState.fontFamily) out.fontFamily = cfgState.fontFamily;
    if (cfgState.monoFamily) out.monoFamily = cfgState.monoFamily;
    out.fontSize = cfgState.fontSize;
    out.lineHeight = cfgState.lineHeight;
    out.contentWidth = cfgState.contentWidth;
    zero.invoke("mdv.configWrite", { raw: JSON.stringify(out, null, 2) + "\n" }).catch(() => {});
  }, 400);
}

function populateSettings() {
  ensureFontOption(cfgEls.fontFamily, cfgState.fontFamily);
  ensureFontOption(cfgEls.monoFamily, cfgState.monoFamily);
  cfgEls.fontFamily.value = cfgState.fontFamily;
  cfgEls.monoFamily.value = cfgState.monoFamily;
  cfgEls.fontSize.value = cfgState.fontSize;
  cfgEls.lineHeight.value = cfgState.lineHeight;
  cfgEls.contentWidth.value = cfgState.contentWidth;
}

function readSettingsInputs() {
  cfgState.fontFamily = cfgEls.fontFamily.value.trim();
  cfgState.monoFamily = cfgEls.monoFamily.value.trim();
  const size = parseFloat(cfgEls.fontSize.value);
  const lh = parseFloat(cfgEls.lineHeight.value);
  const width = parseFloat(cfgEls.contentWidth.value);
  if (Number.isFinite(size)) cfgState.fontSize = size;
  if (Number.isFinite(lh)) cfgState.lineHeight = lh;
  if (Number.isFinite(width)) cfgState.contentWidth = width;
  applyConfigVars(cfgState);
  persistConfig();
}

for (const key of ["fontFamily", "monoFamily", "fontSize", "lineHeight", "contentWidth"]) {
  cfgEls[key].addEventListener("input", readSettingsInputs);
  cfgEls[key].addEventListener("change", readSettingsInputs);
}

cfgEls.reset.addEventListener("click", () => {
  cfgState = { ...CFG_DEFAULTS };
  populateSettings();
  applyConfigVars(cfgState);
  clearTimeout(cfgWriteTimer);
  zero.invoke("mdv.configWrite", { raw: "{}\n" }).catch(() => {});
});

function openSettings() {
  closeToc();
  closeFind(); // shares the top-right slot, and .find outranks it on z-index
  populateSettings();
  cfgEls.panel.hidden = false;
  requestAnimationFrame(() => cfgEls.panel.classList.add("open"));
}

function closeSettings() {
  cfgEls.panel.classList.remove("open");
  cfgEls.panel.hidden = true;
}

function toggleSettings() {
  if (cfgEls.panel.classList.contains("open")) closeSettings();
  else openSettings();
}

// Settings > Appearance... menu item (and its Cmd+, key equivalent),
// forwarded by the Zig core as a window event.
if (typeof zero.on === "function") {
  zero.on("mdv:settings", () => toggleSettings());
}

async function boot() {
  refreshConfig();
  setInterval(refreshConfig, 2000);
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

// ---- TOC: always-visible minimap rail + expanding panel ----
//
// The rail (tiny bars, one per heading, top-right) is persistent and never
// covers the 72ch reading column on normal window widths. Hovering it (or
// the menu item / Cmd+Shift+O) expands the full panel; leaving collapses.

const TOC_TIMING = {
  collapseDelay: 300, // ms of grace when the pointer leaves rail/panel
  minHeadings: 2, // below this a TOC is noise
};

const railEl = document.getElementById("toc-rail");
let tocHeadings = [];
let tocCollapseTimer = null;
let activeHeadingId = null;

function renderToc(headings) {
  tocHeadings = headings;
  const show = headings.length >= TOC_TIMING.minHeadings;
  railEl.hidden = !show;
  if (!show) {
    railEl.innerHTML = "";
    els.toc.innerHTML = "";
    closeToc();
    return;
  }
  els.toc.innerHTML = headings
    .map((h) => `<div class="toc-item toc-level-${h.level}" data-id="${escapeHtml(h.id)}">${escapeHtml(h.text)}</div>`)
    .join("");
  railEl.innerHTML = headings
    .map((h) => `<div class="toc-bar toc-bar-${h.level}" data-id="${escapeHtml(h.id)}"></div>`)
    .join("");
  activeHeadingId = null;
  requestAnimationFrame(updateActiveHeading);
}

function updateActiveHeading() {
  if (tocHeadings.length === 0) return;
  let active = tocHeadings[0].id;
  for (const h of tocHeadings) {
    const el = document.getElementById(h.id);
    if (!el || el.classList.contains("sec-hidden")) continue;
    const top = el.getBoundingClientRect().top;
    if (top <= 100 && (top !== 0 || window.scrollY > 0 || h === tocHeadings[0])) active = h.id;
    if (top > 100) break;
  }
  if (active === activeHeadingId) return;
  activeHeadingId = active;
  for (const bar of railEl.children) bar.classList.toggle("active", bar.dataset.id === active);
  for (const item of els.toc.children) item.classList.toggle("active", item.dataset.id === active);
}

let scrollTick = false;
window.addEventListener(
  "scroll",
  () => {
    if (scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(() => {
      scrollTick = false;
      updateActiveHeading();
    });
  },
  { passive: true }
);

function openToc() {
  if (!els.toc.innerHTML) return;
  clearTimeout(tocCollapseTimer);
  els.toc.hidden = false;
  requestAnimationFrame(() => els.toc.classList.add("open"));
}

function closeToc() {
  clearTimeout(tocCollapseTimer);
  els.toc.classList.remove("open");
  els.toc.hidden = true;
}

function scheduleTocCollapse() {
  clearTimeout(tocCollapseTimer);
  tocCollapseTimer = setTimeout(closeToc, TOC_TIMING.collapseDelay);
}

function toggleToc() {
  if (els.toc.classList.contains("open")) closeToc();
  else openToc();
}

function jumpToHeading(id) {
  const target = document.getElementById(id);
  if (!target) return;
  expandToReveal(id);
  target.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---- collapsible heading sections ----
//
// Chevron appears on heading hover (persistent while collapsed); a
// collapsed heading hides everything up to the next heading of the same
// or higher level. State keys on stable anchor ids, so it survives
// live reloads.

const collapsedSections = new Set();
const CHEVRON_SVG = '<svg viewBox="0 0 10 10" width="10" height="10"><path d="M2 3l3 3.2L8 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function headingLevel(el) {
  return /^H[1-3]$/.test(el.tagName) ? Number(el.tagName[1]) : null;
}

function decorateSections() {
  for (const h of els.content.querySelectorAll("h1[id], h2[id], h3[id]")) {
    const btn = document.createElement("button");
    btn.className = "sec-toggle";
    btn.setAttribute("aria-label", "Toggle section");
    btn.innerHTML = CHEVRON_SVG;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (collapsedSections.has(h.id)) collapsedSections.delete(h.id);
      else collapsedSections.add(h.id);
      applyCollapse();
    });
    h.prepend(btn);
  }
}

function applyCollapse() {
  let hideLevel = null;
  for (const el of els.content.children) {
    const level = headingLevel(el);
    if (level && hideLevel !== null && level <= hideLevel) hideLevel = null;
    const hidden = hideLevel !== null;
    el.classList.toggle("sec-hidden", hidden);
    if (level) {
      const collapsed = collapsedSections.has(el.id);
      el.classList.toggle("collapsed", collapsed);
      if (!hidden && collapsed) hideLevel = level;
    }
  }
  requestAnimationFrame(updateActiveHeading);
}

// Expands whichever collapsed sections currently hide `id`.
function expandToReveal(id) {
  let changed = false;
  let hideLevel = null;
  let hider = null;
  for (const el of els.content.children) {
    const level = headingLevel(el);
    if (level && hideLevel !== null && level <= hideLevel) {
      hideLevel = null;
      hider = null;
    }
    if (el.id === id && hideLevel !== null && hider) {
      collapsedSections.delete(hider);
      changed = true;
      hideLevel = null;
      hider = null;
    }
    if (level && hideLevel === null && collapsedSections.has(el.id)) {
      hideLevel = level;
      hider = el.id;
    }
  }
  if (changed) {
    applyCollapse();
    expandToReveal(id); // nested collapses: repeat until the target is clear
  }
}

railEl.addEventListener("mouseenter", openToc);
railEl.addEventListener("mouseleave", scheduleTocCollapse);
els.toc.addEventListener("mouseenter", () => clearTimeout(tocCollapseTimer));
els.toc.addEventListener("mouseleave", scheduleTocCollapse);

railEl.addEventListener("click", (e) => {
  const bar = e.target.closest(".toc-bar");
  if (bar) jumpToHeading(bar.dataset.id);
});

els.toc.addEventListener("click", (e) => {
  const item = e.target.closest(".toc-item");
  if (!item) return;
  jumpToHeading(item.dataset.id);
  closeToc();
});

if (typeof zero.on === "function") {
  zero.on("mdv:toc", () => toggleToc());
}

// ---- find (Cmd+F) ----
//
// WKWebView never delivers Cmd-modifier hotkeys to JS keydown, so the menu
// route (mdv.find / mdv.findNext / mdv.findPrev -> window events) is the
// only way Cmd+F/G reach here in the packaged app.

const FIND_MAX_HITS = 5000;

const findEls = {
  bar: document.getElementById("find"),
  input: document.getElementById("find-input"),
  count: document.getElementById("find-count"),
  prev: document.getElementById("find-prev"),
  next: document.getElementById("find-next"),
  close: document.getElementById("find-close"),
};

let findQuery = "";
let findHits = [];
let findIndex = -1;

function clearHighlights() {
  for (const mark of findHits) {
    const parent = mark.parentNode;
    if (!parent) continue; // already detached by a re-render
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  }
  findHits = [];
  findIndex = -1;
}

// Splits one matching text node into plain-text + <mark> fragments. Called
// only after the TreeWalker below has finished -- mutating the DOM mid-walk
// would derail its traversal.
function highlightTextNode(textNode, needle) {
  const text = textNode.nodeValue;
  const lower = text.toLowerCase();
  let idx = lower.indexOf(needle);
  if (idx === -1) return;
  const frag = document.createDocumentFragment();
  let cursor = 0;
  while (idx !== -1) {
    if (findHits.length >= FIND_MAX_HITS) break;
    if (idx > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, idx)));
    const mark = document.createElement("mark");
    mark.className = "find-hit";
    mark.textContent = text.slice(idx, idx + needle.length);
    frag.appendChild(mark);
    findHits.push(mark);
    cursor = idx + needle.length;
    idx = lower.indexOf(needle, cursor);
  }
  if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
  textNode.parentNode.replaceChild(frag, textNode);
}

function highlightIn(root, needle) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // Chevron button labels and the hidden mermaid source aren't real
      // document text -- matching them would highlight UI chrome.
      const parent = node.parentElement;
      if (parent && parent.closest(".sec-toggle, .mermaid-source")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  for (const textNode of nodes) {
    if (findHits.length >= FIND_MAX_HITS) break;
    highlightTextNode(textNode, needle);
  }
}

function updateFindCount() {
  if (!findQuery) {
    findEls.count.textContent = "";
  } else if (findHits.length === 0) {
    findEls.count.textContent = "no matches";
  } else {
    const total = findHits.length >= FIND_MAX_HITS ? `${FIND_MAX_HITS}+` : String(findHits.length);
    findEls.count.textContent = `${findIndex + 1} / ${total}`;
  }
}

function runSearch(query) {
  clearHighlights();
  findQuery = query;
  if (query) {
    const needle = query.toLowerCase();
    highlightIn(els.frontmatter, needle);
    highlightIn(els.content, needle);
  }
  updateFindCount();
}

// Un-hides whichever collapsed section(s) currently hide `mark`, walking
// outward from its top-level container in els.content. Bounded so a DOM
// surprise (e.g. a cycle) can't hang the app.
function revealMatch(mark) {
  if (!els.content.contains(mark)) return;
  let top = mark;
  while (top.parentElement !== els.content) top = top.parentElement;
  let guard = 0;
  while (top.classList.contains("sec-hidden") && guard < 8) {
    guard += 1;
    let hider = top.previousElementSibling;
    while (hider && !(hider.classList.contains("collapsed") && !hider.classList.contains("sec-hidden"))) {
      hider = hider.previousElementSibling;
    }
    if (!hider) break;
    collapsedSections.delete(hider.id);
    applyCollapse();
  }
}

function focusMatch(i) {
  const n = findHits.length;
  if (n === 0) {
    findIndex = -1;
    updateFindCount();
    return;
  }
  findIndex = ((i % n) + n) % n;
  for (const mark of findHits) mark.classList.remove("current");
  const mark = findHits[findIndex];
  revealMatch(mark);
  mark.classList.add("current");
  mark.scrollIntoView({ block: "center" });
  updateFindCount();
}

function findNext() {
  if (findHits.length > 0) focusMatch(findIndex + 1);
}

function findPrev() {
  if (findHits.length > 0) focusMatch(findIndex - 1);
}

function openFind() {
  closeToc();
  closeSettings();
  findEls.bar.hidden = false;
  findEls.input.focus();
  findEls.input.select();
  if (findQuery) {
    runSearch(findQuery);
    if (findHits.length > 0) focusMatch(0);
  }
}

function closeFind() {
  clearHighlights();
  findEls.bar.hidden = true;
  findQuery = "";
  findEls.input.value = "";
  updateFindCount();
}

function toggleFind() {
  if (findEls.bar.hidden) openFind();
  else closeFind();
}

findEls.input.addEventListener("input", () => {
  runSearch(findEls.input.value);
  if (findHits.length > 0) focusMatch(0);
});

findEls.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (e.shiftKey) findPrev();
    else findNext();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeFind();
  }
});

findEls.prev.addEventListener("click", () => findPrev());
findEls.next.addEventListener("click", () => findNext());
findEls.close.addEventListener("click", () => closeFind());

if (typeof zero.on === "function") {
  zero.on("mdv:find", () => toggleFind());
  zero.on("mdv:findNext", () => {
    if (findEls.bar.hidden && findQuery) openFind();
    findNext();
  });
  zero.on("mdv:findPrev", () => {
    if (findEls.bar.hidden && findQuery) openFind();
    findPrev();
  });
}

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
  await openDoc(path);
}

// ---- keyboard shortcuts ----

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeToc();
    closeSettings();
    closeFind();
    return;
  }
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const key = e.key.toLowerCase();
  if (key === ",") {
    e.preventDefault();
    toggleSettings();
  } else if (key === "f") {
    // Dead in the packaged app (WKWebView swallows Cmd-modifier keys -- the
    // app.zon menu carries it there), but it makes Cmd+F work in browser dev
    // mode and stops the browser's own find bar hijacking a document viewer.
    e.preventDefault();
    toggleFind();
  } else if (key === "g" && e.shiftKey) {
    e.preventDefault();
    findPrev();
  } else if (key === "g") {
    e.preventDefault();
    findNext();
  } else if (key === "o" && e.shiftKey) {
    e.preventDefault();
    toggleToc();
  } else if (key === "o") {
    e.preventDefault();
    openViaDialog();
  } else if (key === "[") {
    e.preventDefault();
    goBack();
  } else if (key === "]") {
    e.preventDefault();
    goForward();
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
    openDoc(resolved).catch(() => {});
  } else {
    zero.os.revealPath(resolved).catch(() => {});
  }
});

// ---- dark/light mermaid re-theme ----

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  refreshMermaidTheme(mermaidEntries).catch(() => {});
});

boot();
