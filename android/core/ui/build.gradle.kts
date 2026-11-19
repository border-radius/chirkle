plugins {
    id("chirkle.android.library")
    id("chirkle.android.compose")
}

android {
    namespace = "chirkle.android.ui"
}

dependencies {
    implementation(project(":core:data"))
    api(libs.coil.compose)
    implementation(libs.coil.okhttp)
    implementation(libs.coil.gif)
    implementation(libs.browser)
    implementation(libs.emoji2)
    implementation(libs.exifinterface)
}
