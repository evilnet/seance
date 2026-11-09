// swift-tools-version:5.9
// The iOS shell's own Swift (src/mobile.rs): one Tauri plugin, `Seance`, that
// answers the page's plugins, with the message alerts the macOS shell has too
// and its AppleTranslate engine (../swift, SeanceNotifications and
// SeanceTranslate). build.rs copies Tauri's Swift API into
// .tauri/ and links this package.
import PackageDescription

let package = Package(
    name: "SeanceIOS",
    platforms: [.iOS("26.0"), .macOS("26.0")],
    products: [
        .library(name: "SeanceIOS", type: .static, targets: ["SeanceIOS"]),
    ],
    dependencies: [
        .package(name: "Tauri", path: ".tauri/tauri-api"),
        .package(name: "SeanceTauri", path: "../swift"),
    ],
    targets: [
        .target(
            name: "SeanceIOS",
            dependencies: [
                .byName(name: "Tauri"),
                .product(name: "SeanceNotifications", package: "SeanceTauri"),
                .product(name: "SeanceTranslate", package: "SeanceTauri"),
            ],
            path: "Sources"
        ),
    ],
    swiftLanguageVersions: [.v5]
)
