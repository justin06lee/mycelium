import SwiftUI

extension View {
    func freshness() -> some View {
        modifier(Freshness())
    }
}

struct Freshness: ViewModifier {
    func body(content: Content) -> some View {
        content.opacity(0.95)
    }
}
