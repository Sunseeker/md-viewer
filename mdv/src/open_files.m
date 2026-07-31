// mdv open-files + edit-menu shim.
//
// Open files: the Native SDK's NativeSdkAppDelegate (0.4.4 and 0.5.4)
// implements no application:openFiles:, so Finder's odoc Apple Event is
// dropped and double-clicked documents never reach the app. This file
// injects the missing delegate method at runtime and queues the delivered
// paths for the Zig core to drain over the JS bridge.
//
// Edit menu: when app.zon declares custom .menus, the SDK's
// setMenusWithTitles builds ONLY the app menu plus those custom menus,
// dropping the default File/Edit/View/Window set -- so Cmd+C had no key
// equivalent anywhere in the menu bar and just beeped. mdv_install_edit_menu
// re-inserts a standard Edit menu (nil-target selectors ride the responder
// chain into the WKWebView). Menus are configured once at runtime startup
// (runtime/flow.zig configureMenus), never re-set, so a one-time insert
// after didFinishLaunching sticks.
//
// Remove once the SDK delivers open-file events / merges default menus itself.

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <CoreServices/CoreServices.h>
#import <objc/runtime.h>
#include <stdlib.h>
#include <string.h>

static NSMutableArray<NSString *> *mdv_queue;
static NSLock *mdv_lock;
// 0 = not installed, 1 = delegate method injected, 2 = AE fallback handler
static volatile int mdv_status = 0;

static void mdv_debug_log(NSString *line) {
    const char *path = getenv("MDV_DEBUG_LOG");
    if (!path) return;
    NSFileHandle *h = [NSFileHandle fileHandleForWritingAtPath:@(path)];
    if (!h) {
        [[NSFileManager defaultManager] createFileAtPath:@(path) contents:nil attributes:nil];
        h = [NSFileHandle fileHandleForWritingAtPath:@(path)];
        if (!h) return;
    }
    @try {
        [h seekToEndOfFile];
        [h writeData:[[line stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding]];
        [h closeFile];
    } @catch (NSException *e) {
        (void)e;
    }
}

static void mdv_enqueue(NSArray<NSString *> *paths) {
    if (paths.count == 0) return;
    [mdv_lock lock];
    [mdv_queue addObjectsFromArray:paths];
    [mdv_lock unlock];
    mdv_debug_log([NSString stringWithFormat:@"enqueue status=%d %@", mdv_status, [paths componentsJoinedByString:@"|"]]);
}

static void mdv_openFiles_imp(id self, SEL _cmd, NSApplication *app, NSArray<NSString *> *files) {
    (void)self;
    (void)_cmd;
    mdv_enqueue(files);
    [app replyToOpenOrPrint:NSApplicationDelegateReplySuccess];
}

// Minimal app delegate for SDK versions (0.4.x) that never set one.
// Implements ONLY open-file delivery; everything else keeps AppKit defaults.
@interface MdvAppDelegate : NSObject <NSApplicationDelegate>
@end

@implementation MdvAppDelegate
- (void)application:(NSApplication *)app openFiles:(NSArray<NSString *> *)files {
    mdv_enqueue(files);
    [app replyToOpenOrPrint:NSApplicationDelegateReplySuccess];
}
@end

static MdvAppDelegate *mdv_delegate; // NSApp.delegate is unretained; keep it alive

@interface MdvAEHandler : NSObject
@end

@implementation MdvAEHandler
+ (void)handleOpenDocuments:(NSAppleEventDescriptor *)event withReplyEvent:(NSAppleEventDescriptor *)reply {
    (void)reply;
    NSAppleEventDescriptor *list = [event paramDescriptorForKeyword:keyDirectObject];
    NSMutableArray<NSString *> *paths = [NSMutableArray array];
    for (NSInteger i = 1; i <= [list numberOfItems]; i++) {
        NSAppleEventDescriptor *item = [[list descriptorAtIndex:i] coerceToDescriptorType:typeFileURL];
        if (!item) continue;
        NSString *urlString = [[NSString alloc] initWithData:item.data encoding:NSUTF8StringEncoding];
        if (!urlString) continue;
        NSURL *url = [NSURL URLWithString:urlString];
        if (url.isFileURL && url.path) [paths addObject:url.path];
    }
    mdv_enqueue(paths);
}
@end

static NSMenuItem *mdv_edit_item(NSString *title, SEL action, NSString *key, NSEventModifierFlags mods) {
    // nil target: the action resolves through the responder chain, which
    // is what routes copy:/selectAll: into the focused WKWebView.
    NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:action keyEquivalent:key];
    item.keyEquivalentModifierMask = mods;
    return item;
}

