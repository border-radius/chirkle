// The room list (§5, §16, §18): rooms, then direct messages, with unread badges; new room and new message.
import ChirkleCore
import SwiftUI

struct RoomsView: View {
    @Environment(AppModel.self) private var model
    @State private var path: [String] = []
    @State private var newRoom = false
    @State private var newRoomName = ""
    @State private var newDm = false

    var body: some View {
        NavigationStack(path: $path) {
            List {
                let me = model.user?.id
                let sorted = sortedRooms(model.rooms.filter { !$0.archived }, me: me)
                if !sorted.rooms.isEmpty {
                    Section("Rooms") {
                        ForEach(sorted.rooms) { row($0, me: me) }
                    }
                }
                if !sorted.dms.isEmpty {
                    Section("Direct messages") {
                        ForEach(sorted.dms) { row($0, me: me) }
                    }
                }
                let archived = model.rooms.filter(\.archived)
                if !archived.isEmpty {
                    Section("Archived") {
                        ForEach(archived) { row($0, me: me) }
                    }
                }
            }
            .overlay {
                if !model.loaded {
                    ProgressView()
                } else if model.rooms.isEmpty {
                    ContentUnavailableView(model.error ?? "No rooms yet", systemImage: "bubble.left.and.bubble.right")
                }
            }
            .refreshable { await model.reload() }
            .navigationTitle(model.site.title)
            .navigationDestination(for: String.self) { id in
                RoomView(roomId: id)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("New room", systemImage: "number") { newRoom = true }
                        Button("New message", systemImage: "square.and.pencil") { newDm = true }
                        Divider()
                        Text(model.user?.name ?? "")
                        Button("Log out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                            Task { await model.logOut() }
                        }
                    } label: {
                        Image(systemName: "square.and.pencil")
                    }
                }
            }
            .alert("New room", isPresented: $newRoom) {
                TextField("Name", text: $newRoomName)
                Button("Create") { createRoom() }
                Button("Cancel", role: .cancel) { newRoomName = "" }
            }
            .sheet(isPresented: $newDm) {
                NewMessageView { room in
                    model.upsert(room)
                    path.append(room.id)
                }
            }
        }
    }

    private func row(_ room: Room, me: String?) -> some View {
        NavigationLink(value: room.id) {
            HStack(spacing: 12) {
                if room.isDm, let other = room.otherMember(me) {
                    AvatarView(user: other, size: 32)
                } else {
                    Image(systemName: room.visibility == "private" ? "lock" : "number")
                        .frame(width: 32, height: 32)
                        .foregroundStyle(.secondary)
                }
                let count = model.unread[room.id] ?? 0
                Text(room.title(me).trimmingCharacters(in: CharacterSet(charactersIn: "#")))
                    .fontWeight(count > 0 ? .semibold : .regular)
                    .lineLimit(1)
                Spacer()
                if count > 0 {
                    Text(count > 99 ? "99+" : "\(count)")
                        .font(.caption.bold())
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Color.accentColor))
                        .foregroundStyle(.white)
                }
            }
        }
    }

    private func createRoom() {
        let name = newRoomName.trimmingCharacters(in: .whitespaces)
        newRoomName = ""
        guard !name.isEmpty, name.count <= Contract.Limits.roomName, let api = model.api else { return }
        Task {
            do {
                let room = try await api.createRoom(name: name)
                model.upsert(room)
                path.append(room.id)
            } catch let e as APIError {
                model.error = e.reason
            } catch {}
        }
    }
}

/// People search for a new direct message (§16).
struct NewMessageView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let opened: (Room) -> Void
    @State private var query = ""
    @State private var people: [User] = []
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                if let error { Text(error).foregroundStyle(.red) }
                ForEach(people) { u in
                    Button {
                        open(u)
                    } label: {
                        HStack {
                            AvatarView(user: u, size: 32)
                            Text(u.name)
                            if !u.handle.isEmpty { Text("@" + u.handle).foregroundStyle(.secondary) }
                        }
                    }
                    .disabled(u.noDms)
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Name")
            .task(id: query) {
                try? await Task.sleep(nanoseconds: 250_000_000)
                guard let api = model.api, !Task.isCancelled else { return }
                let q = query.trimmingCharacters(in: .whitespaces)
                people = q.isEmpty ? [] : ((try? await api.searchUsers(q)) ?? []).filter { $0.id != model.user?.id }
            }
            .navigationTitle("New message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }

    private func open(_ u: User) {
        Task {
            do {
                guard let api = model.api else { return }
                let room = try await api.openDm(u.id)
                dismiss()
                opened(room)
            } catch let e as APIError {
                error = e.reason
            } catch {}
        }
    }
}

struct AvatarView: View {
    @Environment(AppModel.self) private var model
    let user: User
    let size: CGFloat

    var body: some View {
        Group {
            if let url = model.api?.avatarURL(user, size: 100) {
                AsyncImage(url: url) { $0.resizable().scaledToFill() } placeholder: { initial }
            } else {
                initial
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
    }

    private var initial: some View {
        Circle()
            .fill(Color.accentColor.opacity(0.18))
            .overlay(Text(String(user.name.prefix(1)).uppercased()).font(.system(size: size * 0.45, weight: .semibold)).foregroundStyle(Color.accentColor))
    }
}
