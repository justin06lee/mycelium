import Foundation

struct Note: Identifiable {
    let id = UUID()
    var title: String
    var date: Date

    static let samples = [
        Note(title: "Groceries", date: .now),
        Note(title: "Call Sam", date: .now.addingTimeInterval(-3600)),
    ]
}
