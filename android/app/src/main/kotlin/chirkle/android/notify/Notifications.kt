// Notifications (ANDROID.md §8.3): DMs, replies to you and the messages of rooms chosen (§24), found by CheckWorker.
// MessagingStyle, one channel per kind (Direct messages, Mentions and replies, Room messages), one notification per account and room (§17.4) with Reply and Mark as read. A room's
// notification goes once it is read: opened here, or read elsewhere (its count drops to 0, seen live or by the next
// check). The launcher badge is the unread count.
package chirkle.android.notify

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import chirkle.android.MainActivity
import chirkle.android.R
import chirkle.android.data.lib.parsePb
import chirkle.android.data.lib.quoteText
import chirkle.android.data.lib.title
import chirkle.android.data.model.Message
import chirkle.android.data.model.Room
import chirkle.android.data.repo.ChirkleServices
import kotlinx.coroutines.flow.collect

object Notifications {
    const val DMS = "dms"
    const val ROOMS = "rooms"
    /** Every message of a room chosen in its menu (§24). */
    const val ROOM_ALL = "room_all"
    const val SENDING = "sending"
    const val KEY_REPLY = "reply"
    private const val EXTRA_ROOM = "chirkle.room"
    const val OPEN = "chirkle.android.OPEN"
    /** The accent (tokens.css): the small icon and actions are tinted with it. */
    private const val ACCENT = 0xFF5B3DF5.toInt()
    /** What is shown: "account/room" keys. */
    private val shown = mutableSetOf<String>()

