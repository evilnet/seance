// The phones' plugins: one Kotlin (Android) or Swift (iOS) class, `Seance`,
// answers every plugin the page calls by the name and shape the Capacitor
// shells give it — `call` is `{plugin, method, options}` in, the method's
// result or a rejection with its code out. Its events come back through one
// channel handed to it at start, and go to the page through `emit()`, so no
// Tauri plugin API is exposed to the page here either.
//
// Haptics is Tauri's own plugin, through its Rust API.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_haptics::{HapticsExt, ImpactFeedbackStyle};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_seance);

struct Seance(PluginHandle<Wry>);

#[derive(Serialize)]
struct EventHandler {
    handler: Channel,
}

#[derive(Deserialize)]
struct Event {
    plugin: String,
    event: String,
    #[serde(default)]
    data: Value,
    #[serde(default)]
    retain: bool,
}

#[derive(Serialize)]
struct Call<'a> {
    plugin: &'a str,
    method: &'a str,
    options: &'a Value,
}

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("seance")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle = api.register_android_plugin("chat.seance.app", "SeancePlugin")?;
            #[cfg(target_os = "ios")]
            let handle = api.register_ios_plugin(init_plugin_seance)?;

            let events = app.clone();
            handle.run_mobile_plugin::<()>(
                "setEventHandler",
                EventHandler {
                    handler: Channel::new(move |body| {
                        if let InvokeResponseBody::Json(text) = body {
                            let Ok(e) = serde_json::from_str::<Event>(&text) else {
                                return Ok(());
                            };

                            super::emit(&events, &e.plugin, &e.event, e.data, e.retain);
                        }
                        Ok(())
                    }),
                },
            )?;

            app.manage(Seance(handle));
            Ok(())
        })
        .build()
}

/// The method's result, or its error's `(code, message)`; `unimplemented`
/// for a plugin or method the phone does not have.
pub async fn call(
    app: &AppHandle,
    plugin: &str,
    method: &str,
    options: &Value,
) -> Result<Value, (String, String)> {
    if plugin == "Haptics" {
        return haptics(app, method, options);
    }

    let handle = app.state::<Seance>().0.clone();
    let (plugin, method, options) = (plugin.to_owned(), method.to_owned(), options.clone());

    // The Kotlin or Swift answers on its own thread; wait off the runtime.
    tauri::async_runtime::spawn_blocking(move || {
        handle.run_mobile_plugin::<Value>(
            "call",
            Call {
                plugin: &plugin,
                method: &method,
                options: &options,
            },
        )
    })
    .await
    .map_err(|_| ("failed".to_owned(), "no answer".to_owned()))?
    .map_err(|e| match e {
        tauri::plugin::mobile::PluginInvokeError::InvokeRejected(r) => (
            r.code.unwrap_or_else(|| "failed".into()),
            r.message.unwrap_or_default(),
        ),
        other => ("failed".to_owned(), other.to_string()),
    })
}

/// Capacitor's `Haptics.impact({style: "LIGHT" | "MEDIUM" | "HEAVY"})`.
fn haptics(app: &AppHandle, method: &str, options: &Value) -> Result<Value, (String, String)> {
    if method != "impact" {
        return Err((
            "unimplemented".into(),
            format!("Haptics.{method} is not implemented"),
        ));
    }

    let style = match options.get("style").and_then(Value::as_str) {
        Some("LIGHT") => ImpactFeedbackStyle::Light,
        Some("HEAVY") => ImpactFeedbackStyle::Heavy,
        _ => ImpactFeedbackStyle::Medium,
    };

    app.haptics()
        .impact_feedback(style)
        .map(|_| json!({}))
        .map_err(|e| ("failed".to_owned(), e.to_string()))
}
