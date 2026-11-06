// The site's mark: its logo when it has one (§24), else the app's own, as on the web and the launcher icon: a round
// speech bubble with a soft tail at its bottom left, in the violet-to-pink gradient (res/drawable/brand_mark.xml).
package chirkle.android.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage

@Composable
fun BrandMark(logo: String, size: Dp = 32.dp, modifier: Modifier = Modifier) {
    if (logo.isNotEmpty()) {
        AsyncImage(logo, contentDescription = null, modifier = modifier.size(size).clip(RoundedCornerShape(size * 0.28f)))
        return
    }
    Image(painterResource(R.drawable.brand_mark), contentDescription = null, modifier = modifier.size(size))
}
