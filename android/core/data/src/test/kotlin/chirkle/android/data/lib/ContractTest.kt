package chirkle.android.data.lib

import chirkle.android.data.api.ACTIVITY_FIELDS
import chirkle.android.data.api.ITEM_FIELDS
import chirkle.android.data.api.MSG_FIELDS
import chirkle.android.data.api.ROOM_FIELDS
import chirkle.android.data.api.ROW_FIELDS
import chirkle.android.data.api.USER_FIELDS
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// The app's copies of what clients and server share (shared/contract.json, docs/API.md); the web's and the hooks' are
// checked by tests/unit/contract.test.ts.
class ContractTest {
    private val contract = shared("contract.json")

    @Test fun `asks for the fields the contract lists`() {
        val f = contract.getValue("fields").jsonObject
        assertEquals(f.str("message"), MSG_FIELDS)
        assertEquals(f.str("room"), ROOM_FIELDS)
        assertEquals(f.str("user"), USER_FIELDS)
        assertEquals(f.str("roomRow"), ROW_FIELDS)
        assertEquals(f.str("collectionItem"), ITEM_FIELDS)
        assertEquals(f.str("activity"), ACTIVITY_FIELDS)
    }

    @Test fun `enforces the contract's limits`() {
        val l = contract.getValue("limits").jsonObject
        assertEquals(l.num("messageText"), Limits.MESSAGE_TEXT)
        assertEquals(l.num("userName"), Limits.USER_NAME)
        assertEquals(l.num("roomName"), Limits.ROOM_NAME)
        assertEquals(l.num("passwordMin"), Limits.PASSWORD_MIN)
        assertEquals(l.num("passwordMaxBytes"), Limits.PASSWORD_MAX_BYTES)
        assertEquals(l.num("avatarBytes").toLong(), Limits.AVATAR_BYTES)
        assertEquals(l.strings("avatarTypes").toSet(), Limits.AVATAR_TYPES)
        assertEquals(l.num("attachments"), Limits.ATTACHMENTS)
        assertEquals(l.num("attachmentBytes").toLong(), Limits.ATTACHMENT_BYTES)
        assertEquals(l.num("roomMembers"), Limits.ROOM_MEMBERS)
        assertEquals(l.num("maxSelected"), Limits.MAX_SELECTED)
    }

    @Test fun `shows the contract's files inline`() {
        val files = contract.getValue("files").jsonObject
        for (e in files.strings("image")) assertTrue(e, isImage("a.$e"))
        for (e in files.strings("video")) assertTrue(e, isVideo("a.$e"))
        for (e in files.strings("audio")) assertTrue(e, isAudio("a.$e"))
        for (e in listOf("pdf", "txt", "svg", "html")) assertFalse(e, isImage("a.$e") || isVideo("a.$e") || isAudio("a.$e"))
    }
}
