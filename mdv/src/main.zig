const std = @import("std");
const runner = @import("runner");
const native_sdk = @import("native_sdk");
const bridge = native_sdk.bridge;

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);

extern fn mdv_take_pending(buf: [*]u8, cap: c_long) c_long;
extern fn mdv_shim_status() c_int;

const max_file_bytes = 400 * 1024;
var file_buf: [max_file_bytes]u8 = undefined;
var bridge_ctx: u8 = 0;
var g_io: std.Io = undefined;
var home_buf: [1024]u8 = undefined;
var home_len: usize = 0;

const App = struct {
    env_map: *std.process.Environ.Map,

    fn app(self: *@This()) native_sdk.App {
        return .{
            .context = self,
            .name = "mdv",
            .source = native_sdk.frontend.productionSource(.{ .dist = "frontend/dist" }),
            .source_fn = source,
            .event_fn = onEvent,
        };
    }

    // Menu commands arrive here; forward to the window's frontend as a
    // window event (window.zero.on("mdv:settings", ...)).
    fn onEvent(_: *anyopaque, rt: *native_sdk.Runtime, event: native_sdk.Event) anyerror!void {
        switch (event) {
            .command => |cmd| {
                if (std.mem.eql(u8, cmd.name, "mdv.settings")) {
                    const wid = if (cmd.window_id != 0) cmd.window_id else 1;
                    rt.emitWindowEvent(wid, "mdv:settings", "{}") catch {};
                }
            },
            else => {},
        }
    }

    fn source(context: *anyopaque) anyerror!native_sdk.WebViewSource {
        const self: *@This() = @ptrCast(@alignCast(context));
        return native_sdk.frontend.sourceFromEnv(self.env_map, .{
            .dist = "frontend/dist",
            .entry = "index.html",
        });
    }
};

// ---- minimal JSON out ----

const JsonOut = struct {
    out: []u8,
    i: usize = 0,

    fn raw(self: *JsonOut, s: []const u8) !void {
        if (self.i + s.len > self.out.len) return error.NoSpaceLeft;
        @memcpy(self.out[self.i..][0..s.len], s);
        self.i += s.len;
    }

    fn byte(self: *JsonOut, c: u8) !void {
        if (self.i + 1 > self.out.len) return error.NoSpaceLeft;
        self.out[self.i] = c;
        self.i += 1;
    }

    fn str(self: *JsonOut, s: []const u8) !void {
        try self.byte('"');
        for (s) |c| {
            switch (c) {
                '"' => try self.raw("\\\""),
                '\\' => try self.raw("\\\\"),
                '\n' => try self.raw("\\n"),
                '\r' => try self.raw("\\r"),
                '\t' => try self.raw("\\t"),
                else => {
                    if (c < 0x20) {
                        var tmp: [8]u8 = undefined;
                        const esc = std.fmt.bufPrint(&tmp, "\\u{x:0>4}", .{c}) catch return error.NoSpaceLeft;
                        try self.raw(esc);
                    } else {
                        try self.byte(c);
                    }
                },
            }
        }
        try self.byte('"');
    }

    fn int(self: *JsonOut, v: i64) !void {
        var tmp: [24]u8 = undefined;
        const s = std.fmt.bufPrint(&tmp, "{d}", .{v}) catch return error.NoSpaceLeft;
        try self.raw(s);
    }
};

// Extracts a top-level JSON string field (common escapes) into out.
fn payloadString(payload: []const u8, key: []const u8, out: []u8) ?[]const u8 {
    const ki = std.mem.indexOf(u8, payload, key) orelse return null;
    var i = ki + key.len;
    while (i < payload.len and (payload[i] == ' ' or payload[i] == ':')) i += 1;
    if (i >= payload.len or payload[i] != '"') return null;
    i += 1;
    var o: usize = 0;
    while (i < payload.len) : (i += 1) {
        const c = payload[i];
        if (c == '"') return out[0..o];
        if (o + 4 > out.len) return null;
        if (c != '\\') {
            out[o] = c;
            o += 1;
            continue;
        }
        i += 1;
        if (i >= payload.len) return null;
        const e = payload[i];
        if (e == 'u') {
            if (i + 4 >= payload.len) return null;
            const cp = std.fmt.parseInt(u16, payload[i + 1 .. i + 5], 16) catch return null;
            i += 4;
            const n = std.unicode.utf8Encode(cp, out[o..][0..4]) catch return null;
            o += n;
            continue;
        }
        out[o] = switch (e) {
            'n' => '\n',
            't' => '\t',
            'r' => '\r',
            'b' => 0x08,
            'f' => 0x0c,
            '"', '\\', '/' => e,
            else => return null,
        };
        o += 1;
    }
    return null;
}

