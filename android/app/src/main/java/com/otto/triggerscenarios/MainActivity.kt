package com.otto.triggerscenarios

/* ============================================================
 * Android wrapper — the page, plus the REAL Activity Recognition.
 *
 * A fullscreen WebView loads the deployed web app unchanged. The
 * page's own GPS, mic and wake-lock keep working through the
 * WebChromeClient grants below. What the wrapper adds is what the
 * web cannot have: native detection signals, hosted in a foreground
 * service (ArEngineService — sampled AR, transition edges, step
 * detector, significant motion, fused-location speed, Bluetooth car
 * audio) so state changes land in under ~2 s instead of Play
 * Services' batched 15–60 s. The service pushes through ArBridge and
 * this activity forwards into the seams activity-rec.js left open:
 *
 *   ActivityRec.inject('IN_VEHICLE', 92)   // source: 'native'
 *   ActivityRec.feed({lat, lng, speed})    // fused fixes at 1.5 s
 *
 * Injected states silence the page's own speed+cadence heuristic
 * while fresh, so the trigger detector and the dashboard traces
 * run on the native states — no web-side changes needed.
 * ============================================================ */

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebChromeClient
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.util.Locale

class MainActivity : ComponentActivity() {

    companion object {
        private const val PERMISSIONS_REQUEST = 1
        private const val MIC_REQUEST = 2
    }

    private lateinit var webView: WebView
    private var pendingMicRequest: PermissionRequest? = null // web mic request awaiting the OS dialog

    /* ---------- native text-to-speech ----------
     * Android WebViews have NO Web Speech API — speechSynthesis.speak()
     * silently does nothing, so a hands-free Otto question was text-only
     * in the app. This bridge gives the page the platform's own TTS:
     *   OttoTTS.speak('…')            — speaks; calls window.__ottoTtsDone()
     *   OttoTTS.stop()                — cancels (backing out mid-question)
     * app.js prefers this bridge and falls back to speechSynthesis in
     * ordinary browsers. */
    private var tts: TextToSpeech? = null
    private var ttsReady = false

    private fun notifyTtsDone() {
        runOnUiThread { webView.evaluateJavascript("window.__ottoTtsDone&&__ottoTtsDone()", null) }
    }

    inner class TtsBridge {
        @JavascriptInterface
        fun speak(text: String) {
            if (!ttsReady || text.isBlank()) { notifyTtsDone(); return }
            tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "otto-question")
        }

