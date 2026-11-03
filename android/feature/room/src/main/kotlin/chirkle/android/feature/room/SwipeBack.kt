// Swipe back (ANDROID.md §40): the room follows a finger dragged to the right, and letting go far or fast enough goes
// back to the rooms; otherwise it springs back (chirkle.android.ui.swipeAway).
package chirkle.android.feature.room

import androidx.compose.ui.Modifier
import chirkle.android.ui.swipeAway

fun Modifier.swipeBack(enabled: Boolean, onBack: () -> Unit): Modifier = swipeAway(enabled, toRight = true, onSwipe = onBack)
