// The site's mark: its logo when it has one (§24), else the app's own, as on the web and the launcher icon: a speech
// bubble, round but for its tighter bottom-left corner, in the accent gradient.
package chirkle.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage

private val BubbleShape = RoundedCornerShape(topStartPercent = 50, topEndPercent = 50, bottomEndPercent = 50, bottomStartPercent = 28)

@Composable
fun BrandMark(logo: String, size: Dp = 32.dp, modifier: Modifier = Modifier) {
    if (logo.isNotEmpty()) {
        AsyncImage(logo, contentDescription = null, modifier = modifier.size(size).clip(RoundedCornerShape(size * 0.28f)))
        return
    }
    Box(modifier.size(size).clip(BubbleShape).background(Chirkle.colors.gradient))
}
