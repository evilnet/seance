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
/// neither swap the bridge nor fake an event through it.
fn init_script(version: &str) -> String {
    format!(
        r#"(() => {{
	const listeners = new Map();
	Object.defineProperty(window, "__seanceShellEmit", {{
		value: (plugin, event, data) => {{
			for (const cb of listeners.get(plugin + "." + event) ?? []) {{
				try {{ cb(data); }} catch (e) {{ console.error(e); }}
			}}
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
    code: &'static str,
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
    value.len() > 9 && value[..9].eq_ignore_ascii_case("web+irc:/")
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
        emit(app, "App", "appUrlOpen", json!({ "url": link }));
    }

    show_main(app);
}

fn emit(app: &AppHandle, plugin: &str, event: &str, data: Value) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.eval(format!(
            "window.__seanceShellEmit({}, {}, {})",
            json!(plugin),
            json!(event),
            data
        ));
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
fn seance_call(
    window: WebviewWindow,
    links: State<'_, Mutex<Links>>,
    plugin: String,
    method: String,
    options: Value,
) -> Result<Value, ShellError> {
    if window.label() != MAIN {
        return Err(ShellError {
            message: "not the app's page".into(),
            code: "denied",
        });
    }

    // The dock (macOS) and launchers that show a count (Linux); a Windows
    // taskbar takes an overlay image, not a number.
    let badge = PLATFORM != "windows";

    match (plugin.as_str(), method.as_str()) {
        ("App", "getLaunchUrl") => {
            let mut links = links.lock().unwrap();
            links.listening = true;
            Ok(json!({ "url": links.launch }))
        }
        ("Badge", "checkPermissions" | "requestPermissions") if badge => {
            Ok(json!({ "display": "granted" }))
        }
        ("Badge", "set") if badge => {
            let count = options
                .get("count")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                .max(0);
            let _ = window.set_badge_count((count > 0).then_some(count));
            Ok(json!({}))
        }
        ("Badge", "clear") if badge => {
            let _ = window.set_badge_count(None);
            Ok(json!({}))
        }
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
        _ => Err(ShellError {
            message: format!("{plugin}.{method} is not implemented"),
            code: "unimplemented",
        }),
    }
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
        .on_page_load(move |_, payload| {
            if payload.event() == PageLoadEvent::Started {
                handle.state::<Mutex<Links>>().lock().unwrap().listening = false;
            }

            #[cfg(debug_assertions)]
            if payload.event() == PageLoadEvent::Finished {
                smoke::page_loaded(&handle);
            }
        })
        .build()
}

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
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = hide.hide();
            }
        });
    }

    Ok(())
}

pub fn run() {
    let launch_arg = std::env::args().skip(1).find(|arg| is_irc_link(arg));

    let app = tauri::Builder::default()
        // First: a second launch hands its argv (Windows, Linux: the link)
        // to this one and exits.
        .plugin(tauri_plugin_single_instance::init(
            |app, argv, _| match argv.into_iter().skip(1).find(|arg| is_irc_link(arg)) {
                Some(link) => open_link(app, link),
                None => show_main(app),
            },
        ))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(Mutex::new(Links {
            launch: launch_arg,
            listening: false,
        }))
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

            create_main(app.handle())?;
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
