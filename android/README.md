# Relay for Android

This is Relay — the same app that runs at https://relaaay.online, installed on a
phone. It is a **Trusted Web Activity**: Android launches Chrome, Chrome loads
the site full screen, and once the site has proved it owns this app the address
bar goes away. What is left looks and behaves like a native app, and is one.

## Why a wrapper and not a rewrite

The web app already does the hard parts, and it does them with browser APIs that
a rewrite would have to reimplement and a `WebView` wrapper would quietly break:

| What the app uses | Trusted Web Activity | `WebView` wrapper (Capacitor and friends) |
| --- | --- | --- |
| Passkeys — `server/webauthn.js` | Works; it is Chrome | **No.** `WebView` has no WebAuthn |
| Web Push — `server/push.js`, VAPID | Works, delivered through this app | **No.** Needs an FCM account and a rewrite of the server's push path |
| Voice notes — `getUserMedia`, `MediaRecorder` | Works under Chrome's permission | Needs permission plumbing |
| Offline shell — `public/sw.js` | Works | Partly; service workers in `WebView` are limited |
| Deploying a fix | Ship the site, as now | Rebuild and re-release the app |

A native client would mean writing the messaging UI a second time and keeping
two implementations of every feature in step. Nothing in the repository asks for
that: there is no build step, no framework, and one deployment.

So the wrapper is around 200 lines of XML and no application code at all. The
only Java in the APK is Google's `androidbrowserhelper` library.

## Building an APK

Two ways, and neither needs Android Studio.

### On GitHub

Actions → **Android** → *Run workflow*. When it finishes, download the
`relay-apk` artifact from the run. `.github/workflows/android.yml` builds it.

### Locally

Needs a JDK 17 and the Android SDK (`ANDROID_HOME` set, platform 34).

```sh
cd android
./gradlew assembleDebug
# android/app/build/outputs/apk/debug/app-debug.apk
```

Install it over USB with debugging turned on, or just copy the `.apk` to the
phone and open it:

```sh
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

To build against somewhere other than production:

```sh
./gradlew assembleDebug -PrelayHost=staging.relaaay.online
```

## Making the address bar disappear

A debug APK works immediately, but opens with Chrome's address bar across the
top. That is the app telling you it cannot yet prove it belongs to the site. The
proof is a [Digital Asset Link](https://developers.google.com/digital-asset-links),
and it has two halves:

* **The app names the site.** Already done — `asset_statements` in
  `app/build.gradle`, derived from `relayHost`.
* **The site names the app's signing key.** This part is yours to do, once.

Create a signing key and keep it somewhere safe. If it is lost, no future build
can update an app already installed from this one:

```sh
keytool -genkeypair -v -keystore relay-release.jks -alias relay \
  -keyalg RSA -keysize 2048 -validity 10000
```

Write the matching document into the web root and deploy it:

```sh
npm run assetlinks -- --keystore relay-release.jks --alias relay
# writes public/.well-known/assetlinks.json
```

The server already serves that path as `application/json`; commit the file and
deploy as usual. Then build a signed APK:

```sh
cd android
./gradlew assembleRelease \
  -PrelayKeystore=../relay-release.jks \
  -PrelayKeystorePassword=… -PrelayKeyAlias=relay -PrelayKeyPassword=…
```

Install it, and the address bar is gone. Verification happens on first launch
and is cached, so if it fails the app keeps the bar rather than refusing to
open — a broken asset link never locks anyone out.

To have GitHub build signed APKs, add four repository secrets —
`RELAY_KEYSTORE_BASE64` (`base64 -w0 relay-release.jks`),
`RELAY_KEYSTORE_PASSWORD`, `RELAY_KEY_ALIAS`, `RELAY_KEY_PASSWORD`. The workflow
then also checks the deployed `assetlinks.json` trusts that key, which is the
one mistake nothing else catches.

## What you get

* Home screen icon, own task in the recents list, no browser chrome.
* Links to `relaaay.online` open in the app rather than the browser, on the same
  asset link.
* Push notifications arrive under Relay's name and icon, handed over by Chrome
  through `DelegationService`. Android 13 and newer ask for notification
  permission on first launch; the site's own prompt still governs subscribing.
* System bars coloured from the web app's `theme_color`, following light and
  dark like the page does.

## Play Store

Nothing here depends on it: the APK installs directly. If you do want a listing,
a Play release needs an `.aab` (`./gradlew bundleRelease`), a Play Console
account, and — if you let Google re-sign the app — the fingerprint in
`assetlinks.json` must be the one Play Console shows under *App signing*, not
the one from your own keystore. That is the usual way this breaks.

## Layout

```
android/
  settings.gradle, build.gradle, gradle.properties   which site, which key
  app/build.gradle                                   the whole build
  app/src/main/AndroidManifest.xml                   the whole app
  app/src/main/res/                                  icon, colours, splash
```

No `src/main/java`. There is nothing for it to hold.
