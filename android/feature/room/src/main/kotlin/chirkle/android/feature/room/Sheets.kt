// What opens over the room: a message's actions (with quick reactions, §20.2), the emoji picker (§20.4: exactly the
// emoji the server accepts as reactions) and the forward target picker (§21.3).
package chirkle.android.feature.room

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.runtime.getValue
import kotlinx.coroutines.launch
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import chirkle.android.data.lib.EMOJI_CATEGORIES
import chirkle.android.data.lib.QUICK_REACTIONS
import chirkle.android.data.lib.canPost
import chirkle.android.data.lib.dmClosed
import chirkle.android.data.lib.line
import chirkle.android.data.lib.quote
import chirkle.android.data.lib.roomSections
import chirkle.android.data.lib.title
import chirkle.android.data.model.Message
import chirkle.android.data.model.Room
import chirkle.android.data.repo.AppState
import chirkle.android.ui.Chirkle
import chirkle.android.ui.ChirkleIcons

class MenuItem(val label: String, val icon: ImageVector, val danger: Boolean = false, val run: () -> Unit)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MessageSheet(
    m: Message,
    reactable: Boolean,
    recent: List<String>,
    items: List<MenuItem>,
    onReact: (String) -> Unit,
    onMoreEmoji: () -> Unit,
    onDismiss: () -> Unit,
) {
    chirkle.android.ui.ChirkleSheet(onDismiss) {
        // Which message this is about: its author and first line.
        Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                buildString {
                    m.expand?.author?.let { a ->
                        append(a.name)
                        // Someone on a linked instance says which (§33.4).
                        if (a.instance.isNotEmpty()) append(" (on ").append(a.instance).append(")")
                        append(": ")
                    }
                    append(m.quote().line())
                },
                style = MaterialTheme.typography.bodyMedium,
                color = Chirkle.colors.muted,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (reactable) {
            androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                // As many quick ones as fit next to "+" (six on most phones): seven 48dp buttons need 368dp, and on a
                // narrower screen the last, "+", was squeezed to nothing.
                val fit = (maxWidth / 48.dp).toInt() - 1
                val quick = (recent + QUICK_REACTIONS).distinct().take(fit.coerceIn(0, 6))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    for (e in quick) {
                        Box(
                            Modifier.size(48.dp).clip(CircleShape).clickable { onReact(e) }.semantics { contentDescription = "React with $e" },
                            contentAlignment = Alignment.Center,
                        ) { Text(e, fontSize = 26.sp) }
                    }
                    Box(Modifier.size(48.dp).clip(CircleShape).clickable(onClick = onMoreEmoji), contentAlignment = Alignment.Center) {
                        Icon(ChirkleIcons.Add, contentDescription = "Add reaction")
                    }
                }
            }
        }
        for (item in items) {
            ListItem(
                colors = androidx.compose.material3.ListItemDefaults.colors(
                    containerColor = androidx.compose.ui.graphics.Color.Transparent,
                    headlineColor = if (item.danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                    leadingIconColor = if (item.danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                ),
                headlineContent = { Text(item.label) },
                leadingContent = { Icon(item.icon, contentDescription = null) },
                modifier = Modifier.clickable { item.run() },
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EmojiSheet(title: String, recent: List<String>, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    chirkle.android.ui.ChirkleSheet(onDismiss) {
        Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 16.dp).semantics { heading() })
        val grid = androidx.compose.foundation.lazy.grid.rememberLazyGridState()
        val scope = androidx.compose.runtime.rememberCoroutineScope()
        // Where each category's title is in the grid, for the tabs.
        val categories = androidx.compose.runtime.remember { EMOJI_CATEGORIES.map { c -> c to c.emoji.filter(chirkle.android.ui.Glyphs::canDraw) } }
        val starts = androidx.compose.runtime.remember(recent) {
            var i = if (recent.isNotEmpty()) 1 + recent.size else 0
            categories.map { (_, list) -> i.also { i += 1 + list.size } }
        }
        val current by androidx.compose.runtime.remember { androidx.compose.runtime.derivedStateOf { starts.indexOfLast { it <= grid.firstVisibleItemIndex }.coerceAtLeast(0) } }
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            EMOJI_CATEGORIES.forEachIndexed { i, c ->
                Box(
                    Modifier
                        .size(40.dp)
                        .clip(CircleShape)
                        .background(if (i == current) Chirkle.colors.tint else androidx.compose.ui.graphics.Color.Transparent)
                        .clickable { scope.launch { grid.scrollToItem(starts[i]) } }
                        .semantics { contentDescription = c.name },
                    contentAlignment = Alignment.Center,
                ) { Text(c.icon, fontSize = 20.sp) }
            }
        }
        LazyVerticalGrid(GridCells.Adaptive(48.dp), Modifier.fillMaxWidth().height(360.dp).padding(horizontal = 8.dp), state = grid) {
            if (recent.isNotEmpty()) {
                item(span = { GridItemSpan(maxLineSpan) }) { CategoryTitle("Recent") }
                items(recent, key = { "r$it" }) { e -> EmojiCell(e, onPick) }
            }
            for ((c, list) in categories) {
                item(span = { GridItemSpan(maxLineSpan) }, key = "c-${c.name}") { CategoryTitle(c.name) }
                items(list, key = { "${c.name}$it" }) { e -> EmojiCell(e, onPick) }
            }
        }
    }
}

@Composable
private fun CategoryTitle(name: String) {
    Text(name, style = MaterialTheme.typography.labelLarge, color = Chirkle.colors.muted, modifier = Modifier.padding(start = 8.dp, top = 12.dp, bottom = 4.dp).semantics { heading() })
}

@Composable
private fun EmojiCell(e: String, onPick: (String) -> Unit) {
    Box(Modifier.size(48.dp).clip(CircleShape).clickable { onPick(e) }, contentAlignment = Alignment.Center) { Text(e, fontSize = 26.sp) }
}

/** Where messages can be forwarded: the rooms and DMs I may post in (§21.3). */
fun forwardTargets(s: AppState): List<Room> {
    val me = s.user?.id
    val sections = roomSections(s.rooms.values, s.hidden.keys, me, s.activeRoomId)
    // Not into a DM that takes no messages (§16.7).
    return (sections.dms + sections.rooms + sections.hidden).filter { !it.archived && it.canPost(me) && it.dmClosed(s.user).isEmpty() }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ForwardSheet(count: Int, rooms: List<Room>, me: String?, onPick: (Room) -> Unit, onDismiss: () -> Unit) {
    chirkle.android.ui.ChirkleSheet(onDismiss) {
        Text(if (count == 1) "Forward message" else "Forward $count messages", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 16.dp).semantics { heading() })
        Text("Forward to", color = Chirkle.colors.muted, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 420.dp)) {
            items(rooms, key = { it.id }) { r ->
                ListItem(
                    colors = androidx.compose.material3.ListItemDefaults.colors(containerColor = androidx.compose.ui.graphics.Color.Transparent),
                    headlineContent = { Text(r.title(me), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    leadingContent = { chirkle.android.ui.RoomPicture(r, me) },
                    modifier = Modifier.clickable { onPick(r) },
                )
            }
        }
    }
}
