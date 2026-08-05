package com.otto.triggerscenarios

/* ============================================================
 * Android wrapper — the page, plus the REAL Activity Recognition.
 *
 * A fullscreen WebView loads the deployed web app unchanged. The
 * page's own GPS, mic and wake-lock keep working through the
 * WebChromeClient grants below. What the wrapper adds is the one
 * thing the web cannot have: Google's Activity Recognition API
 * from Play Services. Detected activities are piped into the
 * page through the seam activity-rec.js left open:
 *
 *   ActivityRec.inject('IN_VEHICLE', 92)   // source: 'native'
 *
 * Injected states silence the page's own speed+cadence heuristic
 * while fresh, so the trigger detector and the dashboard traces
 * run on Google's states — no web-side changes needed.
 * ============================================================ */

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebChromeClient
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityRecognitionResult
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.ActivityTransitionResult
import com.google.android.gms.location.DetectedActivity

class MainActivity : ComponentActivity() {

    companion object {
        private const val ACTION_AR = "com.otto.triggerscenarios.AR_UPDATE"
        private const val ACTION_AR_TRANSITION = "com.otto.triggerscenarios.AR_TRANSITION"
        private const val PERMISSIONS_REQUEST = 1
        private const val AR_INTERVAL_MS = 2000L

        /* Google's DetectedActivity ints -> the names the sheet and the
         * web module already speak. */
        fun typeName(t: Int): String = when (t) {
            DetectedActivity.IN_VEHICLE -> "IN_VEHICLE"
            DetectedActivity.ON_BICYCLE -> "ON_BICYCLE"
            DetectedActivity.ON_FOOT -> "ON_FOOT"
            DetectedActivity.RUNNING -> "RUNNING"
            DetectedActivity.STILL -> "STILL"
            DetectedActivity.TILTING -> "TILTING"
            DetectedActivity.WALKING -> "WALKING"
            else -> "UNKNOWN"
        }
    }

    private lateinit var webView: WebView
    private var arReceiver: BroadcastReceiver? = null
    private var arPendingIntent: PendingIntent? = null
    private var arTransitionIntent: PendingIntent? = null

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

        webView.webChromeClient = object : WebChromeClient() {
            /* The page's watchPosition / Geo.locate() land here. */
            override fun onGeolocationPermissionsShowPrompt(
                origin: String?, callback: GeolocationPermissions.Callback?,
            ) {
                callback?.invoke(origin, hasPermission(Manifest.permission.ACCESS_FINE_LOCATION), false)
            }

            /* The Otto debrief's getUserMedia — grant the mic when the app has it. */
            override fun onPermissionRequest(request: PermissionRequest?) {
                request ?: return
                val wantsMic = request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
                if (wantsMic && hasPermission(Manifest.permission.RECORD_AUDIO)) {
                    request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                } else {
                    request.deny()
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
        val missing = wanted.filterNot { hasPermission(it) }
        if (missing.isEmpty()) {
            startActivityRecognition()
            loadAppOnce()
        } else {
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), PERMISSIONS_REQUEST)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<String>, grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != PERMISSIONS_REQUEST) return
        val arOk = Build.VERSION.SDK_INT < 29 || hasPermission(Manifest.permission.ACTIVITY_RECOGNITION)
        if (arOk) startActivityRecognition()
        /* now the page's first geolocation request sees the real grants
         * (denied grants degrade gracefully in the page) */
        loadAppOnce()
    }

    /* ---------- the real Activity Recognition API ---------- */
    @SuppressLint("MissingPermission", "UnspecifiedRegisterReceiverFlag")
    private fun startActivityRecognition() {
        if (arReceiver != null) return

        arReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                intent ?: return
                /* Transition events are the fast, pre-debounced edges —
                 * inject them the moment they land. The sampled updates
                 * keep confidence fresh between edges. */
                if (ActivityTransitionResult.hasResult(intent)) {
                    val last = ActivityTransitionResult.extractResult(intent)
                        ?.transitionEvents?.lastOrNull() ?: return
                    inject(typeName(last.activityType), 95)
                    return
                }
                if (!ActivityRecognitionResult.hasResult(intent)) return
                val most = ActivityRecognitionResult.extractResult(intent)
                    ?.mostProbableActivity ?: return
                inject(typeName(most.type), most.confidence)
            }
        }
        val filter = IntentFilter().apply {
            addAction(ACTION_AR)
            addAction(ACTION_AR_TRANSITION)
        }
        ContextCompat.registerReceiver(this, arReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)

        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
        arPendingIntent = PendingIntent.getBroadcast(
            this, 0, Intent(ACTION_AR).setPackage(packageName), flags,
        )
        ActivityRecognition.getClient(this)
            .requestActivityUpdates(AR_INTERVAL_MS, arPendingIntent!!)

        /* enter-edges for every type the Transition API supports
         * (ON_FOOT deliberately absent — it is not a valid transition type) */
        val transitions = listOf(
            DetectedActivity.IN_VEHICLE, DetectedActivity.ON_BICYCLE,
            DetectedActivity.WALKING, DetectedActivity.RUNNING, DetectedActivity.STILL,
        ).map {
            ActivityTransition.Builder()
                .setActivityType(it)
                .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_ENTER)
                .build()
        }
        arTransitionIntent = PendingIntent.getBroadcast(
            this, 1, Intent(ACTION_AR_TRANSITION).setPackage(packageName), flags,
        )
        ActivityRecognition.getClient(this)
            .requestActivityTransitionUpdates(ActivityTransitionRequest(transitions), arTransitionIntent!!)
    }

    private fun inject(state: String, confidence: Int) {
        val js = "window.ActivityRec&&ActivityRec.inject('$state',$confidence)"
        runOnUiThread { webView.evaluateJavascript(js, null) }
    }

    override fun onDestroy() {
        try {
            arPendingIntent?.let { ActivityRecognition.getClient(this).removeActivityUpdates(it) }
            arTransitionIntent?.let { ActivityRecognition.getClient(this).removeActivityTransitionUpdates(it) }
        } catch (_: SecurityException) { /* permission got revoked */ }
        arReceiver?.let { unregisterReceiver(it) }
        arReceiver = null
        super.onDestroy()
    }
}
