fn main() {
    // macOS: the message alerts (src/apple.rs), a Swift package linked in.
    // The target's OS, not the build machine's: a check for Windows run on a
    // Mac links no Swift.
    #[cfg(target_os = "macos")]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        swift_rs::SwiftLinker::new("10.15")
            .with_package("SeanceTauri", "swift/")
            .link();
        println!("cargo:rerun-if-changed=swift/");
        // The Swift runtime is the system's (macOS 12+ keeps it there).
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }

    tauri_build::build()
}
