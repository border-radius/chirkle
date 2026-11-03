// Swipes that move a whole screen (ANDROID.md §40, §44): the screen follows a finger dragged one way, and letting go
// far or fast enough acts (a room goes back, the room list opens your accounts); otherwise it springs back. Only drags
// that start sideways count, so lists still scroll, and a child that takes the drag first (a text field's selection)
// keeps it.
package chirkle.android.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.offset
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/** Past this share of the width, or this fast (dp a second) the swipe's way, letting go acts. */
private const val DISTANCE = 0.3f
private const val FLING = 800f

/** The screen follows a drag to the right ([toRight]) or to the left; far or fast enough, [onSwipe]. */
fun Modifier.swipeAway(enabled: Boolean, toRight: Boolean, onSwipe: () -> Unit): Modifier = composed {
    // How far the screen moved, the swipe's way (never the other).
    val dx = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    val act by rememberUpdatedState(onSwipe)
    val sign = if (toRight) 1f else -1f
    // A mode opened mid-drag (a long press selects) puts the screen back.
    LaunchedEffect(enabled) { if (!enabled) dx.snapTo(0f) }
    // The drag is read outside the offset, so the finger's positions don't move with the screen.
    this
        .then(
            if (!enabled) Modifier else Modifier.pointerInput(toRight) {
                val tracker = VelocityTracker()
                val fling = FLING.dp.toPx()
                detectHorizontalDragGestures(
                    onDragStart = { tracker.resetTracking() },
                    onDragEnd = {
                        val v = tracker.calculateVelocity().x * sign
                        if (dx.value > size.width * DISTANCE || (v > fling && dx.value > 0f)) act()
                        else scope.launch { dx.animateTo(0f, spring(dampingRatio = 0.8f)) }
                    },
                    onDragCancel = { scope.launch { dx.animateTo(0f) } },
                    onHorizontalDrag = { change, amount ->
                        tracker.addPosition(change.uptimeMillis, change.position)
                        val next = (dx.value + amount * sign).coerceAtLeast(0f)
                        if (next != dx.value) change.consume()
                        scope.launch { dx.snapTo(next) }
                    },
                )
            },
        )
        .offset { IntOffset((dx.value * sign).toInt(), 0) }
}
