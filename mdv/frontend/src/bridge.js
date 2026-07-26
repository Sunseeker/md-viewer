// Access to window.zero (injected by the Native SDK host). Outside the
// native shell (plain `npm run dev` in a browser) installs a mock so the
// whole app is exercisable for QA without the packaged app.

const MOCK_PATH = "/dev/fixtures/rich.md";
const MOCK_MTIME = 1;

async function readMockFixture() {
  const res = await fetch("/dev-fixture.md");
  if (!res.ok) throw new Error(`fixture fetch failed: ${res.status}`);
  return res.text();
}

function installMockZero() {
  let drained = false;
  let mockConfig = null;
  let mockConfigMtime = 0;

  window.zero = {
    async invoke(command, payload) {
      switch (command) {
        case "mdv.pending": {
          if (drained) return { shim: 1, paths: [] };
          drained = true;
          return { shim: 1, paths: [MOCK_PATH] };
        }
        case "mdv.claim":
          return {};
        case "mdv.config":
          return mockConfig == null ? { error: "missing" } : { mtime: mockConfigMtime, raw: mockConfig };
        case "mdv.configWrite":
          mockConfig = payload && payload.raw;
          mockConfigMtime += 1;
          return { ok: true };
        case "mdv.assign":
          return { ok: true };
        case "mdv.stat": {
          try {
            const content = await readMockFixture();
            return { mtime: MOCK_MTIME, size: content.length };
          } catch (err) {
            return { error: "unreadable" };
          }
        }
        case "mdv.read": {
          try {
            const content = await readMockFixture();
            const offset = (payload && payload.offset) || 0;
            // Far smaller than the real 256 KB, and deliberately smaller than
            // dev-fixture.md (~1.1 KB): at any chunk size above the fixture
            // the mock returns everything in one shot and `npm run dev` never
            // exercises the reassembly loop at all.
            const MOCK_CHUNK = 256;
            const next = Math.min(offset + MOCK_CHUNK, content.length);
            return {
              mtime: MOCK_MTIME,
              size: content.length,
              offset,
              content: content.slice(offset, next),
              next,
              eof: next >= content.length,
            };
          } catch (err) {
            return { error: "unreadable" };
          }
        }
        default:
          return {};
      }
    },
    windows: {
      create(options) {
        console.log("[mock zero] windows.create", options);
        return Promise.resolve({
          id: Math.floor(Math.random() * 100000) + 2,
          label: options && options.label,
          title: options && options.title,
        });
      },
      list: () => Promise.resolve([]),
      focus: () => Promise.resolve(),
      close: () => Promise.resolve(),
    },
    dialogs: {
      openFile(options) {
        console.log("[mock zero] dialogs.openFile", options);
        return Promise.resolve(null);
      },
    },
    os: {
      openUrl(value) {
        const url = typeof value === "string" ? value : value && value.url;
        if (url) window.open(url, "_blank", "noopener");
        return Promise.resolve();
      },
      revealPath(value) {
        console.log("[mock zero] os.revealPath", value);
        return Promise.resolve();
      },
      addRecentDocument(value) {
        console.log("[mock zero] os.addRecentDocument", value);
        return Promise.resolve();
      },
    },
  };
}

export function getZero() {
  if (!window.zero || typeof window.zero.invoke !== "function") installMockZero();
  return window.zero;
}