fn payloadPath(payload: []const u8, out: []u8) ?[]const u8 {
    return payloadString(payload, "\"path\"", out);
}

fn mtimeMs(ts: std.Io.Timestamp) i64 {
    return @intCast(@divTrunc(ts.nanoseconds, std.time.ns_per_ms));
}

// Extracts payload.windowId (JSON number, integer digits only) from payload.
fn payloadWindowId(payload: []const u8) ?u64 {
    const key = "\"windowId\"";
    const ki = std.mem.indexOf(u8, payload, key) orelse return null;
    var i = ki + key.len;
    while (i < payload.len and (payload[i] == ' ' or payload[i] == ':')) i += 1;
    const start = i;
    while (i < payload.len and payload[i] >= '0' and payload[i] <= '9') i += 1;
    if (i == start) return null;
    return std.fmt.parseInt(u64, payload[start..i], 10) catch null;
}

// ---- window -> path assignment table ----

const WindowSlot = struct {
    window_id: u64 = 0,
    len: usize = 0,
    path: [4096]u8 = undefined,
};

var window_paths: [32]WindowSlot = [_]WindowSlot{.{}} ** 32;

// Stores `path` for `window_id`, overwriting an existing entry for the same
// window or claiming the first free slot. False on bad input or a full
// table with no matching entry.
fn assignPath(table: []WindowSlot, window_id: u64, path: []const u8) bool {
    if (window_id == 0) return false;
    for (table) |*slot| {
        if (slot.window_id == window_id) {
            if (path.len > slot.path.len) return false;
            @memcpy(slot.path[0..path.len], path);
            slot.len = path.len;
            return true;
        }
    }
    for (table) |*slot| {
        if (slot.window_id == 0) {
            if (path.len > slot.path.len) return false;
            slot.window_id = window_id;
            @memcpy(slot.path[0..path.len], path);
            slot.len = path.len;
            return true;
        }
    }
    return false;
}

fn claimPath(table: []const WindowSlot, window_id: u64) ?[]const u8 {
    for (table) |slot| {
        if (slot.window_id == window_id) return slot.path[0..slot.len];
    }
    return null;
}

// ---- bridge handlers ----

fn hPending(_: *anyopaque, _: bridge.Invocation, output: []u8) anyerror![]const u8 {
    var buf: [32768]u8 = undefined;
    const n = mdv_take_pending(&buf, @intCast(buf.len));
    var w = JsonOut{ .out = output };
    try w.raw("{\"shim\":");
    try w.int(mdv_shim_status());
    try w.raw(",\"paths\":[");
    if (n > 0) {
        var it = std.mem.splitScalar(u8, buf[0..@intCast(n)], '\n');
        var first = true;
        while (it.next()) |p| {
            if (p.len == 0) continue;
            if (!first) try w.byte(',');
            first = false;
            try w.str(p);
        }
    }
    try w.raw("]}");
    return output[0..w.i];
}

fn hStat(_: *anyopaque, invocation: bridge.Invocation, output: []u8) anyerror![]const u8 {
    var path_buf: [4096]u8 = undefined;
    const path = payloadPath(invocation.request.payload, &path_buf) orelse return error.BadPath;
    var w = JsonOut{ .out = output };
    var f = std.Io.Dir.cwd().openFile(g_io, path, .{}) catch {
        try w.raw("{\"error\":\"unreadable\"}");
        return output[0..w.i];
    };
    defer f.close(g_io);
    const st = f.stat(g_io) catch {
        try w.raw("{\"error\":\"unreadable\"}");
        return output[0..w.i];
    };
    try w.raw("{\"mtime\":");
    try w.int(mtimeMs(st.mtime));
    try w.raw(",\"size\":");
    try w.int(@intCast(st.size));
    try w.raw("}");
    return output[0..w.i];
}

fn hRead(_: *anyopaque, invocation: bridge.Invocation, output: []u8) anyerror![]const u8 {
    var path_buf: [4096]u8 = undefined;
    const path = payloadPath(invocation.request.payload, &path_buf) orelse return error.BadPath;
    var w = JsonOut{ .out = output };
    var f = std.Io.Dir.cwd().openFile(g_io, path, .{}) catch {
        try w.raw("{\"error\":\"unreadable\"}");
        return output[0..w.i];
    };
    defer f.close(g_io);
    const st = f.stat(g_io) catch {
        try w.raw("{\"error\":\"unreadable\"}");
        return output[0..w.i];
    };
    if (st.size > max_file_bytes) {
        try w.raw("{\"error\":\"too_large\",\"size\":");
        try w.int(@intCast(st.size));
        try w.raw("}");
        return output[0..w.i];
    }
    const n = f.readPositionalAll(g_io, &file_buf, 0) catch {
        try w.raw("{\"error\":\"unreadable\"}");
        return output[0..w.i];
    };
    try w.raw("{\"mtime\":");
    try w.int(mtimeMs(st.mtime));
    try w.raw(",\"content\":");
    try w.str(file_buf[0..n]);
    try w.raw("}");
    return output[0..w.i];
}

