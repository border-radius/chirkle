// A room's mark (DESIGN.md §23): # for a public room, a lock for a private one, a globe for an Open Air one, quiet on a
// raised rounded tile (the 2026-10-31 redesign). The room list's tile says who can see the room as the web's sidebar
// does (2026-11-22): "#" for private, people for public, a globe for Open Air ([listIcon]).
package chirkle.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import chirkle.android.data.lib.otherMember
import chirkle.android.data.lib.visibilityOrDefault
import chirkle.android.data.model.Room
import chirkle.android.data.model.Visibility

fun Visibility.icon(): ImageVector = when (this) {
    Visibility.Private -> ChirkleIcons.Lock
    Visibility.Open -> ChirkleIcons.Globe
    Visibility.Public -> ChirkleIcons.Tag
}

/** The room list's mark (the web's `visibilityLead`): "#" is the private room's. */
fun Visibility.listIcon(): ImageVector = when (this) {
    Visibility.Private -> ChirkleIcons.Tag
    Visibility.Open -> ChirkleIcons.Globe
    Visibility.Public -> ChirkleIcons.People
}

@Composable
fun RoomIcon(visibility: Visibility, size: Dp = 40.dp, modifier: Modifier = Modifier, icon: ImageVector = visibility.icon()) {
    Box(
        modifier.size(size).background(MaterialTheme.colorScheme.surfaceContainer, RoundedCornerShape(size * 0.3f)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = Chirkle.colors.dim, modifier = Modifier.size(size * 0.45f))
    }
}

/** A room's picture in a list: the other person's avatar for a DM, the room's mark otherwise. */
@Composable
fun RoomPicture(room: Room, me: String?, size: Dp = 40.dp) {
    val other = if (room.isDm) room.otherMember(me) else null
    if (other != null) Avatar(other, size) else RoomIcon(room.visibilityOrDefault, size)
}
