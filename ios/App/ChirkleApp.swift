// The iPhone app (docs/IOS.md): a native SwiftUI client of a Chirkle server, on ChirkleCore.
import ChirkleCore
import SwiftUI

@main
struct ChirkleApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(Color.accentColor)
        }
        .onChange(of: phase) { _, now in
            switch now {
            case .background: model.background()
            case .active: model.foreground()
            default: break
            }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.server == nil {
            ServerView()
        } else if !model.signedIn {
            LoginView()
        } else {
            RoomsView()
        }
    }
}
