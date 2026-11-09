// Records as the app sees them (DESIGN.md §5, §6), decoded from PocketBase's JSON. The same shapes as web/src/lib/types.ts.
package chirkle.android.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class User(
    val id: String,
    val name: String = "",
    /** Avatar filename (§15); "" when the user has none. */
    val avatar: String = "",
    /** Doesn't take direct messages (§16.7), e.g. a Telegram bridge's stand-in. */
    @SerialName("no_dms") val noDms: Boolean = false,
    /** Someone on a linked instance (§33.4): its host, e.g. "b.example". "" for this server's own people. */
    val instance: String = "",
    /** You are a moderator (DESIGN.md §36): only said of the signed-in user. */
    val moderator: Boolean = false,
    /** What "@handle" names (DESIGN.md §41), without the "@"; "" where the server doesn't say. */
    val handle: String = "",
)

/**
 * Who else holds a shared room (§33.10): [home], on a copy of another instance's room (its host); [with], the other
 * instances that have it; [down], its home can't be reached right now. Empty for a room that isn't shared.
 */
@Serializable
data class Shared(val home: String = "", val with: List<String> = emptyList(), val down: Boolean = false)

/** Who can see a room (§23.1). */
@Serializable
enum class Visibility {
    @SerialName("private") Private,
    @SerialName("public") Public,
    @SerialName("open") Open,
}

/** Who can post in a room (§23.6). */
@Serializable
enum class Posting {
    @SerialName("everyone") Everyone,
    @SerialName("selected") Selected,
}

@Serializable
data class Room(
    val id: String,
    /** "" for a DM: its title is the other member's name. */
    val name: String = "",
    val archived: Boolean = false,
    @SerialName("created_by") val createdBy: String = "",
    /** "dm" for a direct message; anything else is a room (§16.1). */
    val kind: String = "",
    /** Absent = public (§23.1). */
    val visibility: Visibility? = null,
    /** A DM's two members, or a private room's (§23.2); empty otherwise. */
    val members: List<String> = emptyList(),
    /** Absent = everyone (§23.6). */
    val posting: Posting? = null,
    val writers: List<String> = emptyList(),
    /** DMs: when the latest message was sent ("" before the first). */
    @SerialName("last_message_at") val lastMessageAt: String = "",
    val created: String = "",
    /** Shared with other instances (§33). */
    val shared: Shared? = null,
    val expand: RoomExpand? = null,
) {
    val isDm: Boolean get() = kind == "dm"
}

@Serializable
data class RoomExpand(val members: List<User> = emptyList(), val writers: List<User> = emptyList())

/** One emoji on a message and who reacted with it (§20.1), in the order they reacted. */
@Serializable
data class Reaction(val emoji: String, val users: List<String>)

/** A link's line under a message (§28): its page title and favicon (a data: URL, "" without one). */
@Serializable
data class LinkPreview(val url: String, val title: String = "", val icon: String = "")

/** What a reply shows of the message it answers (§19). */
@Serializable
data class Quoted(
    val id: String,
    val author: String = "",
    val text: String = "",
    val deleted: Boolean = false,
    val files: List<String> = emptyList(),
    val expand: QuotedExpand? = null,
)

@Serializable
data class QuotedExpand(val author: User? = null)

@Serializable
data class MessageExpand(
    val author: User? = null,
    @SerialName("reply_to") val replyTo: Quoted? = null,
    @SerialName("forwarded_from") val forwardedFrom: User? = null,
)