fn hAssign(_: *anyopaque, invocation: bridge.Invocation, output: []u8) anyerror![]const u8 {
    var path_buf: [4096]u8 = undefined;
    const path = payloadPath(invocation.request.payload, &path_buf) orelse return error.BadPath;
    const window_id = payloadWindowId(invocation.request.payload) orelse return error.BadWindowId;
    var w = JsonOut{ .out = output };
    if (assignPath(&window_paths, window_id, path)) {
        try w.raw("{\"ok\":true}");
    } else {
        try w.raw("{\"ok\":false}");
    }
    return output[0..w.i];
}

fn hClaim(_: *anyopaque, invocation: bridge.Invocation, output: []u8) anyerror![]const u8 {
    var w = JsonOut{ .out = output };
    if (claimPath(&window_paths, invocation.source.window_id)) |path| {
        try w.raw("{\"path\":");
        try w.str(path);
        try w.raw("}");
    } else {
        try w.raw("{}");
    }
    return output[0..w.i];
}

// Serves ~/.config/mdv/config.json raw; the frontend parses and applies it
// (fonts, sizes). {"error":"missing"} when absent/oversized -- never fatal.
fn hConfig(_: *anyopaque, _: bridge.Invocation, output: []u8) anyerror![]const u8 {
    var w = JsonOut{ .out = output };
    const missing = "{\"error\":\"missing\"}";
    if (home_len == 0) {
        try w.raw(missing);
        return output[0..w.i];
    }
    var path_buf: [1200]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/.config/mdv/config.json", .{home_buf[0..home_len]}) catch {
        try w.raw(missing);
        return output[0..w.i];
    };
    var f = std.Io.Dir.cwd().openFile(g_io, path, .{}) catch {
        try w.raw(missing);
        return output[0..w.i];
    };
    defer f.close(g_io);
    const st = f.stat(g_io) catch {
        try w.raw(missing);
        return output[0..w.i];
    };
    var cfg_buf: [16384]u8 = undefined;
    if (st.size > cfg_buf.len) {
        try w.raw(missing);
        return output[0..w.i];
    }
    const n = f.readPositionalAll(g_io, &cfg_buf, 0) catch {
        try w.raw(missing);
        return output[0..w.i];
    };
    try w.raw("{\"mtime\":");
    try w.int(mtimeMs(st.mtime));
    try w.raw(",\"raw\":");
    try w.str(cfg_buf[0..n]);
    try w.raw("}");
    return output[0..w.i];
}

// Persists the settings panel's JSON to ~/.config/mdv/config.json.
// The file stays the source of truth; every window's config poll picks
// the change up.
fn hConfigWrite(_: *anyopaque, invocation: bridge.Invocation, output: []u8) anyerror![]const u8 {
    var w = JsonOut{ .out = output };
    if (home_len == 0) {
        try w.raw("{\"ok\":false}");
        return output[0..w.i];
    }
    var raw_buf: [16384]u8 = undefined;
    const raw = payloadString(invocation.request.payload, "\"raw\"", &raw_buf) orelse return error.BadPayload;
    var dir_buf: [1200]u8 = undefined;
    const dir = std.fmt.bufPrint(&dir_buf, "{s}/.config/mdv", .{home_buf[0..home_len]}) catch return error.BadPayload;
    const cwd = std.Io.Dir.cwd();
    cwd.createDirPath(g_io, dir) catch {};
    var path_buf: [1240]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/config.json", .{dir}) catch return error.BadPayload;
    cwd.writeFile(g_io, .{ .sub_path = path, .data = raw }) catch {
        try w.raw("{\"ok\":false}");
        return output[0..w.i];
    };
    try w.raw("{\"ok\":true}");
    return output[0..w.i];
}

const mdv_handlers = [_]bridge.Handler{
    .{ .name = "mdv.pending", .context = @ptrCast(&bridge_ctx), .invoke_fn = hPending },
    .{ .name = "mdv.stat", .context = @ptrCast(&bridge_ctx), .invoke_fn = hStat },
    .{ .name = "mdv.read", .context = @ptrCast(&bridge_ctx), .invoke_fn = hRead },
    .{ .name = "mdv.assign", .context = @ptrCast(&bridge_ctx), .invoke_fn = hAssign },
    .{ .name = "mdv.claim", .context = @ptrCast(&bridge_ctx), .invoke_fn = hClaim },
    .{ .name = "mdv.config", .context = @ptrCast(&bridge_ctx), .invoke_fn = hConfig },
    .{ .name = "mdv.configWrite", .context = @ptrCast(&bridge_ctx), .invoke_fn = hConfigWrite },
};

