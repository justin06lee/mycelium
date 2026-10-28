import SwiftUI

/// One note in the list: its title and how long ago it was written.
struct NoteRow: View {
    let note: Note

    var body: some View {
        HStack {
            Text(note.title).font(.headline)
            Spacer()
            Text(relative(note.date)).foregroundStyle(.secondary)
        }
    }
}

extension NoteRow {
    var isBlank: Bool { note.title.isEmpty }
}

private func relative(_ date: Date) -> String {
    date.formatted(.relative(presentation: .named))
}
