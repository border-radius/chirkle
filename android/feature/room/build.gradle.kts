plugins {
    id("chirkle.android.feature")
}

android {
    namespace = "chirkle.android.feature.room"
}

dependencies {
    // Videos compressed before they are sent (VideoPrep.kt).
    implementation(libs.media3.transformer)
    implementation(libs.media3.effect)
}
