# mdv

Minimalist macOS markdown viewer. Double-click any `.md` file and it renders
in a clean reading window. Built on Vercel Native (`@native-sdk/cli`) --
Zig core + system WKWebView, ~no chrome, auto light/dark.

Features: GFM (tables, task lists), shiki syntax highlighting, mermaid
diagrams, YAML frontmatter chips, live reload on file change (scroll
preserved), TOC popover, relative .md links, Cmd+O open dialog, in-window
history. View-only by design.

Single-window model: a newly opened file replaces the current document
(SDK 0.5.4's dynamic window.create hides the previous window on macOS, so
one-window-per-file is parked until the SDK matures). History keeps every
file reachable.

## Keys

| Key | Action |
|---|---|
| Cmd+O | Open file dialog |
| Cmd+Shift+O / hover the right-edge rail | TOC panel (Esc closes) |
| Cmd+[ / Cmd+] | Back / forward through opened files |
| Cmd+, | Appearance settings panel (fonts, sizes -- applies live, persists) |

TOC: a minimap rail (one bar per heading) floats at the right edge whenever
a doc has 2+ headings; hover expands the full outline, the active section
is highlighted, clicking jumps. Headings h1-h3 are collapsible via the
chevron that appears on hover (state survives live reloads).

## Config

Preferred: the in-app panel (Cmd+,). Under the hood it writes
`~/.config/mdv/config.json`, which you can also edit by hand (all keys
optional; polled every 2s, applies live):

```json
{
  "fontFamily": "-apple-system, ui-sans-serif, sans-serif",
  "monoFamily": "ui-monospace, 'SF Mono', monospace",
  "fontSize": 17,
  "lineHeight": 1.65,
  "contentWidth": 72
}
```

`fontSize` in px, `contentWidth` in ch. Delete the file to return to
defaults.

## Build

Prereqs: Zig 0.16, `@native-sdk/cli` 0.5.4 global (`npm i -g @native-sdk/cli@0.5.4`),
node/npm.

```bash
cd mdv
zig build package
# -> zig-out/package/mdv-0.1.0-macos-ReleaseFast.app
```

## Install + default handler

```bash
rm -rf /Applications/mdv.app
cp -R mdv/zig-out/package/mdv-0.1.0-macos-ReleaseFast.app /Applications/mdv.app
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Applications/mdv.app
duti -s au.com.bellizzi.mdv .md all
duti -s au.com.bellizzi.mdv .markdown all
```

## Architecture notes

See DESIGN.md. Key quirk: SDK 0.4.4 installs no NSApplication delegate and
drops Finder's open-document Apple Event; `mdv/src/open_files.m` installs a
minimal delegate at willFinishLaunching that queues paths, drained by the
frontend over custom `mdv.*` bridge commands. Remove the shim when the SDK
handles `application:openFiles:` natively.

Dev loop: `cd mdv && zig build dev` (vite dev server inside the native
shell), or `cd mdv/frontend && npm run dev` for browser-only UI work
(window.zero is mocked, serves `public/dev-fixture.md`).
