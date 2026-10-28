// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Notes",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "Notes"),
        .testTarget(name: "NotesTests", dependencies: ["Notes"]),
    ]
)
