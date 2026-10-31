// Light and dark themes in the web app's colours (DESIGN.md §7.8: web/styles/app/tokens.css), following the system.
// Dynamic colour is off: the app looks the same on every phone, and like the web app. Since the 2026-10-31 redesign: the
// dark grape surfaces, accent text on a violet fill (primaryContainer and [ChirkleColors.fill]), Inter.
package chirkle.android.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.material3.Typography
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** The tokens Material's scheme has no slot for. */
@Immutable
data class ChirkleColors(
    val muted: Color,
    /** Quieter than [muted]: times, a room's "#", section headings. */
    val dim: Color,
    val border: Color,
    val hover: Color,
    val highlight: Color,
    val tint: Color,
    val own: Color,
    /** The solid accent: unread badges, the send button, a picked tile (white on it). */
    val fill: Color,
    /** The NEW line above the first unread message. */
    val new: Color,
    val gradient: Brush,
)

val LocalChirkleColors = staticCompositionLocalOf {
    ChirkleColors(
        Color.Gray, Color.Gray, Color.LightGray, Color.LightGray, Color.Yellow, Color.Transparent, Color.LightGray, Color.Blue, Color.Magenta,
        Brush.linearGradient(listOf(Color.Gray, Color.Gray)),
    )
}

private val Accent = Color(0xFF5B3DF5)
private val Accent2 = Color(0xFFC42A7C)
/** The logo's grape-to-pink (web/styles/app/shell.css .brand::before). */
private val Gradient = Brush.linearGradient(listOf(Color(0xFF7A5AF8), Color(0xFFA43FD0), Color(0xFFD2389E)))

private val Light: ColorScheme = lightColorScheme(
    primary = Accent,
    onPrimary = Color.White,
    secondary = Accent2,
    onSecondary = Color.White,
    background = Color(0xFFFBFAFF),
    onBackground = Color(0xFF1D1530),
    surface = Color(0xFFFBFAFF),
    onSurface = Color(0xFF1D1530),
    surfaceVariant = Color(0xFFF1EEFC),
    onSurfaceVariant = Color(0xFF5E5874),
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Color(0xFFF6F4FE),
    surfaceContainer = Color(0xFFF1EEFC),
    surfaceContainerHigh = Color(0xFFECE8FB),
    surfaceContainerHighest = Color(0xFFE9E4FB),
    outline = Color(0xFFCFC7EE),
    outlineVariant = Color(0xFFE3DDF5),
    error = Color(0xFFC41D36),
    onError = Color.White,
    primaryContainer = Accent,
    onPrimaryContainer = Color.White,
    secondaryContainer = Color(0xFFE9E4FB),
    onSecondaryContainer = Color(0xFF1D1530),
)

private val DarkFill = Color(0xFF6D4AFF)

private val Dark: ColorScheme = darkColorScheme(
    primary = Color(0xFFB9A6FF),
    onPrimary = Color(0xFF1A1724),
    secondary = Color(0xFFF9A8D4),
    onSecondary = Color(0xFF1A1724),
    background = Color(0xFF1A1724),
    onBackground = Color(0xFFECEAF4),
    surface = Color(0xFF1A1724),
    onSurface = Color(0xFFECEAF4),
    surfaceVariant = Color(0xFF15121E),
    onSurfaceVariant = Color(0xFFA6A1B8),
    surfaceContainerLowest = Color(0xFF15121E),
    surfaceContainerLow = Color(0xFF1D1929),
    surfaceContainer = Color(0xFF221E2F),
    surfaceContainerHigh = Color(0xFF2A2540),
    surfaceContainerHighest = Color(0xFF2F2A45),
    outline = Color(0xFF3F3956),
    outlineVariant = Color(0xFF2A2638),
    error = Color(0xFFFCA5A5),
    onError = Color(0xFF1A1724),
    primaryContainer = DarkFill,
    onPrimaryContainer = Color.White,
    secondaryContainer = Color(0xFF2E2848),
    onSecondaryContainer = Color(0xFFECEAF4),
)

