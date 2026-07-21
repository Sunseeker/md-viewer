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

const App = struct {
    env_map: *std.process.Environ.Map,

    fn app(self: *@This()) native_sdk.App {
        return .{
            .context = self,
            .name = "mdv",
            .source = native_sdk.frontend.productionSource(.{ .dist = "frontend/dist" }),
            .source_fn = source,
        };
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

// Extracts payload.path (JSON string, common escapes) into out.
fn payloadPath(payload: []const u8, out: []u8) ?[]const u8 {
    const key = "\"path\"";
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

fn mtimeMs(ts: std.Io.Timestamp) i64 {
    return @intCast(@divTrunc(ts.nanoseconds, std.time.ns_per_ms));
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

const mdv_handlers = [_]bridge.Handler{
    .{ .name = "mdv.pending", .context = @ptrCast(&bridge_ctx), .invoke_fn = hPending },
    .{ .name = "mdv.stat", .context = @ptrCast(&bridge_ctx), .invoke_fn = hStat },
    .{ .name = "mdv.read", .context = @ptrCast(&bridge_ctx), .invoke_fn = hRead },
};

const mdv_command_policies = [_]bridge.CommandPolicy{
    .{ .name = "mdv.pending" },
    .{ .name = "mdv.stat" },
    .{ .name = "mdv.read" },
};

const dev_origins = [_][]const u8{ "zero://app", "zero://inline", "http://127.0.0.1:5173" };

pub fn main(init: std.process.Init) !void {
    g_io = init.io;
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
