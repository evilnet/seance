// LocalNotifications on Windows and Linux: the message alerts the page hands
// the OS (client/js/helpers/nativeAlerts.ts), in the shapes the Apple systems'
// Swift answers too. Linux speaks to the freedesktop notification server
// over D-Bus; Windows shows toasts through notify-rust. macOS has its own
// Swift (src/apple.rs).
//
// Not tauri-plugin-notification: it puts a script of its own into every page
// that swaps `window.Notification` for calls into commands this page may not
// use (capabilities/default.json), and on Windows reports the permission as
// granted.
//
// What the desktop notification servers allow:
// - a click opens the conversation: on Windows only while the toast is on
//   screen, not from the Action Center; on Linux as far as the server reports
//   it.
// - one alert per conversation on Linux, where a new one replaces the last
//   and reading the conversation takes it back; Windows stacks them and
//   cannot take a shown toast back.
// - no permission to ask: a desktop app may always notify (the user turns it
//   off in the OS).

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::{emit, ShellError};

pub use imp::setup;

/// A click on an alert: the page opens the conversation it was about.
fn tapped(app: &AppHandle, id: i32, extra: Value) {
    emit(
        app,
        "LocalNotifications",
        "localNotificationActionPerformed",
        json!({ "actionId": "tap", "notification": { "id": id, "extra": extra } }),
        true,
    );
}

/// What the page asked to show.
struct Alert {
    /// The page's id: one per conversation.
    id: i32,
    title: String,
    body: String,
    /// Windows plays its ping; a freedesktop server is usually silent, and
    /// the page plays its own there (helpers/notificationSound.ts).
    #[cfg_attr(not(windows), allow(dead_code))]
    sound: bool,
    /// What the alert is about, handed back on a click.
    extra: Value,
}

fn alerts(options: &Value) -> Vec<Alert> {
    options
        .get("notifications")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|alert| {
            let id = alert.get("id")?.as_i64()?;
            let text = |key: &str| {
                alert
                    .get(key)
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned()
            };
            Some(Alert {
                id: i32::try_from(id).ok()?,
                title: text("title"),
                body: text("body"),
                // The page names the Apple bundles' file; here any
                // sound asked for is the platform's own.
                sound: alert.get("sound").is_some_and(|s| !s.is_null()),
                extra: alert.get("extra").cloned().unwrap_or(Value::Null),
            })
        })
        .collect()
}

fn ids(options: &Value) -> Vec<i32> {
    options
        .get("notifications")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|n| n.get("id").and_then(Value::as_i64))
        .filter_map(|id| i32::try_from(id).ok())
        .collect()
}

pub fn call(app: &AppHandle, method: &str, options: &Value) -> Result<Value, ShellError> {
    match method {
        "checkPermissions" | "requestPermissions" => Ok(json!({ "display": "granted" })),
        "schedule" => {
            for alert in alerts(options) {
                imp::show(app, alert);
            }
            Ok(json!({}))
        }
        "removeDeliveredNotifications" => {
            imp::remove(app, ids(options));
            Ok(json!({}))
        }
        _ => Err(ShellError {
            message: format!("LocalNotifications.{method} is not implemented"),
            code: "unimplemented".into(),
        }),
    }
}

