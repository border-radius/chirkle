// Swipe back (ANDROID.md §40): the room follows a finger dragged to the right, and letting go far or fast enough goes
// back to the rooms; otherwise it springs back. Only drags that start sideways count, so the message list still
// scrolls, and a child that takes the drag first (a text field's selection) keeps it.
package chirkle.android.feature.room

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

/** Past this share of the width, or this fast (dp a second) to the right, letting go goes back. */
private const val DISTANCE = 0.3f
private const val FLING = 800f

fun Modifier.swipeBack(enabled: Boolean, onBack: () -> Unit): Modifier = composed {
    val dx = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    val back by rememberUpdatedState(onBack)
    // A mode opened mid-drag (a long press selects) puts the room back.
    LaunchedEffect(enabled) { if (!enabled) dx.snapTo(0f) }
    // The drag is read outside the offset, so the finger's positions don't move with the room.
    this
        .then(
            if (!enabled) Modifier else Modifier.pointerInput(Unit) {
                val tracker = VelocityTracker()
                val fling = FLING.dp.toPx()
                detectHorizontalDragGestures(
                    onDragStart = { tracker.resetTracking() },
                    onDragEnd = {
                        val v = tracker.calculateVelocity().x
                        if (dx.value > size.width * DISTANCE || (v > fling && dx.value > 0f)) back()
                        else scope.launch { dx.animateTo(0f, spring(dampingRatio = 0.8f)) }
                    },
                    onDragCancel = { scope.launch { dx.animateTo(0f) } },
                    onHorizontalDrag = { change, amount ->
                        tracker.addPosition(change.uptimeMillis, change.position)
                        val next = (dx.value + amount).coerceAtLeast(0f)
                        if (next != dx.value) change.consume()
                        scope.launch { dx.snapTo(next) }
                    },
                )
            },
        )
        .offset { IntOffset(dx.value.toInt(), 0) }
}