@Serializable
data class Message(
    val id: String,
    val room: String,
    /** "" for a service message (§5.3). */
    val author: String = "",
    val text: String = "",
    /** PocketBase datetime, e.g. "2026-10-10 12:34:56.789Z": fixed width, so string order is time order. */
    val created: String = "",
    val updated: String = "",
    /** "" when never edited. */
    @SerialName("edited_at") val editedAt: String = "",
    val deleted: Boolean = false,
    /** Stored attachment names (§17.1). */
    val files: List<String> = emptyList(),
    /** Original upload names by stored name (QA BUG-28). */
    @SerialName("file_names") val fileNames: Map<String, String> = emptyMap(),
    /** The message this one replies to (§19); "" when it isn't a reply. */
    @SerialName("reply_to") val replyTo: String = "",
    val reactions: List<Reaction> = emptyList(),
    /** Who first wrote it, when it was forwarded (§21.3). */
    @SerialName("forwarded_from") val forwardedFrom: String = "",
    /** The message a forward shows (§21.3); its files are that message's. */
    @SerialName("forward_of") val forwardOf: String = "",
    val previews: List<LinkPreview> = emptyList(),
    /** Who its "@handle"s name (DESIGN.md §41): user ids, set by the server. */
    val mentions: List<String> = emptyList(),
    /** Stored name → the collection the file was attached from (§31); a forward's are its original's. */
    @SerialName("file_sources") val fileSources: Map<String, String> = emptyMap(),
    /** Stored image or video name → [width, height] as shown (§17.5), set by the server; absent until it knows. */
    @SerialName("file_dims") val fileDims: Map<String, List<Int>> = emptyMap(),
    val expand: MessageExpand? = null,
    /** Client only: not on the server yet (§7.5). Never sent, never decoded. */
    @kotlinx.serialization.Transient val status: SendStatus? = null,
    /** Client only: attachments of a message not on the server yet, as content URIs (§17.4). */
    @kotlinx.serialization.Transient val localFiles: List<LocalFile> = emptyList(),
    /** Client only: collection items a message not on the server yet attaches (§31), after its files. */
    @kotlinx.serialization.Transient val localItems: List<CollectionItem> = emptyList(),
) {
    val isService: Boolean get() = author.isEmpty()
}

enum class SendStatus { Pending, Failed }

/** An attachment picked on the device: a content URI, its name, type and size. */
@Serializable
data class LocalFile(val uri: String, val name: String, val type: String, val size: Long)

/** The site's branding and signup policy (§24), and the oldest app it still serves (ANDROID.md §12.4). */
@Serializable
data class Site(
    val title: String = "Chirkle",
    /** URL of the logo, "" without one. */
    val logo: String = "",
    val inviteOnly: Boolean = false,
    val minAndroidVersion: Int = 0,
) {
    companion object {
        val DEFAULT = Site()
    }
}

/** A position in a room's history, ordered by (created, id) (§6). */
@Serializable
data class Cursor(val created: String, val id: String)

/** Unread messages per room id, as of `at` (server time, §18.2), and the recent messages they account for. */
@Serializable
data class UnreadCounts(
    val at: String = "",
    val rooms: Map<String, Int> = emptyMap(),
    val ids: List<String> = emptyList(),
    /** Inbox rows not seen yet (at most 100), and each room's unread mentions and replies (DESIGN.md §41); none from older servers. */
    val inbox: Int = 0,
    val mentions: Map<String, Int> = emptyMap(),
)

/** A row of the "Mentions & replies" inbox (DESIGN.md §41, GET /api/chat/inbox). */
@Serializable
data class InboxItem(
    val id: String,
    /** Where the next page starts (`before`). */
    val cursor: String = "",
    /** "mention", "reply" or "reaction". */
    val kind: String = "",
    /** A reaction's emoji, "" otherwise. */
    val emoji: String = "",
    val created: String = "",
    val room: String = "",
    /** The mention, the reply, or your message reacted to. */
    val message: InboxMessage = InboxMessage(""),
    /** A reply's: your message it answers. */
    val quote: InboxMessage? = null,
    /** Who did it; in an anonymous room (§35), the room for a mention or reply. */
    val actor: User = User(""),
)

/** A message as an inbox row shows it: its text cut short, how many files it has. */
@Serializable
data class InboxMessage(val id: String, val text: String = "", val files: Int = 0, val created: String = "")

