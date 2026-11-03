// swift-tools-version:5.9
// The shell's Swift on Apple systems. SeanceNotifications is the page's
// message alerts on iOS and macOS alike; SeanceTauri puts them behind the
// macOS shell's two C entry points (src/apple.rs), built and linked by
// build.rs through swift-rs. The iOS shell's plugin (../ios) depends on
// SeanceNotifications by path.
import PackageDescription

let package = Package(
    name: "SeanceTauri",
    platforms: [.macOS("26.0"), .iOS("26.0")],
    products: [
        .library(name: "SeanceTauri", type: .static, targets: ["SeanceTauri"]),
        .library(name: "SeanceNotifications", targets: ["SeanceNotifications"]),
    ],
    targets: [
        .target(name: "SeanceNotifications"),
        .target(name: "SeanceTauri", dependencies: ["SeanceNotifications"]),
    ],
    swiftLanguageVersions: [.v5]
)
