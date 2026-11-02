// Seance's Tauri shell (docs/projects/desktop-shells.md). The window loads the
// built SPA from the bundle — `public/`, compiled in by `frontendDist` — and
// the page speaks IRC over WebSocket itself; the shell adds a window, links,
// the badge and the platform's close behaviour.
//
// The page reaches the shell through `window.seanceShell` (the init script
// below), the contract client/js/helpers/shell.ts reads in every shell:
// `call(plugin, method, options)` is one `seance_call` command answered by
// `seance_call()` here with the plugin names and shapes the Capacitor shells
// use, and `listen(plugin, event, cb)` hears what `emit()` evaluates in the
// page. No Tauri plugin API is exposed to the page (capabilities/default.json).

#[cfg(not(target_os = "macos"))]
mod alerts;
#[cfg(target_os = "macos")]
mod apple;

use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;

const MAIN: &str = "main";

#[cfg(target_os = "macos")]
const PLATFORM: &str = "macos";
#[cfg(target_os = "windows")]
const PLATFORM: &str = "windows";
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const PLATFORM: &str = "linux";

/// `window.seanceShell`, defined before any of the page's scripts run. The
/// object is frozen and the emit hook is not writable, so a page script can
/// neither swap the bridge nor fake an event through it. A retained event
/// nobody listens to yet waits for its first listener, as Capacitor's
/// `retainUntilConsumed` does.
fn init_script(version: &str) -> String {
    format!(
        r#"(() => {{
	const listeners = new Map();
	const held = new Map();
	const deliver = (cb, data) => {{
		try {{ cb(data); }} catch (e) {{ console.error(e); }}
	}};
	Object.defineProperty(window, "__seanceShellEmit", {{
		value: (plugin, event, data, retain) => {{
			const key = plugin + "." + event;
			const cbs = listeners.get(key) ?? [];
			if (retain && !cbs.length) {{
				held.set(key, [...(held.get(key) ?? []), data]);
			}}
			for (const cb of cbs) deliver(cb, data);
		}},
	}});
	window.seanceShell = Object.freeze({{
		platform: {platform},
		version: {version},
		call: (plugin, method, options) =>
			window.__TAURI_INTERNALS__.invoke("seance_call", {{plugin, method, options: options ?? {{}}}}),
		listen(plugin, event, cb) {{
			const key = plugin + "." + event;
			listeners.set(key, [...(listeners.get(key) ?? []), cb]);
			const waiting = held.get(key) ?? [];
			held.delete(key);
			for (const data of waiting) deliver(cb, data);
		}},
	}});
}})();"#,
        platform = json!(PLATFORM),
        version = json!(version),
    )
}

/// What a refused call rejects with: the page's `NativeCallError` reads both.
#[derive(Serialize)]
struct ShellError {
    message: String,
    code: String,
}

/// The `web+irc:` links the page has not been handed yet.
#[derive(Default)]
struct Links {
    /// What `App.getLaunchUrl` answers: the link the app was opened with, or
    /// one that came while the page was (re)loading. The page notes the links
    /// it has acted on (client/js/native.ts), so answering a reload with the
    /// same link again is harmless.
    launch: Option<String>,
    /// The loaded page asked for its launch link — it subscribes to
    /// `App.appUrlOpen` in the same turn — and has not reloaded since.
    listening: bool,
}

fn is_irc_link(value: &str) -> bool {
    value.len() > 9 && value.get(..9).is_some_and(|p| p.eq_ignore_ascii_case("web+irc:/"))
}

/// A link from the OS (a deep link, a second launch's argv): to the running
/// page at once, else kept for its `App.getLaunchUrl`.
fn open_link(app: &AppHandle, link: String) {
    if !is_irc_link(&link) {
        return;
    }

    let listening = {
        let links = app.state::<Mutex<Links>>();
        let mut links = links.lock().unwrap();

        if !links.listening {
            links.launch = Some(link.clone());
        }

        links.listening
    };

    if listening {
        emit(app, "App", "appUrlOpen", json!({ "url": link }), false);
    }

    show_main(app);
}