/** A row of the inbox added ("create") or taken away ("delete"), told live on chat/inbox (DESIGN.md §41). */
data class InboxEvent(val action: String, val id: String, val room: String)

@Serializable
data class InboxPage(val items: List<InboxItem> = emptyList(), val more: Boolean = false, @SerialName("seen_at") val seenAt: String = "")

/** Someone the composer offers as "@" is typed (GET /api/chat/mentionable). */
@Serializable
data class Mentionable(val id: String, val name: String = "", val handle: String = "", val avatar: String = "", val instance: String = "")

/** A room_reads row: how far you have read a room. */
@Serializable
data class ReadPosition(val room: String = "", @SerialName("last_read_at") val lastReadAt: String = "")

/** A hidden_rooms or room_reads row: which room it is about. */
@Serializable
data class RoomRow(val id: String, val room: String = "")

/** One image or video of a room's media grid (DESIGN.md §30.1). [source]: the message whose file it is (a forward's original). */
@Serializable
data class MediaItem(
    val message: String,
    val source: String = "",
    val file: String,
    val pos: Int = 0,
    /** The file's original name ("" for old messages). */
    val name: String = "",
    val video: Boolean = false,
    val poster: Boolean = false,
    val sent: String = "",
    val author: MediaAuthor? = null,
)

@Serializable
data class MediaAuthor(val id: String, val name: String = "")

@Serializable
data class MediaPage(val items: List<MediaItem> = emptyList(), val more: Boolean = false)

/** A media collection (DESIGN.md §31): yours, or someone else's public one that you follow. */
@Serializable
data class MediaCollection(
    val id: String,
    val name: String = "",
    val public: Boolean = false,
    val items: Int = 0,
    @SerialName("last_added") val lastAdded: String = "",
    /** Someone else's that you follow: whose it is, up to when you've seen it, and how many items are new (at most 100). */
    val owner: CollectionOwner? = null,
    @SerialName("seen_at") val seenAt: String = "",
    val new: Int = 0,
    /** Its newest items (four at most), for its tile in the room list; none from servers before 2026-11-03. */
    val preview: List<CollectionItem> = emptyList(),
)

@Serializable
data class CollectionOwner(val id: String, val name: String = "")

/** What GET /api/chat/collections answers: yours and those you follow, by name. */
@Serializable
data class Collections(val mine: List<MediaCollection> = emptyList(), val subs: List<MediaCollection> = emptyList()) {
    fun find(id: String): MediaCollection? = mine.firstOrNull { it.id == id } ?: subs.firstOrNull { it.id == id }
}

/** One image or video of a collection (§31). */
@Serializable
data class CollectionItem(
    val id: String,
    val collection: String = "",
    val file: String = "",
    /** The original file name. */
    val name: String = "",
    val video: Boolean = false,
    /** A video's poster frame is ready (GET /api/chat/posters/items/{id}/{file}). */
    val poster: Boolean = false,
    val created: String = "",
)

/** A collection as its page shows it: with its owner's name (guests can't look users up). */
@Serializable
data class CollectionMeta(
    val id: String,
    val name: String = "",
    val public: Boolean = false,
    val owner: String = "",
    val items: Int = 0,
    val expand: CollectionMetaExpand? = null,
)

@Serializable
data class CollectionMetaExpand(val owner: User? = null)

/**
 * What a "from collection" badge may say (§31): a public one's (or your own) [name], or [private] for someone else's
 * private one. A collection that is gone has none (null).
 */
@Serializable
data class Badge(val name: String = "", val public: Boolean = false, val mine: Boolean = false, val private: Boolean = false)

/** What to save to a collection: a message's file (a forward's original's, §21.3), or another collection's item. */
sealed interface SaveFrom {
    data class File(val message: String, val file: String) : SaveFrom
    data class Item(val item: String) : SaveFrom
}