    fun createChannels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannels(
            listOf(
                NotificationChannel(DMS, "Direct messages", NotificationManager.IMPORTANCE_HIGH).apply { setShowBadge(true) },
                NotificationChannel(ROOMS, "Mentions and replies", NotificationManager.IMPORTANCE_DEFAULT).apply { setShowBadge(true) },
                NotificationChannel(ROOM_ALL, "Room messages", NotificationManager.IMPORTANCE_DEFAULT).apply { setShowBadge(true) },
                NotificationChannel(SENDING, "Sending", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) },
            ),
        )
    }

    private fun key(account: String, room: String) = "$account/$room"

    private fun id(account: String, room: String) = key(account, room).hashCode()

    private fun allowed(context: Context) =
        android.os.Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** Opening a notification opens its room in its account, at the message (MainActivity.take). */
    private fun open(context: Context, account: String, room: String, msg: String?): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setAction(OPEN)
            .setData(Uri.parse("chirkle-notification://$account/$room"))
            .putExtra("account", account).putExtra("room", room).putExtra("msg", msg)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(context, id(account, room), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun action(context: Context, action: String, account: String, room: String, msg: Message, mutable: Boolean): PendingIntent {
        val intent = Intent(context, ActionReceiver::class.java).setAction(action)
            .putExtra("account", account).putExtra("room", room).putExtra("message", msg.id).putExtra("created", msg.created)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or if (mutable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getBroadcast(context, (action + key(account, room)).hashCode(), intent, flags)
    }

    private fun bodyOf(m: Message): String =
        if (m.files.isNotEmpty() && m.text.isBlank()) quoteText("", false, m.files.size) else m.text.replace(Regex("\\s+"), " ").trim()

    /**
     * Show (or add to) the notification of [room] for [m]. [unread]: the room's count, for the badge. [account]: which
     * account it is, when there is more than one (§17.4). [alert]: sound and vibrate (once per room and check).
     */
    fun show(context: Context, services: ChirkleServices, room: Room, m: Message, unread: Int, account: String? = null, alert: Boolean = true) {
        val acct = services.accountId
        if (!allowed(context)) return
        val me = services.store.get().user ?: services.api.currentUser() ?: return
        val nm = NotificationManagerCompat.from(context)
        val self = Person.Builder().setName("You").setKey(me.id).build()
        val existing = nm.activeNotifications.firstOrNull { it.id == id(acct, room.id) }?.notification
        val style = existing?.let { NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(it) } ?: NotificationCompat.MessagingStyle(self)
        if (!room.isDm) style.setConversationTitle(room.title(me.id)).setGroupConversation(true)
        val author = m.expand?.author
        // When it was sent: a check finds it up to 15 minutes later (QA BUG-154).
        val sent = parsePb(m.created).takeIf { it != Long.MIN_VALUE } ?: System.currentTimeMillis()
        style.addMessage(bodyOf(m), sent, Person.Builder().setName(author?.name ?: "Unknown").setKey(m.author).build())
        val reply = NotificationCompat.Action.Builder(0, "Reply", action(context, ActionReceiver.REPLY, acct, room.id, m, mutable = true))
            .addRemoteInput(RemoteInput.Builder(KEY_REPLY).setLabel("Reply").build())
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
            .setShowsUserInterface(false)
            .build()
        val read = NotificationCompat.Action.Builder(0, "Mark as read", action(context, ActionReceiver.READ, acct, room.id, m, mutable = false))
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
            .setShowsUserInterface(false)
            .build()
        val channel = when {
            room.isDm -> DMS
            m.expand?.replyTo?.author == me.id || me.id in m.mentions -> ROOMS
            else -> ROOM_ALL
        }
        val n = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(ACCENT)
            .setStyle(style)
            .setContentIntent(open(context, acct, room.id, m.id))
            .setSubText(account)
            .setAutoCancel(true)
            .setNumber(unread)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setGroup(acct)
            .setOnlyAlertOnce(!alert)
            .addExtras(android.os.Bundle().apply { putString(EXTRA_ROOM, room.id) })
            .addAction(reply)
            .addAction(read)
            .build()
        synchronized(shown) { shown += key(acct, room.id) }
        try {
            nm.notify(id(acct, room.id), n)
        } catch (e: SecurityException) {
            // the permission was taken back meanwhile
        }
    }

    /** After a reply from the notification: it shows as yours, which also ends the reply's spinner. */
    fun addOwnReply(context: Context, account: String, room: String, text: String) {
        if (!allowed(context)) return
        val nm = NotificationManagerCompat.from(context)
        val existing = nm.activeNotifications.firstOrNull { it.id == id(account, room) }?.notification ?: return
        val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(existing) ?: return
        style.addMessage(text, System.currentTimeMillis(), null as Person?)
        val n = NotificationCompat.Builder(context, existing)
            .setStyle(style)
            .setOnlyAlertOnce(true)
            .build()
        try {
            nm.notify(id(account, room), n)
        } catch (e: SecurityException) {
        }
    }

    fun cancel(context: Context, account: String, room: String) {
        synchronized(shown) { shown -= key(account, room) }
        NotificationManagerCompat.from(context).cancel(id(account, room))
    }

    /** Every notification of [account] (logged out, or removed): the others' stay. */
    fun cancelAccount(context: Context, account: String) {
        val nm = NotificationManagerCompat.from(context)
        val keys = synchronized(shown) { shown.filter { it.startsWith("$account/") }.also { shown.removeAll(it.toSet()) } }
        for (k in keys) nm.cancel(k.hashCode())
        // Shown by an earlier process: found by their group.
        runCatching { for (n in nm.activeNotifications) if (n.notification.group == account) nm.cancel(n.id) }
    }

    /** A check found [account]'s other rooms read (on any device): their notifications go. */
    fun clearRead(context: Context, account: String, unreadRooms: Set<String>) {
        val nm = NotificationManagerCompat.from(context)
        runCatching {
            for (n in nm.activeNotifications) {
                val room = n.notification.extras.getString(EXTRA_ROOM) ?: continue
                if (n.notification.group == account && room !in unreadRooms) cancel(context, account, room)
            }
        }
    }

    /** While the app runs: a room opened, or read elsewhere (its count gone), loses its notification. */
    suspend fun follow(context: Context, services: ChirkleServices) {
        val acct = services.accountId
        services.store.flow.collect { s ->
            val rooms = synchronized(shown) { shown.filter { it.startsWith("$acct/") }.map { it.substringAfter('/') } }
            for (r in rooms) if (r == s.activeRoomId && !s.away || (s.counted && (s.unread[r] ?: 0) == 0)) cancel(context, acct, r)
        }
    }

    /** What expedited work shows before Android 12, when it runs as a foreground service. */
    fun sending(context: Context, title: String = "Sending messages…") = NotificationCompat.Builder(context, SENDING)
        .setSmallIcon(R.drawable.ic_notification)
        .setContentTitle(title)
        .setProgress(0, 0, true)
        .setOngoing(true)
        .build()
}