/// Retained events that came while no page was loaded to hold them: a click
/// on an alert that launched the app, or one during a reload.
#[derive(Default)]
struct Held {
    loaded: bool,
    scripts: Vec<String>,
}

/// Hand the page a plugin's event. A `retain`ed one is something the user did
/// outside the window (a click on an alert): the window comes forward and the
/// event waits for the page, then for its first listener.
fn emit(app: &AppHandle, plugin: &str, event: &str, data: Value, retain: bool) {
    let script = format!(
        "window.__seanceShellEmit({}, {}, {}, {})",
        json!(plugin),
        json!(event),
        data,
        retain
    );

    if retain {
        show_main(app);
        let held = app.state::<Mutex<Held>>();
        let mut held = held.lock().unwrap();

        if !held.loaded {
            held.scripts.push(script);
            return;
        }
    }

    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.eval(script);
    }
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
async fn seance_call(
    window: WebviewWindow,
    links: State<'_, Mutex<Links>>,
    plugin: String,
    method: String,
    options: Value,
) -> Result<Value, ShellError> {
    if window.label() != MAIN {
        return Err(ShellError {
            message: "not the app's page".into(),
            code: "denied".into(),
        });
    }

    match (plugin.as_str(), method.as_str()) {
        ("App", "getLaunchUrl") => {
            let mut links = links.lock().unwrap();
            links.listening = true;
            Ok(json!({ "url": links.launch }))
        }
        // The Dock bounces once, the taskbar button flashes, the window is
        // marked urgent; nothing while the window has the focus.
        ("App", "requestAttention") => {
            if !window.is_focused().unwrap_or(false) {
                let _ =
                    window.request_user_attention(Some(tauri::UserAttentionType::Informational));
            }
            Ok(json!({}))
        }
        ("Badge", "checkPermissions" | "requestPermissions") => Ok(json!({ "display": "granted" })),
        ("Badge", "set") => {
            let count = options
                .get("count")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                .max(0);
            set_badge(&window, count);
            Ok(json!({}))
        }
        ("Badge", "clear") => {
            set_badge(&window, 0);
            Ok(json!({}))
        }
        #[cfg(not(target_os = "macos"))]
        ("LocalNotifications", _) => alerts::call(window.app_handle(), &method, &options),
        #[cfg(all(debug_assertions, feature = "snapshot"))]
        ("Smoke", "snapshot") => {
            let path = options
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("snapshot.tiff");
            snapshot::take(&window, path.to_owned());
            Ok(json!({}))
        }
        #[cfg(debug_assertions)]
        ("Smoke", "report") => {
            smoke::report(window.app_handle(), &options);
            Ok(json!({}))
        }
        _ => native(&plugin, &method, &options).await,
    }
}

/// The last count asked for (Windows): a window hidden in the notification
/// area has no taskbar button and its dot goes with it, and the button that
/// comes back with the window exists only some time after `show()`, so the
/// dot is put back when the window takes the focus.
#[cfg(windows)]
static BADGE: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

/// The unread count on the app's icon: the Dock (macOS) and launchers that
/// show a count (Linux). A Windows taskbar button takes a small image over
/// its icon, not a number, so there it is a dot while anything is unread.
fn set_badge(window: &WebviewWindow, count: i64) {
    #[cfg(windows)]
    {
        BADGE.store(count, std::sync::atomic::Ordering::Relaxed);
        let _ = window.set_overlay_icon((count > 0).then(unread_dot));
    }

    #[cfg(not(windows))]
    let _ = window.set_badge_count((count > 0).then_some(count));
}

