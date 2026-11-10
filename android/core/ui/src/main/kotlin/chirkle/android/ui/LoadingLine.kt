package chirkle.android.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

/** How long a fetch takes before the line shows: a quick one shows nothing (the web's LOADBAR_MS). */
const val LOADING_LINE_MS = 400L

/**
 * A thin moving line over the room list or a room while it is being fetched (ANDROID.md §58, DESIGN.md §7.9): only once
 * [busy] has lasted [LOADING_LINE_MS], gone as soon as it ends. Takes no room: lay it over the top of what it is about.
 */
@Composable
fun LoadingLine(busy: Boolean, modifier: Modifier = Modifier) {
    var shown by remember { mutableStateOf(false) }
    LaunchedEffect(busy) {
        if (busy) delay(LOADING_LINE_MS)
        shown = busy
    }
    if (shown) {
        LinearProgressIndicator(
            modifier = modifier.fillMaxWidth().height(2.dp).clearAndSetSemantics { testTag = "loading-line" },
            color = MaterialTheme.colorScheme.primary,
            trackColor = Color.Transparent,
            gapSize = 0.dp,
        )
    }
}
