import com.android.build.api.dsl.CommonExtension
import org.gradle.api.JavaVersion
import org.gradle.api.Project
import org.gradle.api.artifacts.VersionCatalog
import org.gradle.api.artifacts.VersionCatalogsExtension
import org.gradle.api.tasks.testing.Test
import org.gradle.kotlin.dsl.getByType
import org.gradle.kotlin.dsl.withType
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinAndroidProjectExtension

// SDK levels and compiler settings shared by every module (ANDROID.md §5).

internal const val MIN_SDK = 26
internal const val COMPILE_SDK = 37

internal val Project.libs: VersionCatalog
    get() = extensions.getByType<VersionCatalogsExtension>().named("libs")

internal fun Project.lib(alias: String) = libs.findLibrary(alias).get()

internal fun Project.configureAndroid(android: CommonExtension) {
    android.apply {
        compileSdk = COMPILE_SDK
        defaultConfig.minSdk = MIN_SDK
        compileOptions.apply {
            sourceCompatibility = JavaVersion.VERSION_17
            targetCompatibility = JavaVersion.VERSION_17
        }
        testOptions.unitTests {
            isIncludeAndroidResources = true
            isReturnDefaultValues = false
        }
        lint.apply {
            warningsAsErrors = false
            abortOnError = true
            checkDependencies = true
        }
    }
    extensions.getByType<KotlinAndroidProjectExtension>().apply {
        compilerOptions {
            jvmTarget.set(JvmTarget.JVM_17)
            freeCompilerArgs.addAll("-Xjsr305=strict", "-Xcontext-parameters")
        }
    }
    tasks.withType<Test>().configureEach {
        maxHeapSize = "1g"
        // Integration tests start PocketBase from the repository's bin/ (§13).
        systemProperty("chirkle.repoRoot", rootProject.projectDir.parentFile.absolutePath)
        // An old release's pb_hooks for the old-server tests (-Pchirkle.legacyHooks=…; TestServer.legacyUrl).
        providers.gradleProperty("chirkle.legacyHooks").orNull?.let { systemProperty("chirkle.legacyHooks", it) }
        // The shared contract and vectors (docs/API.md) the lib tests read: a change to them runs the tests again.
        inputs.dir(rootProject.projectDir.parentFile.resolve("shared")).withPathSensitivity(org.gradle.api.tasks.PathSensitivity.RELATIVE)
        testLogging { events("failed"); exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
    }
}
