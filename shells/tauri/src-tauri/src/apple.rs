// macOS's LocalNotifications: the Swift package under swift/ answers it with
// the methods and shapes the iOS shell's plugin answers too (the same Swift,
// SeanceNotifications), so the page has one code path. Two C entry points
// for the page's plugins (a third, `place_window`, is the window's): `start`, once,
// with the callback their events come back through, and `call`, the plugin,
// the method and its options as JSON in, and a callback, on any thread, with
// `{"ok": …}` or `{"err": {code, message}}`.

use serde_json::Value;
use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::{mpsc, OnceLock};
use tauri::AppHandle;

type Done = extern "C" fn(*mut c_void, *const c_char);
type Event = extern "C" fn(*const c_char, *const c_char, *const c_char, bool);

extern "C" {
    fn seance_apple_start(event: Event);
    fn seance_window_place(window: *mut c_void);
    fn seance_apple_call(
        plugin: *const c_char,
        method: *const c_char,
        options: *const c_char,
        context: *mut c_void,
        done: Done,
    );
}

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Make the plugins; their events go to the page from here on.
pub fn start(app: &AppHandle) {
    if APP.set(app.clone()).is_ok() {
        // SAFETY: called once; Swift keeps the function pointer.
        unsafe { seance_apple_start(event) };
    }
}

/// The window's size and place from here on: put back where the user left it
/// in this arrangement of displays, and again whenever the displays change
/// (swift/Sources/SeanceTauri/WindowPlace.swift). On the main thread, once.
pub fn place_window(window: &tauri::WebviewWindow) {
    if let Ok(ns_window) = window.ns_window() {
        // SAFETY: a live NSWindow, on the main thread (Tauri's setup).
        unsafe { seance_window_place(ns_window) };
    }
}

extern "C" fn event(plugin: *const c_char, name: *const c_char, data: *const c_char, retain: bool) {
    let text = |p: *const c_char| unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
    let data = serde_json::from_str(&text(data)).unwrap_or(Value::Null);

    if let Some(app) = APP.get() {
        super::emit(app, &text(plugin), &text(name), data, retain);
    }
}

extern "C" fn done(context: *mut c_void, json: *const c_char) {
    // SAFETY: `context` is the sender `call` boxed, and Swift calls back once.
    let sender = unsafe { Box::from_raw(context as *mut mpsc::Sender<String>) };
    let text = unsafe { CStr::from_ptr(json) }
        .to_string_lossy()
        .into_owned();
    let _ = sender.send(text);
}

/// The method's result, or its error's `(code, message)`; `unimplemented`
/// for a plugin or method Swift does not have.
pub async fn call(plugin: &str, method: &str, options: &Value) -> Result<Value, (String, String)> {
    let bad = |message: &str| ("badRequest".to_owned(), message.to_owned());
    let plugin = CString::new(plugin).map_err(|_| bad("bad plugin"))?;
    let method = CString::new(method).map_err(|_| bad("bad method"))?;
    let options = CString::new(options.to_string()).map_err(|_| bad("bad options"))?;
    let (sender, receiver) = mpsc::channel::<String>();
    let context = Box::into_raw(Box::new(sender)) as *mut c_void;

    // SAFETY: Swift copies the strings before it returns.
    unsafe {
        seance_apple_call(
            plugin.as_ptr(),
            method.as_ptr(),
            options.as_ptr(),
            context,
            done,
        )
    };

    // The permission prompt waits on the user; wait off the runtime.
    let text = tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .ok()
        .and_then(Result::ok)
        .ok_or_else(|| ("failed".to_owned(), "no answer from Swift".to_owned()))?;
    let mut answer: Value =
        serde_json::from_str(&text).map_err(|_| ("failed".to_owned(), text.clone()))?;

    if let Some(ok) = answer.get_mut("ok") {
        return Ok(ok.take());
    }

    let err = answer.get("err");
    let field = |key: &str| {
        err.and_then(|e| e.get(key))
            .and_then(Value::as_str)
            .unwrap_or("failed")
            .to_owned()
    };
    Err((field("code"), field("message")))
}
