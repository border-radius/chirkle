// One message (§7.6, §17, §19, §20, §28): author and time, the quote it replies to, text with links, attachments,
// link previews, reactions, and its menu.
import ChirkleCore
import SwiftUI

enum MessageAction {
    case reply, edit, delete, copy, retry, discard
    case react(String)
}

private let quickReactions = ["👍", "❤️", "😂", "🎉", "😮", "😢"]

struct MessageRow: View {
    @Environment(AppModel.self) private var model
    let message: Message
    let grouped: Bool
    let me: String
    let room: RoomModel
    let act: (MessageAction) -> Void

    private var mine: Bool { message.author == me }

    var body: some View {
        if message.isService {
            Text(message.text)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
        } else {
            HStack(alignment: .top, spacing: 10) {
                if grouped {
                    Color.clear.frame(width: 36, height: 1)
                } else if let u = message.authorUser {
                    AvatarView(user: u, size: 36)
                } else {
                    AvatarView(user: User(id: message.author, name: "?"), size: 36)
                }
                VStack(alignment: .leading, spacing: 4) {
                    if !grouped { header }
                    if message.deleted {
                        Text("Message deleted").italic().foregroundStyle(.secondary)
                    } else {
                        content
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal)
            .padding(.top, grouped ? 2 : 10)
            .contentShape(Rectangle())
            .opacity(message.status == .pending ? 0.6 : 1)
            .contextMenu { if !message.deleted && message.status == nil { menu } }
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(message.authorUser?.name ?? Strings.unknown).font(.subheadline.bold())
            if let d = pbDate(message.created) {
                Text(d, format: Date.FormatStyle(date: Calendar.current.isDateInToday(d) ? .omitted : .abbreviated, time: .shortened))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let f = message.forwardedFromUser, !message.forwardedFrom.isEmpty {
            Label("Forwarded from \(f.name)", systemImage: "arrowshape.turn.up.right")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        if let q = message.quoted {
            HStack(spacing: 6) {
                RoundedRectangle(cornerRadius: 1.5).fill(Color.accentColor).frame(width: 3)
                VStack(alignment: .leading, spacing: 1) {
                    Text(q.authorUser?.name ?? Strings.unknown).font(.caption.bold())
                    Text(q.deleted ? "Message deleted" : (q.text.isEmpty && !q.files.isEmpty ? "Attachment" : q.text))
                        .font(.caption)
                        .lineLimit(2)
                        .foregroundStyle(.secondary)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        }
        if !message.text.isEmpty {
            HStack(alignment: .lastTextBaseline, spacing: 4) {
                Text(attributed(message.text))
                    .textSelection(.enabled)
                if !message.editedAt.isEmpty {
                    Text("(edited)").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        attachments
        ForEach(message.previews, id: \.url) { p in
            if let url = URL(string: p.url) {
                Link(destination: url) {
                    Label(p.title.isEmpty ? p.url : p.title, systemImage: "link")
                        .font(.caption)
                        .lineLimit(1)
                }
            }
        }
        if !message.reactions.isEmpty {
            HStack(spacing: 4) {
                ForEach(message.reactions, id: \.emoji) { r in
                    let on = r.users.contains(me)
                    Button {
                        act(.react(r.emoji))
                    } label: {
                        Text("\(r.emoji) \(r.users.count)")
                            .font(.caption)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(Capsule().fill(on ? Color.accentColor.opacity(0.2) : Color(.secondarySystemBackground)))
                            .overlay(Capsule().stroke(on ? Color.accentColor : .clear))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        if message.status == .failed {
            HStack {
                Label("Not sent", systemImage: "exclamationmark.circle").foregroundStyle(.red)
                Button("Retry") { act(.retry) }
                Button("Delete", role: .destructive) { act(.discard) }
            }
            .font(.caption)
        }
    }

    @ViewBuilder
    private var attachments: some View {
        let media = message.files.filter(isImage)
        let other = message.files.filter { !isImage($0) }
        ForEach(media, id: \.self) { f in
            let dims = message.fileDims[f]
            let ratio = (dims?.count == 2 && dims![1] > 0) ? CGFloat(dims![0]) / CGFloat(dims![1]) : 4.0 / 3.0
            Link(destination: model.api!.fileURL(message, f)) {
                AsyncImage(url: model.api!.fileURL(message, f, thumb: isGif(f) ? nil : "480x0")) { img in
                    img.resizable().scaledToFill()
                } placeholder: {
                    Rectangle().fill(Color(.secondarySystemBackground))
                }
                .aspectRatio(ratio, contentMode: .fit)
                .frame(maxWidth: 260, maxHeight: 320)
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }
            .accessibilityLabel(message.attachmentName(f))
        }
        ForEach(other, id: \.self) { f in
            Link(destination: model.api!.fileURL(message, f)) {
                Label(message.attachmentName(f), systemImage: isVideo(f) ? "play.rectangle" : isAudio(f) ? "waveform" : "doc")
                    .font(.callout)
                    .padding(8)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color(.secondarySystemBackground)))
            }
        }
    }

    @ViewBuilder
    private var menu: some View {
        ControlGroup {
            ForEach(quickReactions.prefix(4), id: \.self) { e in
                Button(e) { act(.react(e)) }
            }
        }
        Button("Reply", systemImage: "arrowshape.turn.up.left") { act(.reply) }
        if !message.text.isEmpty {
            Button("Copy", systemImage: "doc.on.doc") { act(.copy) }
        }
        if mine {
            if !message.text.isEmpty {
                Button("Edit", systemImage: "pencil") { act(.edit) }
            }
            Button("Delete", systemImage: "trash", role: .destructive) { act(.delete) }
        }
    }

    /// The text with its links (only http and https, §7.6.3).
    private func attributed(_ text: String) -> AttributedString {
        var out = AttributedString()
        for part in linkify(text) {
            switch part {
            case let .plain(s):
                out += AttributedString(s)
            case let .link(s, href):
                var a = AttributedString(s)
                a.link = href
                out += a
            }
        }
        return out
    }
}
