---
title: The Android app for server admins
description: Make Chirkle room links open in the Android app, ask old app versions to update, and build the app for your own server.
section: Android app
order: 2
---

The app works with any Chirkle server as it is: people tap **Change server** and enter your address. Nothing needs
setting up for notifications. This page covers the rest.

## Ask old versions to update

When a server update needs a newer app, set `min_android_version` on the site record (*Collections → site* in the
admin UI) to the lowest app version code that should keep working. Older apps then show **Update required** with a
link to the download, instead of a screen that might break.

A release's version code is `versionCode` in
[`android/app/build.gradle.kts`](https://github.com/border-radius/chirkle/blob/master/android/app/build.gradle.kts) at
its tag. It goes up by one with every release: version 0.4.1, for example, is 11.

## Build the app for your own server

A build of your own can offer your server first, so people only log in, and can open your server's links in the app.
Building needs JDK 17 or newer (21 recommended) and the Android SDK (`ANDROID_HOME`, or `sdk.dir` in
`android/local.properties`); Gradle fetches the rest.

From a clone of the [repository](https://github.com/border-radius/chirkle):

```sh
cd android
./gradlew assembleRelease \
  -Pchirkle.server=https://chat.example.com \
  -Pchirkle.appId=com.example.chat \
  -Pchirkle.keystore=/path/to/release.jks \
  -Pchirkle.keystorePassword=… \
  -Pchirkle.keyAlias=…
```

- `chirkle.server` is the server the app offers first. People can still tap **Change server**.
- `chirkle.appId` is your app's ID, so it installs next to the official app instead of replacing it.
- The `chirkle.keystore…` properties sign it with your key. Without them, the release is signed with the debug key,
  which is fine for trying it out. `chirkle.keyPassword` defaults to the keystore's password.

The APK is in `app/build/outputs/apk/release/`. `./gradlew checkApkSize` with the same properties checks it stays
under the size budget.

## Open room links in the app

Links to your server (rooms, messages, invite links) can open in your build of the app instead of the browser. Set two
environment variables on the server and restart it:

- `ANDROID_CERT_SHA256`: the SHA-256 fingerprint of the key the app is signed with. Several, comma-separated, if you
  sign with more than one. Get it with `keytool -list -v -keystore release.jks`.
- `ANDROID_APP_ID`: your app's ID, if you changed it with `chirkle.appId`.

The server then serves `/.well-known/assetlinks.json`, which Android checks when the app is installed. This only works
for the server the build offers first (`chirkle.server`).
