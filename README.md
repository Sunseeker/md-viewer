# mdv

Minimalist macOS markdown viewer. Double-click any `.md` file and it renders
in a clean reading window. Built on Vercel Native (`@native-sdk/cli`) --
Zig core + system WKWebView, ~no chrome, auto light/dark.

Features: GFM (tables, task lists), shiki syntax highlighting, mermaid
diagrams, YAML frontmatter chips, live reload on file change (scroll
preserved), TOC popover (Cmd+Shift+O), relative .md links open new windows,
Cmd+O open dialog. View-only by design.

## Build

Prereqs: Zig 0.16, `@native-sdk/cli` 0.4.4 global (`npm i -g @native-sdk/cli@0.4.4`),
node/npm.

```bash
cd mdv
zig build package -Doptimize=ReleaseSafe
# -> zig-out/package/mdv-0.1.0-macos-ReleaseSafe.app
```

## Install + default handler

```bash
rm -rf /Applications/mdv.app
cp -R mdv/zig-out/package/mdv-0.1.0-macos-ReleaseSafe.app /Applications/mdv.app
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
