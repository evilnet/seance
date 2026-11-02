// swift-tools-version:5.9
// The macOS shell's Swift: the system's notifications behind two C entry
// points (src/apple.rs), built and linked by build.rs through swift-rs.
import PackageDescription

let package = Package(
    name: "SeanceTauri",
    platforms: [.macOS(.v10_15)],
    products: [
        .library(name: "SeanceTauri", type: .static, targets: ["SeanceTauri"]),
    ],
    targets: [
        .target(name: "SeanceTauri"),
    ],
    swiftLanguageVersions: [.v5]
)
