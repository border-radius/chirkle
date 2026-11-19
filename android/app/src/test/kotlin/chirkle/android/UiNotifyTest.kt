package chirkle.android

import android.app.NotificationManager
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.core.app.NotificationCompat
import androidx.test.core.app.ApplicationProvider
import chirkle.android.data.api.NewMessage
import chirkle.android.data.lib.newId
import chirkle.android.data.testing.TestServer.newUser
import chirkle.android.data.testing.TestServer.uniq
import chirkle.android.notify.CheckWorker
import chirkle.android.notify.Notifications
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

// Notifications from the background check (ANDROID.md §8): a DM and a reply to you notify, other messages don't, but
// those of a room chosen in its menu do (§24).
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class)
class UiNotifyTest {
    @get:Rule val compose = createComposeRule()
    private val ui = UiHarness(compose)

    @After fun tearDown() = ui.stop()

    @Test fun `a DM and a reply to you notify, in the background`() {
        val app = ApplicationProvider.getApplicationContext<android.app.Application>()
        shadowOf(app).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
        Notifications.createChannels(app)
        val alice = newUser("alice-${uniq()}")
        val bob = newUser()
        val room = runBlocking { alice.api.createRoom("r-${uniq()}") }
        val question = runBlocking { bob.api.send(NewMessage(newId(), room.id, "a question")) }
        val dm = runBlocking { alice.api.openDm(bob.user.id) }
        ui.signedIn(bob)
        val accounts = ui.accounts!!
        accounts.setVisible(false) // in the background: notifications are for then
        fun check() {
            var done: CheckWorker.Outcome? = null
            accounts.scope.launch { done = CheckWorker.checkAll(app, accounts) }
            compose.waitUntil(15_000) { ui.pump(); done != null }
            assertEquals(CheckWorker.Outcome.Done, done)
        }
        // The first check begins: what came before isn't news.
        check()
        val hi = runBlocking {
            alice.api.send(NewMessage(newId(), dm.id, "hi bob")).also {
                alice.api.send(NewMessage(newId(), room.id, "not for bob"))
                alice.api.send(NewMessage(newId(), room.id, "the answer", replyTo = question.id))
            }
        }
        Thread.sleep(1_100) // the check comes later than the message: it shows when the message was sent (QA BUG-154)
        check()
        val nm = app.getSystemService(NotificationManager::class.java)
        val shown = shadowOf(nm).allNotifications.associate { n ->
            n.channelId to NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n)!!.messages.map { it.text.toString() }
        }
        assertEquals(mapOf(Notifications.DMS to listOf("hi bob"), Notifications.ROOMS to listOf("the answer")), shown)
        val dmNote = shadowOf(nm).allNotifications.single { it.channelId == Notifications.DMS }
        assertEquals(chirkle.android.data.lib.parsePb(hi.created), NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(dmNote)!!.messages.single().timestamp)
        // A tap goes through the non-exported alias, the only way MainActivity opens a notification's room (ANDROID.md §79).
        val tap = shadowOf(dmNote.contentIntent).savedIntent
        assertEquals(Notifications.OPEN_ALIAS, tap.component?.className)
        assertEquals(chirkle.android.nav.Room(dm.id, hi.id), chirkle.android.nav.notificationRoute(tap.component?.className, tap.getStringExtra("room"), tap.getStringExtra("msg")))

        // Read on another device: the next check takes its notification away.
        runBlocking {
            val last = bob.api.page(chirkle.android.data.lib.Pages.latest(dm.id), 1).single()
            bob.api.markRead(dm.id, last.created)
        }
        check()
        assertEquals(listOf(Notifications.ROOMS), shadowOf(nm).allNotifications.map { it.channelId })
    }

    @Test fun `Notify of every message, from the room's menu, notifies its plain messages (§24)`() {
        val app = ApplicationProvider.getApplicationContext<android.app.Application>()
        shadowOf(app).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
        Notifications.createChannels(app)
        val alice = newUser("alice-${uniq()}")
        val bob = newUser()
        val room = runBlocking { alice.api.createRoom("every-${uniq()}") }
        val services = ui.signedIn(bob)
        val accounts = ui.accounts!!
        fun check() {
            var done: CheckWorker.Outcome? = null
            accounts.scope.launch { done = CheckWorker.checkAll(app, accounts) }
            compose.waitUntil(15_000) { ui.pump(); done != null }
            assertEquals(CheckWorker.Outcome.Done, done)
        }
        ui.showRoom(room.name)
        // Its click action, not a tap: scrolled to the bottom edge, the row can be under the New button.
        compose.onNodeWithText(room.name).performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick)
        ui.waitFor("Beginning of #${room.name}")
        compose.onNodeWithContentDescription("Room actions").performClick()
        compose.onNodeWithText("Notify of every message").performClick()
        compose.waitUntil(5_000) { ui.pump(); room.id in services.notifyRooms.set.value }
        compose.onNodeWithContentDescription("Room actions").performClick()
        ui.waitFor("Stop notifying of every message")
        ui.accounts!!.setVisible(false) // away: the room open here isn't "on screen"
        check()
        runBlocking { alice.api.send(NewMessage(newId(), room.id, "for everyone")) }
        Thread.sleep(1_100)
        check()
        val nm = app.getSystemService(NotificationManager::class.java)
        val n = shadowOf(nm).allNotifications.single()
        assertEquals(Notifications.ROOM_ALL, n.channelId)
        assertEquals(listOf("for everyone"), NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n)!!.messages.map { it.text.toString() })
    }
}
