package chirkle.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import chirkle.android.data.lib.avatarColor
import chirkle.android.data.lib.initials
import chirkle.android.data.model.User
import coil3.compose.AsyncImage

/**
 * A user's picture (§15): their avatar's thumbnail (48 or 96 px, whichever covers [size] on this screen), or their
 * initials on a colour picked from their id. [url]: the picture's address, for a user of another account (§17). A
 * picture that fails to load (gone from the server, the server out of reach) shows the initials, as on the web (QA BUG-302).
 */
@Composable
fun Avatar(user: User, size: Dp = 36.dp, modifier: Modifier = Modifier, url: String? = null) {
    val services = LocalServices.current
    val px = if (size.value * androidx.compose.ui.platform.LocalDensity.current.density > 48) 96 else 48
    val url = url ?: remember(user.id, user.avatar, px) { services.api.avatarUrl(user, px) }
    Box(modifier.size(size).clip(CircleShape).background(AvatarPalette[avatarColor(user.id)]), contentAlignment = Alignment.Center) {
        var failed by remember(url) { mutableStateOf(false) }
        if (url.isEmpty() || failed) {
            Text(initials(user.name), color = Color.White, fontWeight = FontWeight.Bold, fontSize = (size.value * 0.4f).sp, maxLines = 1)
        } else {
            AsyncImage(
                model = url,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.size(size),
                onError = { failed = true },
            )
        }
    }
}