/// A red dot with a white rim, 16 px as Windows draws an overlay, its edge
/// anti-aliased.
#[cfg(windows)]
fn unread_dot() -> tauri::image::Image<'static> {
    const SIZE: u32 = 16;
    let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    let centre = SIZE as f32 / 2.0;

    for y in 0..SIZE {
        for x in 0..SIZE {
            let d = ((x as f32 + 0.5 - centre).powi(2) + (y as f32 + 0.5 - centre).powi(2)).sqrt();
            let alpha = (centre - d).clamp(0.0, 1.0);
            let rim = (d - (centre - 2.0)).clamp(0.0, 1.0);
            let mix = |red: f32, white: f32| (red * (1.0 - rim) + white * rim) as u8;
            rgba.extend_from_slice(&[
                mix(220.0, 255.0),
                mix(38.0, 255.0),
                mix(38.0, 255.0),
                (alpha * 255.0) as u8,
            ]);
        }
    }

    tauri::image::Image::new_owned(rgba, SIZE, SIZE)
}

/// What the shell's own Rust does not answer: on macOS the message alerts,
/// in Swift (src/apple.rs).
#[cfg(target_os = "macos")]
async fn native(plugin: &str, method: &str, options: &Value) -> Result<Value, ShellError> {
    apple::call(plugin, method, options)
        .await
        .map_err(|(code, message)| ShellError { message, code })
}

#[cfg(not(target_os = "macos"))]
async fn native(plugin: &str, method: &str, _: &Value) -> Result<Value, ShellError> {
    Err(ShellError {
        message: format!("{plugin}.{method} is not implemented"),
        code: "unimplemented".into(),
    })
}

/// The app's own pages: the bundled assets, never the network — except
/// under `tauri dev`, which serves them from the CLI's dev server
/// (`dev_url`), so that origin is the app's too.
fn is_app_url(url: &Url, dev_url: Option<&Url>) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => {
            url.host_str() == Some("tauri.localhost")
                || (tauri::is_dev() && dev_url.is_some_and(|dev| dev.origin() == url.origin()))
        }
        _ => false,
    }
}

/// Off-app links go to the user's browser; anything but http(s) nowhere.
fn open_external(url: &Url) {
    if matches!(url.scheme(), "http" | "https") {
        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
    }
}

fn create_main(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let version = app.package_info().version.to_string();
    let handle = app.clone();
    let dev_url = app.config().build.dev_url.clone();

    WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title(app.package_info().name.clone())
        .inner_size(1100.0, 760.0)
        .min_inner_size(400.0, 300.0)
        .initialization_script(init_script(&version))
        // The window navigates inside the app alone; target=_blank and
        // window.open() never make a window.
        .on_navigation(move |url| {
            let inside = is_app_url(url, dev_url.as_ref());

            if !inside {
                open_external(url);
            }

            inside
        })
        .on_new_window(|url, _| {
            open_external(&url);
            NewWindowResponse::Deny
        })
        .on_page_load(move |webview, payload| {
            let started = payload.event() == PageLoadEvent::Started;

            if started {
                handle.state::<Mutex<Links>>().lock().unwrap().listening = false;
            }

            let waiting = {
                let held = handle.state::<Mutex<Held>>();
                let mut held = held.lock().unwrap();
                held.loaded = !started;

                if started {
                    Vec::new()
                } else {
                    std::mem::take(&mut held.scripts)
                }
            };

            for script in waiting {
                let _ = webview.eval(script);
            }

            #[cfg(debug_assertions)]
            if payload.event() == PageLoadEvent::Finished {
                smoke::page_loaded(&handle);
            }
        })
        .build()
}

