# mdv -- minimalist Mac markdown viewer

Status: ACTIVE
Date: 2026-07-22
Owner: Yury

## What

A lightweight macOS app that registers as the default handler for `.md`/`.markdown`
files and renders them beautifully. View-only. Built on Vercel Native
(`@native-sdk/cli`, Zig core + system WKWebView frontend).

## Requirements (locked with Yury 2026-07-22)

- GFM core (tables, task lists, strikethrough, autolinks)
- Syntax-highlighted fenced code blocks
- Mermaid diagrams (lazy-loaded only when a mermaid fence exists)
- YAML frontmatter rendered as a compact key/value chip block
- One window per file
- Live reload on file change, preserving scroll position
- TOC popover (Cmd+Shift+O) built from headings
- Relative `.md` links open in a new viewer window; external links open in browser
- Auto light/dark following system appearance
- Minimal chrome: hidden-inset titlebar, no toolbar, reading-column layout

## Architecture

```
Finder double-click (.md)
        |  odoc Apple Event
        v
+---------------------------------------------+
| mdv.app  (Zig binary, Native SDK 0.4.4)     |
|                                             |
|  open_files.m  <- our ObjC shim:            |
|    category on NativeSdkAppDelegate         |
|    implementing application:openFiles:      |
|    -> thread-safe pending-paths queue       |
|                                             |
|  main.zig                                   |
|    custom bridge commands (RunOptions.bridge)|
|      mdv.pending -> drain queue (JSON)      |
|      mdv.read {path} -> {content, mtime}    |
|      mdv.stat {path} -> {mtime}             |
|                                             |
|  WKWebView (system, nothing bundled)        |
|    frontend/ (Vite, vanilla TS, all vendored)|
|      markdown-it + plugins (GFM)            |
|      shiki (highlight)                      |
|      mermaid (dynamic import)               |
+---------------------------------------------+
```

Key SDK facts (verified against installed 0.4.4 + 0.5.4 tarball source):

- `app.zon` `file_associations` -> `CFBundleDocumentTypes` in Info.plist at
  `native package` time (src/tooling/package.zig).
- The SDK's `NativeSdkAppDelegate` implements ONLY
  `applicationShouldHandleReopen:` -- Finder's open-document event is dropped
  in both 0.4.4 and 0.5.4. Our ObjC category supplies
  `application:openFiles:`; runtime guard checks the class still exists so an
  SDK rename fails loudly, not silently.
- Builtin JS bridge provides `native-sdk.window.create/list/focus/close`,
  `native-sdk.dialog.openFile`, `native-sdk.os.openUrl`,
  `native-sdk.os.addRecentDocument`. No builtin filesystem commands -- hence
  our custom `mdv.*` bridge commands in Zig.
- Custom bridge injected via template `RunOptions.bridge`
  (`?native_sdk.BridgeDispatcher`).

## Data flow

1. Cold launch via double-click: LaunchServices starts mdv, AppKit delivers
   `application:openFiles:` -> paths queued. Frontend boots, polls
   `mdv.pending`, claims the first path for the main window, renders. Extra
   paths -> `native-sdk.window.create` with `#p=<encoded path>`.
2. App already running: same queue; the coordinator (main window) poll picks
   it up and opens a new window per path.
3. Live reload: each window polls `mdv.stat` (500ms). mtime change ->
   `mdv.read` -> re-render, restore scroll (nearest-heading anchor, fallback
   scroll ratio).
4. Relative `.md` link click -> resolve against current file dir ->
   `native-sdk.window.create`. External http(s) -> `native-sdk.os.openUrl`.

## Failure handling

- File unreadable/deleted: render inline notice, keep polling (agents rewrite
  files atomically; transient ENOENT tolerated for 2 polls before notice).
- File >10MB: refuse with notice (viewer, not editor).
- Mermaid parse error: show fence as code with error note; never blank page.
- Queue race on cold launch (odoc arriving before webview ready): queue is
  drained only by frontend poll, so timing is safe by construction.

## Packaging & distribution

- `zig build package` -> `native package --target macos` -> `mdv.app`,
  ad-hoc signed. Personal use; first-launch right-click-Open.
- Default-handler registration: one-time Finder Get Info -> Change All, or
  `duti` if present. Documented in README.
- Repo: ~/Documents/agentic workflows/md-viewer (GitHub: Sunseeker/md-viewer).
- SDK pinned at @native-sdk/cli 0.4.4 (0.5.x quarantined <7 days at build
  date). `build.zig` hardcodes the global npm path; revisit when 0.5.x ages.

## Phase 0 spike (gate)

Prove empirically before building the frontend: packaged mdv.app with
`file_associations` + ObjC shim receives paths for (a) cold launch via
`open -a mdv.app file.md` and Finder double-click, (b) open-while-running.
If AppKit's delegate path fails, fallback is an NSAppleEventManager `odoc`
handler installed at `applicationDidFinishLaunching`. If both fail -> stop,
report, reassess (Tauri fallback).

## Testing

- Fixture set copied from real repo files (frontmatter plan, mermaid doc,
  500-line PLAN, code-heavy skill doc) rendered without error (headless
  check via `native dev` + frontend unit render pass).
- Manual QA checklist: double-click cold/warm, second file -> second window,
  live-reload on scripted rewrite, TOC jump, relative link, external link,
  dark/light flip.