private val LightChirkle = ChirkleColors(
    muted = Color(0xFF5E5874),
    dim = Color(0xFF645E7C),
    border = Color(0xFFE3DDF5),
    hover = Color(0xFFE9E4FB),
    highlight = Color(0xFFFFF1B8),
    tint = Accent.copy(alpha = 0.12f),
    own = Color(0xFFEDE8FF),
    fill = Accent,
    new = Color(0xFFC0267A),
    gradient = Gradient,
)

private val DarkChirkle = ChirkleColors(
    muted = Color(0xFFA6A1B8),
    dim = Color(0xFF9C97B2),
    border = Color(0x14FFFFFF),
    hover = Color(0x0FFFFFFF),
    highlight = Color(0xFF3D3314),
    tint = Color(0xFF8B6CFF).copy(alpha = 0.16f),
    own = Color(0xFF8B6CFF).copy(alpha = 0.10f),
    fill = DarkFill,
    new = Color(0xFFF9A8D4),
    gradient = Gradient,
)

/** The avatar palette (§15.4): white text on each, at least 4.5:1, in both themes (web/styles/app/avatars.css). */
val AvatarPalette = listOf(
    Color(0xFFC4213B), Color(0xFFB04A00), Color(0xFF7A6000), Color(0xFF22803A),
    Color(0xFF00796B), Color(0xFF1D63D8), Color(0xFF7B3FE4), Color(0xFFC01A6E),
)

private val ChirkleShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(20.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

/** Inter (the web's font, DESIGN.md §7.7; SIL OFL, core/ui/OFL-Inter.txt), from one variable font: one instance per weight. */
@OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)
private fun inter(weight: Int) = Font(R.font.inter, FontWeight(weight), variationSettings = FontVariation.Settings(FontVariation.weight(weight)))

@OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)
val Inter = FontFamily(inter(400), inter(500), inter(600), inter(700))

/**
 * Inter throughout (Nunito until 2026-10-31). Headings bold, labels semibold, large text a little tighter, no extra spacing (as on the web).
 * Without Inter's contextual alternates, which draw people's text as something else ("32x1n" as "32×1n", "->" as an arrow; QA BUG-191).
 */
private val ChirkleTypography = Typography().run {
    fun TextStyle.i(w: FontWeight? = null) =
        copy(fontFamily = Inter, fontWeight = w ?: fontWeight, fontFeatureSettings = NO_CALT, letterSpacing = if (fontSize.value >= 18) (-0.01f * fontSize.value).sp else 0.sp)
    Typography(
        displayLarge = displayLarge.i(), displayMedium = displayMedium.i(), displaySmall = displaySmall.i(),
        headlineLarge = headlineLarge.i(FontWeight.Bold), headlineMedium = headlineMedium.i(FontWeight.Bold), headlineSmall = headlineSmall.i(FontWeight.Bold),
        titleLarge = titleLarge.i(FontWeight.Bold), titleMedium = titleMedium.i(FontWeight.SemiBold), titleSmall = titleSmall.i(FontWeight.SemiBold),
        bodyLarge = bodyLarge.i(), bodyMedium = bodyMedium.i(), bodySmall = bodySmall.i(),
        labelLarge = labelLarge.i(FontWeight.SemiBold), labelMedium = labelMedium.i(FontWeight.SemiBold), labelSmall = labelSmall.i(FontWeight.SemiBold),
    )
}

/** CSS font-feature-settings syntax, as TextStyle takes it. */
const val NO_CALT = "'calt' 0"

@Composable
fun ChirkleTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalChirkleColors provides if (dark) DarkChirkle else LightChirkle) {
        MaterialTheme(colorScheme = if (dark) Dark else Light, shapes = ChirkleShapes, typography = ChirkleTypography, content = content)
    }
}

object Chirkle {
    val colors: ChirkleColors
        @Composable get() = LocalChirkleColors.current
}