/// Linux (and the BSDs): org.freedesktop.Notifications, over one session bus
/// connection. One worker thread sends every Notify and CloseNotification in
/// the order the page asked, so the map from the page's ids to the server's
/// is never read half-written; one listener hears the clicks and the closes.
#[cfg(not(windows))]
mod imp {
    use super::{tapped, Alert, AppHandle, Manager, Value};
    use std::collections::HashMap;
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Arc, Mutex};
    use zbus::blocking::{Connection, Proxy};

    const DEST: &str = "org.freedesktop.Notifications";
    const PATH: &str = "/org/freedesktop/Notifications";

    /// The alerts on screen: by the page's id, and the page's id by the
    /// server's.
    #[derive(Default)]
    struct Live {
        shown: HashMap<i32, (u32, Value)>,
        page: HashMap<u32, i32>,
    }

    impl Live {
        fn forget_server(&mut self, server: u32) -> Option<(i32, Value)> {
            let id = self.page.remove(&server)?;
            match self.shown.get(&id) {
                Some((current, _)) if *current == server => {
                    self.shown.remove(&id).map(|(_, extra)| (id, extra))
                }
                _ => None,
            }
        }
    }

    enum Job {
        Show(Alert),
        Remove(Vec<i32>),
    }

    pub struct Alerts(Mutex<Sender<Job>>);

    pub fn setup(app: &AppHandle) {
        let (jobs, inbox) = channel::<Job>();
        app.manage(Alerts(Mutex::new(jobs)));
        let app = app.clone();

        std::thread::spawn(move || {
            // No session bus (a bare X server, a container): no alerts, as on
            // a desktop without a notification server.
            let Ok(bus) = Connection::session() else {
                return;
            };
            let live = Arc::new(Mutex::new(Live::default()));
            listen(&app, &bus, Arc::clone(&live));

            for job in inbox {
                match job {
                    Job::Show(alert) => notify(&bus, &live, &app, alert),
                    Job::Remove(ids) => {
                        let servers: Vec<u32> = {
                            let mut live = live.lock().unwrap();
                            let servers: Vec<u32> = ids
                                .iter()
                                .filter_map(|id| live.shown.get(id).map(|(server, _)| *server))
                                .collect();
                            for server in &servers {
                                live.forget_server(*server);
                            }
                            servers
                        };
                        for server in servers {
                            let _ = bus.call_method(
                                Some(DEST),
                                PATH,
                                Some(DEST),
                                "CloseNotification",
                                &(server,),
                            );
                        }
                    }
                }
            }
        });
    }

    /// The body as text. Freedesktop servers read a body as markup (links,
    /// images, bold), and an alert's body is what someone on IRC wrote:
    /// unescaped, a `<img src=…>` would have the desktop fetch it.
    pub(super) fn body_text(body: &str) -> String {
        body.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    }

    fn notify(bus: &Connection, live: &Mutex<Live>, app: &AppHandle, alert: Alert) {
        // The conversation's last alert, replaced in place.
        let replaces = live
            .lock()
            .unwrap()
            .shown
            .get(&alert.id)
            .map_or(0, |(server, _)| *server);
        let hints: HashMap<&str, zbus::zvariant::Value> = HashMap::new();
        let reply = bus.call_method(
            Some(DEST),
            PATH,
            Some(DEST),
            "Notify",
            &(
                app.package_info().name.as_str(),
                replaces,
                "",
                alert.title.as_str(),
                body_text(&alert.body).as_str(),
                // A click on the bubble is the "default" action; without it
                // the server reports none.
                vec!["default", ""],
                hints,
                -1i32,
            ),
        );
        let Ok(server) = reply.and_then(|r| r.body().deserialize::<u32>()) else {
            return;
        };

        let mut live = live.lock().unwrap();
        if replaces != 0 && replaces != server {
            live.page.remove(&replaces);
        }
        live.shown.insert(alert.id, (server, alert.extra));
        live.page.insert(server, alert.id);
    }

    /// The server's clicks and closes for our alerts, on a thread of its own.
    fn listen(app: &AppHandle, bus: &Connection, live: Arc<Mutex<Live>>) {
        let Ok(proxy) = Proxy::new(bus, DEST, PATH, DEST) else {
            return;
        };
        let Ok(signals) = proxy.receive_all_signals() else {
            return;
        };
        let app = app.clone();

        std::thread::spawn(move || {
            for signal in signals {
                let header = signal.header();
                let member = header.member().map(|m| m.as_str().to_owned());
                let body = signal.body();

                match member.as_deref() {
                    Some("ActionInvoked") => {
                        let Ok((server, action)) = body.deserialize::<(u32, String)>() else {
                            continue;
                        };
                        let gone = live.lock().unwrap().forget_server(server);
                        if let (true, Some((id, extra))) = (action == "default", gone) {
                            tapped(&app, id, extra);
                        }
                    }
                    Some("NotificationClosed") => {
                        if let Ok((server, _reason)) = body.deserialize::<(u32, u32)>() {
                            live.lock().unwrap().forget_server(server);
                        }
                    }
                    _ => {}
                }
            }
        });
    }

    pub fn show(app: &AppHandle, alert: Alert) {
        let _ = app
            .state::<Alerts>()
            .0
            .lock()
            .unwrap()
            .send(Job::Show(alert));
    }

    pub fn remove(app: &AppHandle, ids: Vec<i32>) {
        let _ = app
            .state::<Alerts>()
            .0
            .lock()
            .unwrap()
            .send(Job::Remove(ids));
    }
}

/// Windows: toasts through notify-rust. Each waits on a thread of its own
/// until it is clicked or dismissed (a toast leaves the screen after a few
/// seconds), and a toast cannot be taken back.
#[cfg(windows)]
mod imp {
    use super::{tapped, Alert, AppHandle, Manager, Value};
    use notify_rust::{Notification, NotificationResponse};
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// What each conversation's alerts are about: one entry per conversation
    /// that ever had one.
    #[derive(Default)]
    pub struct Shown(Mutex<HashMap<i32, Value>>);

    pub fn setup(app: &AppHandle) {
        app.manage(Shown::default());
    }

    pub fn show(app: &AppHandle, alert: Alert) {
        let mut toast = Notification::new();
        toast
            .appname(&app.package_info().name)
            .summary(&alert.title)
            .body(&alert.body);

        // The toast takes the app's name and icon from the Start menu entry
        // the installer made; a build run from target/ has none, and a toast
        // under an unknown id never shows, so it goes out under PowerShell's.
        let installed = tauri::utils::platform::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()))
            .is_some_and(|dir| !dir.ancestors().any(|d| d.ends_with("target")));

        if installed {
            toast.app_id(&app.config().identifier);
        }

        // The instant-message ping; without a sound a toast is silent.
        if alert.sound {
            toast.sound_name("IM");
        }

        let id = alert.id;
        app.state::<Shown>()
            .0
            .lock()
            .unwrap()
            .insert(id, alert.extra);
        let app = app.clone();

        std::thread::spawn(move || {
            let Ok(handle) = toast.show() else {
                return;
            };
            let _ = handle.wait_for_response(|response: &NotificationResponse| {
                if matches!(response, NotificationResponse::Default) {
                    // Any of a conversation's stacked toasts opens it.
                    let extra = app.state::<Shown>().0.lock().unwrap().get(&id).cloned();
                    if let Some(extra) = extra {
                        tapped(&app, id, extra);
                    }
                }
            });
        });
    }

    /// A shown toast cannot be taken back, and one still on screen opens its
    /// conversation, read or not.
    pub fn remove(_: &AppHandle, _: Vec<i32>) {}
}

#[cfg(test)]
mod tests {
    #[cfg(not(windows))]
    #[test]
    fn a_body_is_never_markup() {
        assert_eq!(
            super::imp::body_text(r#"<img src="https://x.test/a.png"> & <b>hi</b>"#),
            r#"&lt;img src="https://x.test/a.png"&gt; &amp; &lt;b&gt;hi&lt;/b&gt;"#
        );
    }
}
