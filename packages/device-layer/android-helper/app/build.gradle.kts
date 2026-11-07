plugins {
    id("com.android.application")
}

android {
    namespace = "io.sinclair.helper"
    compileSdk {
        version = release(36) { minorApiLevel = 1 }
    }

    defaultConfig {
        applicationId = "io.sinclair.helper"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            optimization { enable = false }
        }
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

dependencies {
    // 외부 의존성 없음: android.accessibilityservice, android.view.accessibility, org.json 만 쓴다(APK 를 작게, 호환성 넓게).
}
