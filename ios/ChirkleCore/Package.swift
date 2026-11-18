// swift-tools-version:5.10
// ChirkleCore: the iPhone app's data layer (docs/IOS.md §4), a port of android/core/data's API half. No UI, no
// iOS-only API, so `swift test` runs it on macOS against a real server (§7). The app target (../App/, ../project.yml) uses it.
import PackageDescription

let package = Package(
    name: "ChirkleCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "ChirkleCore", targets: ["ChirkleCore"])],
    targets: [
        .target(name: "ChirkleCore"),
        .testTarget(name: "ChirkleCoreTests", dependencies: ["ChirkleCore"]),
    ]
)