/// Misspellings underlined in text fields, with the guesses on a right-click
/// (WebKitGTK's own menu). WebView2 and WKWebView spell-check out of the box;
/// WebKitGTK ships with it off and, with no languages named, checks against
/// none, so it gets the locale's (a language without a dictionary installed
/// is skipped).
#[cfg(all(unix, not(target_os = "macos")))]
fn enable_spell_checking(window: &WebviewWindow) {
    use webkit2gtk::{WebContextExt, WebViewExt};

    let languages = locale_languages();
    let _ = window.with_webview(move |webview| {
        if let Some(context) = webview.inner().context() {
            let names: Vec<&str> = languages.iter().map(String::as_str).collect();
            context.set_spell_checking_languages(&names);
            context.set_spell_checking_enabled(true);
        }
    });
}

/// The user's languages as dictionary names (`en_US`), most wanted first:
/// gettext's order — `LANGUAGE`'s list, then the first of `LC_ALL`,
/// `LC_MESSAGES` and `LANG` that is set.
#[cfg(all(unix, not(target_os = "macos")))]
fn locale_languages() -> Vec<String> {
    let var = |name| std::env::var(name).ok().filter(|v| !v.is_empty());
    let mut found = Vec::new();
    let candidates = var("LANGUAGE")
        .into_iter()
        .flat_map(|list| list.split(':').map(str::to_owned).collect::<Vec<_>>())
        .chain(["LC_ALL", "LC_MESSAGES", "LANG"].into_iter().find_map(var));

    for locale in candidates {
        // en_US.UTF-8@euro → en_US
        let name = locale.split(['.', '@']).next().unwrap_or("").to_owned();

        if !name.is_empty() && name != "C" && name != "POSIX" && !found.contains(&name) {
            found.push(name);
        }
    }

    found
}

#[cfg(not(all(unix, not(target_os = "macos"))))]
fn enable_spell_checking(_: &WebviewWindow) {}

/// Close follows the platform (desktop-shells.md § 5.2): a Mac app keeps
/// running in the Dock and the window comes back from its icon; on Windows
/// the window goes to the notification area; on Linux, where a tray may not
/// be shown at all, closing the window quits.
fn install_close_behaviour(app: &AppHandle) -> tauri::Result<()> {
    if PLATFORM == "linux" {
        return Ok(());
    }

    #[cfg(windows)]
    {
        use tauri::menu::{Menu, MenuItem};
        use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};

        let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&show, &quit])?;
        let mut tray = TrayIconBuilder::with_id("main")
            .tooltip(app.package_info().name.clone())
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "show" => show_main(app),
                "quit" => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    ..
                } = event
                {
                    show_main(tray.app_handle());
                }
            });

        if let Some(icon) = app.default_window_icon() {
            tray = tray.icon(icon.clone());
        }

        tray.build(app)?;
    }

    if let Some(window) = app.get_webview_window(MAIN) {
        let hide = window.clone();
        window.on_window_event(move |event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = hide.hide();
            }
            #[cfg(windows)]
            tauri::WindowEvent::Focused(true) => {
                set_badge(&hide, BADGE.load(std::sync::atomic::Ordering::Relaxed));
            }
            _ => {}
        });
    }

    Ok(())
}

pub fn run() {
    let launch_arg = std::env::args().skip(1).find(|arg| is_irc_link(arg));

    let builder = tauri::Builder::default()
        // First: a second launch hands its argv (Windows, Linux: the link)
        // to this one and exits.
        .plugin(tauri_plugin_single_instance::init(
            |app, argv, _| match argv.into_iter().skip(1).find(|arg| is_irc_link(arg)) {
                Some(link) => open_link(app, link),
                None => show_main(app),
            },
        ))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::default().build());

    let app = builder
        .manage(Mutex::new(Links {
            launch: launch_arg,
            listening: false,
        }))
        .manage(Mutex::new(Held::default()))
        .invoke_handler(tauri::generate_handler![seance_call])
        .setup(|app| {
            let handle = app.handle().clone();

            // macOS hands links to the running app here (and the launch link
            // too, before the page has asked for it).
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    open_link(&handle, url.to_string());
                }
            });

            // An installed build registers the scheme at install time
            // (Info.plist, the installer); one run from source registers
            // nothing, so trying it never takes over this machine's links.
            #[cfg(all(not(debug_assertions), any(target_os = "linux", windows)))]
            let _ = app.deep_link().register_all();

            #[cfg(target_os = "macos")]
            apple::start(app.handle());
            #[cfg(not(target_os = "macos"))]
            alerts::setup(app.handle());

            let main = create_main(app.handle())?;
            enable_spell_checking(&main);
            install_close_behaviour(app.handle())?;

            #[cfg(debug_assertions)]
            smoke::setup();

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Seance shell");

    app.run(|app, event| {
        // macOS: a click on the Dock icon brings the hidden window back.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            show_main(app);
        }

        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}

