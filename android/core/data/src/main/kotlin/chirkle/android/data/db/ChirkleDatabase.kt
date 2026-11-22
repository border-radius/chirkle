// The local database (ANDROID.md §6.2): what the app shows before the network answers, and what must survive the
// process: the room list, each room's latest page (the web's room cache, §7.5), the outbox, drafts and a few values.
// Records are kept as the JSON the server sent: the app decodes them into the same models either way.
package chirkle.android.data.db

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Transaction
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

/** A room the user can see, and their hidden_rooms row for it ("" when it isn't hidden). */
@Entity(tableName = "rooms")
data class RoomEntity(@PrimaryKey val id: String, val json: String, val hiddenRow: String = "")

/** A room's latest messages as [user] last saw them (`Kept` in web/src/cache.ts). */
@Entity(tableName = "kept", indices = [Index("keptAt")])
data class KeptEntity(@PrimaryKey val room: String, val user: String, val json: String, val keptAt: Long)

/** A message on its way to the server (§9.2): its client id, as it will be called there. */
@Entity(tableName = "outbox", indices = [Index("room")])
data class OutboxEntity(
    @PrimaryKey val id: String,
    val room: String,
    val user: String,
    /** The optimistic message, as shown: text, reply, local files. */
    val json: String,
    /** 0 pending, 1 failed (Retry). */
    val state: Int = 0,
    val createdAt: Long,
)

/** Unsent composer text, per user and room (§22.3), with the message it replies to. */
@Entity(tableName = "drafts", primaryKeys = ["user", "room"])
data class DraftEntity(val user: String, val room: String, val text: String, val replyTo: String = "")

/** Small values: the site record, the unread counts, the notification check, recent emoji. */
@Entity(tableName = "kv")
data class KvEntity(@PrimaryKey val key: String, val value: String)

@Dao
interface RoomsDao {
    @Query("SELECT * FROM rooms")
    suspend fun all(): List<RoomEntity>

    @Transaction
    suspend fun replace(rows: List<RoomEntity>) {
        clear()
        upsert(rows)
    }

    @Upsert
    suspend fun upsert(rows: List<RoomEntity>)

    @Query("DELETE FROM rooms")
    suspend fun clear()
}

@Dao
interface KeptDao {
    @Query("SELECT * FROM kept WHERE room = :room")
    suspend fun get(room: String): KeptEntity?

    @Upsert
    suspend fun put(row: KeptEntity)

    /** Keep the [max] rooms opened most recently. */
    @Query("DELETE FROM kept WHERE room NOT IN (SELECT room FROM kept ORDER BY keptAt DESC LIMIT :max)")
    suspend fun trim(max: Int)

    @Query("DELETE FROM kept")
    suspend fun clear()
}

@Dao
interface OutboxDao {
    @Query("SELECT * FROM outbox ORDER BY createdAt, id")
    fun observe(): Flow<List<OutboxEntity>>

    @Query("SELECT * FROM outbox WHERE state = 0 ORDER BY createdAt, id LIMIT 1")
    suspend fun next(): OutboxEntity?

    @Query("SELECT * FROM outbox WHERE id = :id")
    suspend fun get(id: String): OutboxEntity?

    @Upsert
    suspend fun put(row: OutboxEntity)

    @Query("UPDATE outbox SET state = :state WHERE id = :id")
    suspend fun setState(id: String, state: Int)

    @Query("DELETE FROM outbox WHERE id = :id")
    suspend fun delete(id: String)

    @Query("DELETE FROM outbox")
    suspend fun clear()
}

@Dao
interface DraftsDao {
    @Query("SELECT * FROM drafts WHERE user = :user AND room = :room")
    suspend fun get(user: String, room: String): DraftEntity?

    @Upsert
    suspend fun put(row: DraftEntity)

    @Query("DELETE FROM drafts WHERE user = :user AND room = :room")
    suspend fun delete(user: String, room: String)

    @Query("DELETE FROM drafts")
    suspend fun clear()
}

@Dao
interface KvDao {
    @Query("SELECT value FROM kv WHERE `key` = :key")
    suspend fun get(key: String): String?

    @Upsert
    suspend fun put(row: KvEntity)

    @Query("DELETE FROM kv WHERE `key` = :key")
    suspend fun delete(key: String)
}

@Database(entities = [RoomEntity::class, KeptEntity::class, OutboxEntity::class, DraftEntity::class, KvEntity::class], version = 1)
abstract class ChirkleDatabase : RoomDatabase() {
    abstract fun rooms(): RoomsDao
    abstract fun kept(): KeptDao
    abstract fun outbox(): OutboxDao
    abstract fun drafts(): DraftsDao
    abstract fun kv(): KvDao

    /** Everything that belongs to the session: on log out nothing of it may stay (ANDROID.md §10). */
    suspend fun clearSession() {
        rooms().clear()
        kept().clear()
        outbox().clear()
        drafts().clear()
        for (k in SESSION_KEYS) kv().delete(k)
    }

    companion object {
        /** Kv entries that belong to the session; the site record stays (it isn't anyone's). */
        val SESSION_KEYS = listOf(Keys.UNREAD, Keys.NOTIFY_CHECK, Keys.NOTIFY_ROOMS, Keys.RECENT_EMOJI)

        fun open(context: Context, name: String = "chirkle.db"): ChirkleDatabase =
            Room.databaseBuilder(context, ChirkleDatabase::class.java, name)
                // A cache: a schema it can't migrate is rebuilt from the server (the outbox and drafts with it).
                .fallbackToDestructiveMigration(dropAllTables = true)
                .build()
    }
}

object Keys {
    const val SITE = "site"
    const val UNREAD = "unread"
    const val NOTIFY_CHECK = "notify_check"
    /** Rooms whose every message notifies (ANDROID.md §24), space-separated. */
    const val NOTIFY_ROOMS = "notify_rooms"
    const val RECENT_EMOJI = "recent_emoji"
    const val SECURE_SCREENS = "secure_screens"
    const val THEME = "theme"
    const val FOLDED = "folded"
    const val TEXT_SIZE = "text_size"
}
