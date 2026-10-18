// swift-tools-version: 6.2
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v26)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.0"),
        .package(name: "CapacitorApp", path: "../../../../../../../shells/capacitor/node_modules/@capacitor/app"),
        .package(name: "CapacitorHaptics", path: "../../../../../../../shells/capacitor/node_modules/@capacitor/haptics"),
        .package(name: "CapacitorKeyboard", path: "../../../../../../../shells/capacitor/node_modules/@capacitor/keyboard"),
        .package(name: "CapacitorSplashScreen", path: "../../../../../../../shells/capacitor/node_modules/@capacitor/splash-screen"),
        .package(name: "CapacitorStatusBar", path: "../../../../../../../shells/capacitor/node_modules/@capacitor/status-bar"),
        .package(name: "CapawesomeCapacitorBadge", path: "../../../../../../../shells/capacitor/node_modules/@capawesome/capacitor-badge")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapacitorApp", package: "CapacitorApp"),
                .product(name: "CapacitorHaptics", package: "CapacitorHaptics"),
                .product(name: "CapacitorKeyboard", package: "CapacitorKeyboard"),
                .product(name: "CapacitorSplashScreen", package: "CapacitorSplashScreen"),
                .product(name: "CapacitorStatusBar", package: "CapacitorStatusBar"),
                .product(name: "CapawesomeCapacitorBadge", package: "CapawesomeCapacitorBadge")
            ]
        )
    ]
)