const mdv_command_policies = [_]bridge.CommandPolicy{
    .{ .name = "mdv.pending" },
    .{ .name = "mdv.stat" },
    .{ .name = "mdv.read" },
    .{ .name = "mdv.assign" },
    .{ .name = "mdv.claim" },
    .{ .name = "mdv.config" },
    .{ .name = "mdv.configWrite" },
};

// Builtin `window.zero.*` commands are deny-by-default (Policy.enabled=false
// unless the app opts in) -- without this list, zero.windows.create is
// rejected and a second opened file never gets a window.
const builtin_command_policies = [_]bridge.CommandPolicy{
    .{ .name = "native-sdk.window.create" },
    .{ .name = "native-sdk.window.list" },
    .{ .name = "native-sdk.window.focus" },
    .{ .name = "native-sdk.window.close" },
    .{ .name = "native-sdk.dialog.openFile" },
    .{ .name = "native-sdk.os.openUrl" },
    .{ .name = "native-sdk.os.revealPath" },
    .{ .name = "native-sdk.os.addRecentDocument" },
    .{ .name = "native-sdk.os.clearRecentDocuments" },
};

const dev_origins = [_][]const u8{ "zero://app", "zero://inline", "http://127.0.0.1:5173" };

pub fn main(init: std.process.Init) !void {
    g_io = init.io;
    if (init.environ_map.get("HOME")) |home| {
        if (home.len <= home_buf.len) {
            @memcpy(home_buf[0..home.len], home);
            home_len = home.len;
        }
    }
    var app = App{ .env_map = init.environ_map };
    try runner.runWithOptions(app.app(), .{
        .app_name = "mdv",
        .window_title = "mdv",
        .bundle_id = "au.com.bellizzi.mdv",
        .icon_path = "assets/icon.png",
        .bridge = .{
            .policy = .{ .enabled = true, .commands = &mdv_command_policies },
            .registry = .{ .handlers = &mdv_handlers },
        },
        .builtin_bridge = .{ .enabled = true, .commands = &builtin_command_policies },
        .security = .{
            .navigation = .{ .allowed_origins = &dev_origins },
        },
    }, init);
}

test "payloadPath extracts plain and escaped paths" {
    var buf: [256]u8 = undefined;
    const p1 = payloadPath("{\"path\":\"/tmp/a b.md\"}", &buf).?;
    try std.testing.expectEqualStrings("/tmp/a b.md", p1);
    const p2 = payloadPath("{\"path\":\"/tmp/q\\\"x\\\\y.md\"}", &buf).?;
    try std.testing.expectEqualStrings("/tmp/q\"x\\y.md", p2);
}

test "payloadWindowId extracts the windowId field" {
    try std.testing.expectEqual(@as(?u64, 42), payloadWindowId("{\"windowId\":42,\"path\":\"/tmp/a.md\"}"));
    try std.testing.expectEqual(@as(?u64, 7), payloadWindowId("{\"path\":\"/tmp/a.md\",\"windowId\": 7}"));
    try std.testing.expectEqual(@as(?u64, null), payloadWindowId("{\"path\":\"/tmp/a.md\"}"));
    try std.testing.expectEqual(@as(?u64, null), payloadWindowId("{\"windowId\":\"nope\"}"));
}

test "assignPath/claimPath: store, overwrite, and full-table behavior" {
    var table = [_]WindowSlot{.{}} ** 4;

    try std.testing.expect(assignPath(&table, 2, "/tmp/a.md"));
    try std.testing.expectEqualStrings("/tmp/a.md", claimPath(&table, 2).?);
    try std.testing.expectEqual(@as(?[]const u8, null), claimPath(&table, 3));

    // overwriting the same window id replaces its path, no new slot used.
    try std.testing.expect(assignPath(&table, 2, "/tmp/b.md"));
    try std.testing.expectEqualStrings("/tmp/b.md", claimPath(&table, 2).?);

    try std.testing.expect(assignPath(&table, 3, "/tmp/c.md"));
    try std.testing.expect(assignPath(&table, 4, "/tmp/d.md"));
    try std.testing.expect(assignPath(&table, 5, "/tmp/e.md"));
    // table (4 slots) now holds windows 2,3,4,5 -- no room for a new one.
    try std.testing.expect(!assignPath(&table, 6, "/tmp/f.md"));

    // window_id 0 is the free-slot sentinel and must never be assignable.
    try std.testing.expect(!assignPath(&table, 0, "/tmp/g.md"));
}
