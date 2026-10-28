import SwiftUI

struct NoteList: View {
    @State private var notes = Note.samples

    var body: some View {
        if notes.isEmpty {
            EmptyState()
        } else {
            List(notes) { note in
                NoteRow(note: note)
            }
            .freshness()
        }
    }
}

private struct EmptyState: View {
    var body: some View {
        Text("No notes yet").foregroundStyle(.secondary)
    }
}
