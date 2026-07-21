// Phase 0 spike frontend: prove the open-files pipeline end to end.
// Polls mdv.pending, claims the first path, shows raw file content,
// live-reloads on mtime change.
import "./styles.css";

const el = (id) => document.getElementById(id);
const zero = window.zero;

let currentPath = null;
let currentMtime = 0;

function setStatus(text) {
  el("status").textContent = text;
}

async function render(path) {
  const res = await zero.invoke("mdv.read", { path });
  if (res.error) {
    setStatus(`error: ${res.error} (${path})`);
    return;
  }
  currentMtime = res.mtime;
  el("content").textContent = res.content;
  setStatus(`${path} — mtime ${new Date(res.mtime).toISOString()}`);
}

async function tick() {
  try {
    const pending = await zero.invoke("mdv.pending", {});
    el("shim").textContent = `shim status: ${pending.shim}`;
    if (pending.paths.length > 0) {
      currentPath = pending.paths[0];
      await render(currentPath);
      for (const extra of pending.paths.slice(1)) {
        el("extras").textContent += `also received: ${extra}\n`;
      }
    } else if (currentPath) {
      const st = await zero.invoke("mdv.stat", { path: currentPath });
      if (!st.error && st.mtime !== currentMtime) await render(currentPath);
    }
  } catch (err) {
    setStatus(`bridge error: ${err && err.message ? err.message : err}`);
  }
  setTimeout(tick, 500);
}

if (zero && zero.invoke) {
  setStatus("waiting for a file…");
  tick();
} else {
  setStatus("bridge unavailable");
}