static void mdv_install_edit_menu(void) {
    NSMenu *mainMenu = [NSApp mainMenu];
    if (!mainMenu) {
        mdv_debug_log(@"edit menu: no main menu yet, skipped");
        return;
    }
    for (NSMenuItem *top in mainMenu.itemArray) {
        if ([top.title isEqualToString:@"Edit"]) return; // SDK grew one back
    }
    NSMenuItem *editItem = [[NSMenuItem alloc] initWithTitle:@"Edit" action:nil keyEquivalent:@""];
    NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];
    editItem.submenu = editMenu;
    [editMenu addItem:mdv_edit_item(@"Undo", @selector(undo:), @"z", NSEventModifierFlagCommand)];
    [editMenu addItem:mdv_edit_item(@"Redo", @selector(redo:), @"Z", NSEventModifierFlagCommand)];
    [editMenu addItem:[NSMenuItem separatorItem]];
    [editMenu addItem:mdv_edit_item(@"Cut", @selector(cut:), @"x", NSEventModifierFlagCommand)];
    [editMenu addItem:mdv_edit_item(@"Copy", @selector(copy:), @"c", NSEventModifierFlagCommand)];
    [editMenu addItem:mdv_edit_item(@"Paste", @selector(paste:), @"v", NSEventModifierFlagCommand)];
    [editMenu addItem:mdv_edit_item(@"Select All", @selector(selectAll:), @"a", NSEventModifierFlagCommand)];
    // After the bold app menu (index 0), before the custom manifest menus.
    [mainMenu insertItem:editItem atIndex:MIN(1, mainMenu.numberOfItems)];
    mdv_debug_log(@"edit menu installed");
}

__attribute__((constructor)) static void mdv_install(void) {
    mdv_queue = [NSMutableArray new];
    mdv_lock = [NSLock new];
    mdv_debug_log(@"shim constructor");

    // Edit menu goes in after launch: the SDK sets manifest menus once
    // before the run loop starts, so didFinishLaunching + a main-queue hop
    // is guaranteed to run after them and never get overwritten.
    [[NSNotificationCenter defaultCenter]
        addObserverForName:NSApplicationDidFinishLaunchingNotification
                    object:nil
                     queue:nil
                usingBlock:^(NSNotification *note) {
                    (void)note;
                    dispatch_async(dispatch_get_main_queue(), ^{
                        mdv_install_edit_menu();
                    });
                }];

    // macOS delivers the cold-launch odoc between will/didFinishLaunching,
    // so open-file handling must be wired at willFinishLaunching or earlier.
    [[NSNotificationCenter defaultCenter]
        addObserverForName:NSApplicationWillFinishLaunchingNotification
                    object:nil
                     queue:nil
                usingBlock:^(NSNotification *note) {
                    (void)note;
                    id existing = [NSApp delegate];
                    if (!existing) {
                        // SDK 0.4.x: no delegate at all -- install ours.
                        mdv_delegate = [MdvAppDelegate new];
                        [NSApp setDelegate:mdv_delegate];
                        mdv_status = 1;
                        mdv_debug_log(@"installed MdvAppDelegate (no SDK delegate)");
                        return;
                    }
                    // SDK 0.5.x+: delegate exists; add the missing method.
                    if (class_addMethod(object_getClass(existing), @selector(application:openFiles:), (IMP)mdv_openFiles_imp, "v@:@@")) {
                        mdv_status = 1;
                        mdv_debug_log([NSString stringWithFormat:@"injected openFiles into %s", class_getName(object_getClass(existing))]);
                        return;
                    }
                    // Delegate already implements openFiles (future SDK):
                    // take over the odoc AE handler after AppKit installs its
                    // own so ours wins. Warm opens only; cold launch would be
                    // the SDK's own (then-working) path.
                    [[NSNotificationCenter defaultCenter]
                        addObserverForName:NSApplicationDidFinishLaunchingNotification
                                    object:nil
                                     queue:nil
                                usingBlock:^(NSNotification *n2) {
                                    (void)n2;
                                    [[NSAppleEventManager sharedAppleEventManager]
                                        setEventHandler:[MdvAEHandler class]
                                            andSelector:@selector(handleOpenDocuments:withReplyEvent:)
                                          forEventClass:kCoreEventClass
                                             andEventID:kAEOpenDocuments];
                                    mdv_status = 2;
                                    mdv_debug_log(@"installed AE fallback handler");
                                }];
                }];
}

// C surface for the Zig core.

// Copies pending paths, newline-joined UTF-8, into buf and clears the queue.
// Returns bytes written, 0 when empty, -1 when buf is too small (queue kept).
long mdv_take_pending(char *buf, long cap) {
    [mdv_lock lock];
    if (mdv_queue.count == 0) {
        [mdv_lock unlock];
        return 0;
    }
    NSString *joined = [mdv_queue componentsJoinedByString:@"\n"];
    NSData *data = [joined dataUsingEncoding:NSUTF8StringEncoding];
    if ((long)data.length > cap) {
        [mdv_lock unlock];
        return -1;
    }
    memcpy(buf, data.bytes, data.length);
    [mdv_queue removeAllObjects];
    [mdv_lock unlock];
    return (long)data.length;
}

int mdv_shim_status(void) {
    return mdv_status;
}
