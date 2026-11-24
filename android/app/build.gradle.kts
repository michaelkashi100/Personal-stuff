plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.timeline.personal"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.timeline.personal"
        minSdk = 29
        targetSdk = 34
        // every CI build gets a higher number, so a new APK installs over the old one and keeps its data
        versionCode = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 1
        versionName = "1.$versionCode"
    }

    // A fixed key (committed on purpose: this is a personal, side-loaded app) so updates install over each other.
    signingConfigs {
        create("personal") {
            storeFile = file("../dev.keystore")
            storePassword = "timeline"
            keyAlias = "timeline"
            keyPassword = "timeline"
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("personal")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.work:work-runtime-ktx:2.9.1")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