/// `--smoke` (debug builds only): load the app, check the bridge from inside
/// the page, hand the running page a link, print what came back and exit
/// non-zero on anything wrong. `--drive=<file.js>` instead evaluates a script
/// in the page once it has loaded, for walk-throughs and screenshots.
#[cfg(debug_assertions)]
mod smoke {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    static SMOKE: AtomicBool = AtomicBool::new(false);
    static LOADED: AtomicBool = AtomicBool::new(false);

    const PROBE: &str = r##"(async () => {
	const shell = window.seanceShell;
	const out = {
		platform: shell?.platform,
		version: shell?.version,
		dataShell: document.documentElement.dataset.shell,
		dataPlatform: document.documentElement.dataset.platform,
		secureContext: window.isSecureContext,
		origin: location.origin,
		serviceWorkers: "serviceWorker" in navigator
			? (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope)
			: "none",
		bridge: await Promise.all([
			shell.call("App", "getLaunchUrl").then((v) => "App.getLaunchUrl ok " + JSON.stringify(v), (e) => "App.getLaunchUrl FAIL " + JSON.stringify(e)),
			shell.call("Haptics", "impact").then(() => "Haptics.impact FAIL answered", (e) => "Haptics.impact " + e.code),
		]),
		connectForm: !!document.getElementById("connect"),
	};
	window.__seanceSmoke = 1;
	await shell.call("Smoke", "report", {stage: "probe", out});
})();"##;

    const WARM: &str = r##"(async () => {
	await new Promise((r) => setTimeout(r, 1000));
	const out = {
		samePage: window.__seanceSmoke === 1,
		route: location.hash,
		title: document.querySelector("#connect .title")?.textContent ?? null,
		host: document.querySelector("#connect input[name=host]")?.value ?? null,
		join: document.querySelector("#connect input[name=join]")?.value ?? null,
	};
	await window.seanceShell.call("Smoke", "report", {stage: "warm", out});
})();"##;

    pub fn setup() {
        SMOKE.store(std::env::args().any(|a| a == "--smoke"), Ordering::Relaxed);
    }

    pub fn page_loaded(app: &AppHandle) {
        if LOADED.swap(true, Ordering::Relaxed) {
            return;
        }

        let Some(window) = app.get_webview_window(MAIN) else {
            return;
        };
        let drive = std::env::args().find_map(|a| a.strip_prefix("--drive=").map(String::from));

        if let Some(path) = drive {
            match std::fs::read_to_string(&path) {
                Ok(script) => {
                    let _ = window.eval(script);
                }
                Err(e) => eprintln!("drive: cannot read {path}: {e}"),
            }
        } else if SMOKE.load(Ordering::Relaxed) {
            std::thread::spawn(move || {
                // Give the SPA a moment to boot (the branding fetch, the router).
                std::thread::sleep(std::time::Duration::from_millis(1500));
                let _ = window.eval(PROBE);
            });
        }
    }

    pub fn report(app: &AppHandle, options: &Value) {
        let stage = options.get("stage").and_then(Value::as_str).unwrap_or("?");
        let out = options.get("out").cloned().unwrap_or(Value::Null);
        println!("smoke: {stage} {out}");

        if !SMOKE.load(Ordering::Relaxed) {
            return;
        }

        match stage {
            "probe" => {
                let ok = out["dataShell"] == "desktop"
                    && out["bridge"][0]
                        .as_str()
                        .is_some_and(|s| s.starts_with("App.getLaunchUrl ok"))
                    && out["bridge"][1] == "Haptics.impact unimplemented"
                    && out["serviceWorkers"]
                        .as_array()
                        .map_or(true, |a| a.is_empty());

                if !ok {
                    println!("smoke: FAIL probe");
                    app.exit(1);
                    return;
                }

                open_link(app, "web+irc://irc.smoke.test:6697/%23seance".into());

                if let Some(window) = app.get_webview_window(MAIN) {
                    let _ = window.eval(WARM);
                }
            }
            "warm" => {
                let ok = out["samePage"] == true
                    && out["host"] == "irc.smoke.test"
                    && out["join"] == "#seance";
                println!("smoke: {}", if ok { "OK" } else { "FAIL warm link" });
                app.exit(if ok { 0 } else { 1 });
            }
            _ => {}
        }
    }
}

