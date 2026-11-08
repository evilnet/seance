fn main() {
    // macOS: the message alerts (src/apple.rs), a Swift package linked in.
    // The target's OS, not the build machine's: a check for Windows run on a
    // Mac links no Swift.
    #[cfg(target_os = "macos")]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        swift_rs::SwiftLinker::new("26.0")
            .with_package("SeanceTauri", "swift/")
            .link();
        println!("cargo:rerun-if-changed=swift/");
        // The Swift runtime is the system's.
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }

    // iOS: the shell's Swift plugin (src/mobile.rs, ios/), as a Tauri plugin
    // crate links its own: Tauri's Swift API copied in beside the package,
    // which depends on it by path, then the package linked.
    #[cfg(target_os = "macos")]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        let api = std::env::var("DEP_TAURI_IOS_LIBRARY_PATH")
            .expect("tauri sets DEP_TAURI_IOS_LIBRARY_PATH for an iOS build");
        let copy = std::path::Path::new("ios/.tauri/tauri-api");
        let _ = std::fs::remove_dir_all(copy);
        copy_dir(std::path::Path::new(&api), copy).expect("copy Tauri's Swift API");

        // Xcode's SDKROOT is the phone's, and the package manifest is
        // compiled for the Mac: unset while linking, as Tauri's own linker
        // (tauri_utils::build) does. A build script runs single-threaded.
        let sdk_root = std::env::var_os("SDKROOT");
        unsafe { std::env::remove_var("SDKROOT") };
        swift_rs::SwiftLinker::new("26.0")
            .with_ios(&std::env::var("IPHONEOS_DEPLOYMENT_TARGET").unwrap_or_else(|_| "26.0".into()))
            .with_package("SeanceIOS", "ios/")
            .link();
        if let Some(root) = sdk_root {
            unsafe { std::env::set_var("SDKROOT", root) };
        }
        println!("cargo:rerun-if-changed=ios/Sources");
        println!("cargo:rerun-if-changed=swift/");
    }

    // The page may call `seance_call` alone, and only from the windows
    // capabilities/default.json names: without a list, Tauri lets every
    // window call every registered command.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["seance_call"])),
    )
    .expect("tauri build")
}

/// Tauri's Swift API without its build products and tests.
#[cfg(target_os = "macos")]
fn copy_dir(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;

    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();

        if matches!(name.to_str(), Some(".build" | "Package.resolved" | "Tests")) {
            continue;
        }

        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &to.join(&name))?;
        } else {
            std::fs::copy(entry.path(), to.join(&name))?;
        }
    }

    Ok(())
}
