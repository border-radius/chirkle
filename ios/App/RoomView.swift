// A room or DM (§6, §7, §19, §20): its messages from the newest, older ones on scrolling up, live; the composer with
// replies and edits; a message's menu.
import ChirkleCore
import SwiftUI
import UIKit

struct RoomView: View {
    @Environment(AppModel.self) private var model
    let roomId: String
    @State private var room: RoomModel?

    var body: some View {
        Group {
            if let room {
                RoomContent(room: room)
            } else {
                ProgressView()
            }
        }
        .navigationTitle(model.room(roomId)?.title(model.user?.id) ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard room == nil, let api = model.api, let me = model.user?.id else { return }
            let r = RoomModel(api: api, roomId: roomId, me: me) { id in model.markedRead(id) }
            room = r
            model.openRoom = roomId
            await r.open()
        }
        .onDisappear {
            if model.openRoom == roomId { model.openRoom = nil }
            if let room { Task { await room.close() } }
        }
    }
}

private struct RoomContent: View {
    @Environment(AppModel.self) private var model
    @Bindable var room: RoomModel
    @State private var top: String?
    @FocusState private var focused: Bool

    private var info: Room? { model.room(room.roomId) }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if !room.reachedStart && !room.messages.isEmpty {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .padding()
                            .onAppear { loadOlder() }
                    }
                    ForEach(Array(room.messages.enumerated()), id: \.element.id) { i, m in
                        MessageRow(
                            message: m,
                            grouped: i > 0 && grouped(room.messages[i - 1], m),
                            me: room.me,
                            room: room
                        ) { action in
                            handle(action, m)
                        }
                        .id(m.id)
                    }
                }
                .scrollTargetLayout()
                .padding(.vertical, 8)
            }
            .defaultScrollAnchor(.bottom)
            .scrollPosition(id: $top, anchor: .top)
            .scrollDismissesKeyboard(.interactively)
            .overlay {
                if room.loading {
                    ProgressView()
                } else if room.messages.isEmpty {
                    ContentUnavailableView(room.error ?? "No messages yet", systemImage: "bubble.left")
                }
            }
            composer
        }
        .alert("Couldn't do that", isPresented: Binding(get: { room.error != nil && !room.messages.isEmpty }, set: { if !$0 { room.error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(room.error ?? "")
        }
    }

    /// Older messages, keeping the one at the top where it was.
    private func loadOlder() {
        let keep = room.messages.first?.id
        Task {
            await room.loadOlder()
            if let keep { top = keep }
        }
    }

    /// Under the one before it without a header: the same author within five minutes.
    private func grouped(_ a: Message, _ b: Message) -> Bool {
        guard a.author == b.author, !a.isService, !b.isService, let da = pbDate(a.created), let db = pbDate(b.created) else { return false }
        return db.timeIntervalSince(da) < 300
    }

    private func handle(_ action: MessageAction, _ m: Message) {
        switch action {
        case .reply:
            room.editing = nil
            room.replyTo = m
            focused = true
        case .edit:
            room.startEdit(m)
            focused = true
        case .delete:
            Task { await room.delete(m) }
        case let .react(emoji):
            Task { await room.toggle(emoji, on: m) }
        case .retry:
            Task { await room.retry(m) }
        case .discard:
            room.discard(m)
        case .copy:
            UIPasteboard.general.string = m.text
        }
    }

    @ViewBuilder
    private var composer: some View {
        let me = model.user
        if let info, !info.dmClosed(me).isEmpty {
            notice(info.dmClosed(me))
        } else if let info, info.archived {
            notice("This room is archived.")
        } else if let info, !info.canPost(me?.id) {
            notice("Only some people can post here.")
        } else {
            VStack(spacing: 0) {
                Divider()
                if let r = room.replyTo ?? room.editing {
                    HStack {
                        Image(systemName: room.editing != nil ? "pencil" : "arrowshape.turn.up.left")
                            .foregroundStyle(Color.accentColor)
                        VStack(alignment: .leading) {
                            Text(room.editing != nil ? "Editing" : "Replying to \(r.authorUser?.name ?? Strings.unknown)")
                                .font(.caption.bold())
                            Text(r.text).font(.caption).lineLimit(1).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button {
                            room.cancelCompose()
                        } label: {
                            Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                        }
                        .accessibilityLabel("Cancel")
                    }
                    .padding(.horizontal)
                    .padding(.top, 8)
                }
                HStack(alignment: .bottom, spacing: 8) {
                    TextField("Message", text: $room.draft, axis: .vertical)
                        .lineLimit(1 ... 6)
                        .focused($focused)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(RoundedRectangle(cornerRadius: 18).fill(Color(.secondarySystemBackground)))
                        .onChange(of: room.draft) { room.saveDraft() }
                    Button {
                        Task { await room.submit() }
                    } label: {
                        Image(systemName: room.editing != nil ? "checkmark.circle.fill" : "arrow.up.circle.fill")
                            .font(.system(size: 32))
                    }
                    .disabled(!room.canSend)
                    .accessibilityLabel(room.editing != nil ? "Save" : "Send")
                }
                .padding(.horizontal)
                .padding(.vertical, 8)
                if room.draft.count > Contract.Limits.messageText - 100 {
                    Text("\(room.draft.count) / \(Contract.Limits.messageText)")
                        .font(.caption2)
                        .foregroundStyle(room.draft.count > Contract.Limits.messageText ? .red : .secondary)
                        .padding(.bottom, 4)
                }
            }
            .background(.bar)
        }
    }

    private func notice(_ text: String) -> some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .padding()
            .background(.bar)
    }
}