/// The web view's own rendering, written as TIFF to `path` (macOS). It needs
/// no screen: what the page draws, not what the display shows.
#[cfg(all(debug_assertions, feature = "snapshot"))]
mod snapshot {
    use super::*;

    #[cfg(target_os = "macos")]
    pub fn take(window: &WebviewWindow, path: String) {
        use block2::RcBlock;
        use objc2_app_kit::NSImage;
        use objc2_foundation::{NSError, NSString};
        use objc2_web_kit::WKWebView;

        let scale = window.scale_factor().unwrap_or(1.0);
        if let (Ok(inner), Ok(outer)) = (window.inner_size(), window.outer_size()) {
            println!(
                "snapshot: window inner {}x{} outer {}x{} (points)",
                inner.width as f64 / scale,
                inner.height as f64 / scale,
                outer.width as f64 / scale,
                outer.height as f64 / scale
            );
        }

        let _ = window.with_webview(move |webview| {
            let wk = unsafe { &*(webview.inner() as *const WKWebView) };
            let frame = wk.frame();
            let insets = unsafe { wk.obscuredContentInsets() };
            println!(
                "snapshot: web view {}x{} at y {}, obscured insets top {} bottom {}",
                frame.size.width, frame.size.height, frame.origin.y, insets.top, insets.bottom
            );
            let path = path.clone();
            let done = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let written = unsafe { image.as_ref() }
                    .and_then(|image| image.TIFFRepresentation())
                    .is_some_and(|tiff| {
                        tiff.writeToFile_atomically(&NSString::from_str(&path), true)
                    });
                println!(
                    "snapshot: {path} {}",
                    if written {
                        "written"
                    } else if error.is_null() {
                        "empty"
                    } else {
                        "failed"
                    }
                );
            });
            // What the user sees: the web view runs under the titlebar and
            // WebKit lays the page out below it (the obscured inset). The
            // default rect (the bounds) adds the inset's height as a blank
            // band; this one, measured against the page, is the page alone.
            // with_webview runs this on the main thread.
            let mtm = objc2::MainThreadMarker::new().expect("main thread");
            let config = unsafe { objc2_web_kit::WKSnapshotConfiguration::new(mtm) };
            unsafe {
                config.setRect(objc2_core_foundation::CGRect::new(
                    objc2_core_foundation::CGPoint::new(0.0, 0.0),
                    objc2_core_foundation::CGSize::new(
                        frame.size.width,
                        frame.size.height - insets.top - insets.bottom,
                    ),
                ));
                config.setAfterScreenUpdates(true);
                wk.takeSnapshotWithConfiguration_completionHandler(Some(&config), &done)
            };
        });
    }

    #[cfg(not(target_os = "macos"))]
    pub fn take(_: &WebviewWindow, path: String) {
        println!("snapshot: {path} unsupported here");
    }
}
