plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

/** The server a debug build talks to: the dev server as the emulator reaches it (ANDROID.md §12.2). */
val devServer = providers.gradleProperty("chirkle.devServer").orElse("http://10.0.2.2:8090")
/**
 * The release build's default server (ANDROID.md §17.2): offered at first launch, and the App Links host (§17.3).
 * Unset, the app asks for a server and claims no host's links.
 */
val server = providers.gradleProperty("chirkle.server").orElse("")

/**
 * Release signing (ANDROID.md §28.2): a keystore for builds published by us (GitHub Releases, IzzyOnDroid), with
 * `chirkle.keystorePassword`, `chirkle.keyAlias` and `chirkle.keyPassword` (the store's password when unset); these
 * can come from the environment as `ORG_GRADLE_PROJECT_chirkle.…`. `chirkle.unsigned=true` builds an unsigned APK,
 * as F-Droid's recipe does.
 */
val releaseKeystore = providers.gradleProperty("chirkle.keystore")
val unsigned = providers.gradleProperty("chirkle.unsigned").map { it.toBoolean() }.getOrElse(false)

/** The host whose /r/ links open in the app; a reserved name (RFC 2606) when there is no default server. */
fun appLinksHost(url: String) = url.substringAfter("://").substringBefore('/').substringBefore(':').ifEmpty { "app-links.invalid" }

android {
    namespace = "chirkle.android"
    compileSdk = 37

    defaultConfig {
        applicationId = providers.gradleProperty("chirkle.appId").getOrElse("com.chirkle.android")
        minSdk = 26
        targetSdk = 36
        versionCode = 9
        versionName = "0.3.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (releaseKeystore.isPresent) {
            create("release") {
                storeFile = file(releaseKeystore.get())
                storePassword = providers.gradleProperty("chirkle.keystorePassword").get()
                keyAlias = providers.gradleProperty("chirkle.keyAlias").get()
                keyPassword = providers.gradleProperty("chirkle.keyPassword").orElse(storePassword!!).get()
            }
        }
    }

    buildTypes {
        debug {
            buildConfigField("String", "SERVER", "\"${devServer.get()}\"")
            manifestPlaceholders["appLinksHost"] = appLinksHost(devServer.get())
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            buildConfigField("String", "SERVER", "\"${server.get()}\"")
            manifestPlaceholders["appLinksHost"] = appLinksHost(server.get())
            // The release key when one is given (§28.2); unsigned for F-Droid, which signs it itself; else the debug
            // key, so a local build installs.
            signingConfig = when {
                releaseKeystore.isPresent -> signingConfigs.getByName("release")
                unsigned -> null
                else -> signingConfigs.getByName("debug")
            }
        }
        // The release build as :baselineprofile measures it (ANDROID.md §33): minified but not obfuscated (the profile
        // must name the real classes), not debuggable, profileable from the shell, signed with the debug key, and
        // talking to the dev server over http (src/benchmark).
        create("benchmark") {
            initWith(getByName("release"))
            proguardFile("benchmark-rules.pro")
            matchingFallbacks += "release"
            signingConfig = signingConfigs.getByName("debug")
            buildConfigField("String", "SERVER", "\"${devServer.get()}\"")
            manifestPlaceholders["appLinksHost"] = appLinksHost(devServer.get())
        }
    }

    // AGP's encrypted list of dependencies in the APK signing block: only Google Play can read it, and F-Droid
    // rejects APKs that carry it (§28.1).
    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "DebugProbesKt.bin", "/META-INF/*.version", "kotlin/**", "**/*.kotlin_builtins")
    }

    testOptions.unitTests.isIncludeAndroidResources = true
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(project(":core:data"))
    implementation(project(":core:ui"))
    implementation(project(":feature:auth"))
    implementation(project(":feature:rooms"))
    implementation(project(":feature:room"))
    implementation(project(":feature:profile"))
    implementation(project(":feature:viewer"))

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.process)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.viewmodel.navigation3)
    implementation(libs.navigation3.runtime)
    implementation(libs.navigation3.ui)
    implementation(libs.core.ktx)
    implementation(libs.work.runtime)
    implementation(libs.coil.compose)
    implementation(libs.profileinstaller)

    testImplementation(project(":core:testing"))
    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.exifinterface)
    testImplementation(libs.androidx.test.core)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test)
    debugImplementation(libs.compose.ui.test.manifest)
}

tasks.withType<Test>().configureEach {
    maxHeapSize = "1g"
    // The UI tests start PocketBase from the repository's bin/ (ANDROID.md §13).
    systemProperty("chirkle.repoRoot", rootProject.projectDir.parentFile.absolutePath)
    testLogging { events("failed"); exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}

/**
 * The download size budget (ANDROID.md §11): the universal release APK, an upper bound for every ABI's download, must
 * stay under 6 MB. CI runs it.
 */
val checkApkSize by tasks.registering {
    description = "Builds the release APK and fails when it is over the 6 MB download budget."
    dependsOn("assembleRelease")
    val apks = layout.buildDirectory.dir("outputs/apk/release")
    inputs.dir(apks)
    doLast {
        val budget = 6L * 1024 * 1024
        val files = apks.get().asFile.listFiles { f -> f.extension == "apk" }.orEmpty()
        check(files.isNotEmpty()) { "No release APK: run assembleRelease first" }
        for (f in files) {
            val mb = "%.2f".format(f.length() / 1024.0 / 1024.0)
            check(f.length() <= budget) { "${f.name} is $mb MB, over the 6 MB budget (ANDROID.md §11)" }
            println("${f.name}: $mb MB of 6 MB")
        }
    }
}
