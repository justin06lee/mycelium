import Testing
@testable import Notes

@Test func blank() {
    #expect(!NoteRow(note: Note.samples[0]).isBlank)
}