        @JavascriptInterface
        fun stop() { tts?.stop() }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        /* Field tests run with the phone mounted and the app open — the
         * page also holds a web wake lock, but this is the reliable one. */
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true          // localStorage — demo mode lives there
            setGeolocationEnabled(true)
            mediaPlaybackRequiresUserGesture = false
        }

        webView.addJavascriptInterface(TtsBridge(), "OttoTTS")
        tts = TextToSpeech(this) { status ->
            ttsReady = status == TextToSpeech.SUCCESS
            if (ttsReady) tts?.language = java.util.Locale.US // the scenario questions are English
        }
        tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}
            override fun onDone(utteranceId: String?) = notifyTtsDone()
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) = notifyTtsDone()
        })

        webView.webChromeClient = object : WebChromeClient() {
            /* The page's watchPosition / Geo.locate() land here. */
            override fun onGeolocationPermissionsShowPrompt(
                origin: String?, callback: GeolocationPermissions.Callback?,
            ) {
                callback?.invoke(origin, hasPermission(Manifest.permission.ACCESS_FINE_LOCATION), false)
            }

            /* The Otto debrief's getUserMedia. A missing OS grant used to be
             * an instant deny — the widget silently fell to the scripted
             * demo and testers thought their voice was recorded. Now the
             * OS dialog is raised on the spot and the web request waits
             * for its answer. */
            override fun onPermissionRequest(request: PermissionRequest?) {
                request ?: return
                if (!request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                    request.deny()
                    return
                }
                if (hasPermission(Manifest.permission.RECORD_AUDIO)) {
                    request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                } else {
                    pendingMicRequest?.deny()
                    pendingMicRequest = request
                    ActivityCompat.requestPermissions(
                        this@MainActivity, arrayOf(Manifest.permission.RECORD_AUDIO), MIC_REQUEST,
                    )
                }
            }
        }

        webView.webViewClient = object : WebViewClient() {
            /* Keep the app inside the WebView; hand Google Maps links
             * (Directions / Street View) to the real Maps app. */
            override fun shouldOverrideUrlLoading(
                view: WebView?, request: WebResourceRequest?,
            ): Boolean {
                val url = request?.url ?: return false
                val appHost = Uri.parse(getString(R.string.app_url)).host
                if (url.host == appHost) return false
                startActivity(Intent(Intent.ACTION_VIEW, url))
                return true
            }

            /* tell the page which wrapper build it lives in — shown in
             * the version chip next to the web build stamp */
            override fun onPageFinished(view: WebView?, url: String?) {
                val ver = try {
                    packageManager.getPackageInfo(packageName, 0).versionName ?: "?"
                } catch (_: Exception) { "?" }
                view?.evaluateJavascript(
                    "window.__setWrapperVersion&&__setWrapperVersion('$ver')", null,
                )
            }
        }

        /* The page is loaded only after the permission dialog settles —
         * loading it earlier makes its first geolocation request hit a
         * not-yet-granted state and come back denied. */
        requestNeededPermissions()
    }

    private var pageLoaded = false
    private fun loadAppOnce() {
        if (pageLoaded) return
        pageLoaded = true
        webView.loadUrl(getString(R.string.app_url))
    }

    /* ---------- permissions ---------- */
    private fun hasPermission(p: String) =
        ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private fun requestNeededPermissions() {
        val wanted = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.RECORD_AUDIO,
        )
        if (Build.VERSION.SDK_INT >= 29) wanted.add(Manifest.permission.ACTIVITY_RECOGNITION)
        /* optional extras for the AR engine — denials degrade per-source:
         * no notification permission hides the foreground note (the
         * service still runs); no Bluetooth permission skips the car-audio
         * shortcut */
        if (Build.VERSION.SDK_INT >= 33) wanted.add(Manifest.permission.POST_NOTIFICATIONS)
        if (Build.VERSION.SDK_INT >= 31) wanted.add(Manifest.permission.BLUETOOTH_CONNECT)
        val missing = wanted.filterNot { hasPermission(it) }
        if (missing.isEmpty()) {
            startArEngine()
            loadAppOnce()
        } else {
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), PERMISSIONS_REQUEST)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<String>, grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == MIC_REQUEST) {
            /* answer the web's getUserMedia with whatever the dialog said —
             * a deny here degrades to the labelled scripted demo, as before */
            val req = pendingMicRequest
            pendingMicRequest = null
            if (req != null) {
                if (hasPermission(Manifest.permission.RECORD_AUDIO)) {
                    req.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                } else {
                    req.deny()
                }
            }
            return
        }
        if (requestCode != PERMISSIONS_REQUEST) return
        startArEngine() // per-source permission checks live in the service
        /* now the page's first geolocation request sees the real grants
         * (denied grants degrade gracefully in the page) */
        loadAppOnce()
    }

    /* ---------- the AR engine (ArEngineService) ---------- */
    private fun startArEngine() {
        /* an Android-14 foreground service of type "location" may only
         * start once location is actually granted — without it the page
         * falls back to its own web heuristic, as always */
        if (!hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)) return
        ArBridge.onState = { state, conf -> injectState(state, conf) }
        ArBridge.onFix = { lat, lng, speed, acc -> feedFix(lat, lng, speed, acc) }
        ContextCompat.startForegroundService(this, Intent(this, ArEngineService::class.java))
    }

    private fun injectState(state: String, conf: Int) {
        val js = if (state.isEmpty()) "window.ActivityRec&&ActivityRec.inject(null)"
        else "window.ActivityRec&&ActivityRec.inject('$state',$conf)"
        runOnUiThread { webView.evaluateJavascript(js, null) }
    }

    private fun feedFix(lat: Double, lng: Double, speed: Float, acc: Float) {
        /* Locale.US: a comma decimal separator would break the JS literal */
        val sp = if (speed < 0f) "null" else String.format(Locale.US, "%.2f", speed)
        val js = String.format(
            Locale.US,
            "window.ActivityRec&&ActivityRec.feed({lat:%.6f,lng:%.6f,speed:%s,acc:%.1f})",
            lat, lng, sp, acc,
        )
        runOnUiThread { webView.evaluateJavascript(js, null) }
    }

    override fun onDestroy() {
        tts?.stop()
        tts?.shutdown()
        tts = null
        /* the engine lives for the app, not beyond it — detach the bridge
         * first so a straggling push cannot reach a dead WebView */
        ArBridge.onState = null
        ArBridge.onFix = null
        stopService(Intent(this, ArEngineService::class.java))
        super.onDestroy()
    }
}
