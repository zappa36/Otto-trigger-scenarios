# Android wrapper — the real Activity Recognition API

The web app runs fine in Chrome on a phone, with activity states
inferred from GPS speed + step cadence (`source: 'web'`). This wrapper
exists for the one thing the web cannot do: **Google's Activity
Recognition API**, which lives in Play Services and is Android-only.

It is a single fullscreen WebView that loads the deployed site
unchanged and pipes real detected activities into the seam
`activity-rec.js` left open:

```kotlin
webView.evaluateJavascript("ActivityRec.inject('IN_VEHICLE', 92)", null)
```

Injected states carry `source: 'native'` and silence the web heuristic
while fresh — the trigger detector, the AR chip, and the dashboard
traces all run on Google's states with zero web-side changes. The
page's own GPS, mic (Otto debrief) and localStorage keep working via
the WebChromeClient grants.

## Getting the APK

Every push that touches `android/` runs the `android-apk` GitHub Action.
Open the run → **Artifacts** → download `otto-trigger-tests-apk`, copy
`app-debug.apk` to the phone, and install it (allow "install unknown
apps" for your file manager once). Or build locally: open `android/` in
Android Studio, or `gradle -p android assembleDebug`.

On first launch the app asks for **location**, **microphone**, and
**physical activity** — all three are needed for a full test run.

## Pointing it elsewhere

The loaded URL is `app_url` in
[`app/src/main/res/values/strings.xml`](app/src/main/res/values/strings.xml)
— set it to a Vercel preview URL to field-test a branch, or to
`http://<laptop-ip>:8000` on the same wifi for local dev.

## Not in v1, on purpose

- **Screen-off tracking.** Activity updates arrive via broadcast either
  way, but the page (WebView) must be alive to receive `inject()` — so
  keep the app open during a test; it holds the screen awake itself.
  A foreground service that buffers states while the screen is off is
  the natural v2.
- **Fused-location feeding.** The page's own `watchPosition` works
  inside the WebView; `ActivityRec.feed()` is there if native fused
  location ever proves better.
