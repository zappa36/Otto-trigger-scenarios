package com.otto.triggerscenarios

/* ============================================================
 * AR engine — foreground service.
 *
 * Play Services batches activity updates aggressively once an app
 * is not in the foreground (15–60 s between deliveries); a foreground
 * service with an ongoing notification keeps every source below
 * running at full rate and exempt from Doze throttling. The page's JS
 * still pauses with the screen — this service makes the SIGNALS fast
 * and keeps them flowing; the WebView applies them the moment it runs.
 *
 * Sources, fastest first (all pushed through ArBridge into
 * ActivityRec.inject / ActivityRec.feed on the page — injected states
 * commit there immediately, no re-debouncing):
 *
 *   1. Transition API edges           — pre-debounced by Google, as-is
 *   2. Sampled updates @ 2 s          — 3-sample window; >70% or a
 *                                       2-of-3 agreement commits at once
 *   3. Step detector                  — first step ⇒ WALKING, instantly
 *   4. Significant motion (one-shot)  — breaks a stale STILL immediately
 *   5. Fused location @ 1.5 s         — speed > 4.5 m/s on 2 consecutive
 *                                       fixes ⇒ IN_VEHICLE; every fix
 *                                       also feeds the page's detector
 *   6. Bluetooth car audio            — head-unit connect ⇒ IN_VEHICLE
 *                                       with zero latency
 * ============================================================ */

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.bluetooth.BluetoothClass
import android.bluetooth.BluetoothDevice
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.TriggerEvent
import android.hardware.TriggerEventListener
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityRecognitionResult
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.ActivityTransitionResult
import com.google.android.gms.location.DetectedActivity
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority

/* The service and the activity share one process — a tiny bridge
 * instead of binder ceremony. The activity sets the sinks while its
 * WebView is alive; the service pushes and never cares who listens. */
object ArBridge {
    /** state "" means: clear the native injection, let the page's own heuristic rule. */
    @Volatile var onState: ((state: String, conf: Int) -> Unit)? = null

    /** speed < 0 means: this fix carries no speed. */
    @Volatile var onFix: ((lat: Double, lng: Double, speed: Float, acc: Float) -> Unit)? = null
}

class ArEngineService : Service(), SensorEventListener {

    companion object {
        private const val CHANNEL = "ar_engine"
        private const val NOTE_ID = 7
        private const val ACTION_AR = "com.otto.triggerscenarios.AR_UPDATE"
        private const val ACTION_AR_TRANSITION = "com.otto.triggerscenarios.AR_TRANSITION"
        private const val AR_INTERVAL_MS = 2000L
        private const val FIX_INTERVAL_MS = 1500L
        private const val VEHICLE_SPEED = 4.5f // m/s ≈ 16 km/h — above any walk
        private const val CONFIDENT = 70

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

    private var arReceiver: BroadcastReceiver? = null
    private var btReceiver: BroadcastReceiver? = null
    private var arPendingIntent: PendingIntent? = null
    private var arTransitionIntent: PendingIntent? = null
    private var fused: FusedLocationProviderClient? = null
    private var locCallback: LocationCallback? = null
    private var sensors: SensorManager? = null
    private var motionListener: TriggerEventListener? = null

    /* 3-sample sliding window over the sampled updates */
    private val window = ArrayDeque<Pair<String, Int>>()
    @Volatile private var lastState = ""
    private var fastFixes = 0
    private var lastStepPush = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startForegroundWithNote()
        startActivitySources()
        startStepAndMotionSensors()
        startFusedSpeed()
        startBtCarWatch()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    private fun hasPermission(p: String) =
        ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private fun push(state: String, conf: Int) {
        lastState = state
        ArBridge.onState?.invoke(state, conf)
    }

    private fun clearInjection() {
        lastState = ""
        ArBridge.onState?.invoke("", 0)
    }

    /* ---------- foreground shell ---------- */
    private fun startForegroundWithNote() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Field test engine", NotificationManager.IMPORTANCE_LOW),
        )
        val note: Notification = Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("Otto field test running")
            .setContentText("Activity & location tracked at full rate")
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 29) {
            ServiceCompat.startForeground(this, NOTE_ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTE_ID, note)
        }
    }

    /* ---------- 1+2: the real Activity Recognition API ---------- */
    @SuppressLint("MissingPermission", "UnspecifiedRegisterReceiverFlag")
    private fun startActivitySources() {
        if (Build.VERSION.SDK_INT >= 29 && !hasPermission(Manifest.permission.ACTIVITY_RECOGNITION)) return
        if (arReceiver != null) return

        arReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                intent ?: return
                /* transition events are the fast, pre-debounced edges —
                 * straight through, no window */
                if (ActivityTransitionResult.hasResult(intent)) {
                    val last = ActivityTransitionResult.extractResult(intent)
                        ?.transitionEvents?.lastOrNull() ?: return
                    push(typeName(last.activityType), 95)
                    return
                }
                if (!ActivityRecognitionResult.hasResult(intent)) return
                val most = ActivityRecognitionResult.extractResult(intent)
                    ?.mostProbableActivity ?: return
                onSampled(typeName(most.type), most.confidence)
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
         * (ON_FOOT deliberately absent — not a valid transition type) */
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

    /* Sampled results arrive every ~2 s; commit as soon as one is
     * confident (>70%) or two of the last three agree — never wait for
     * Google's own long debounce. */
    private fun onSampled(state: String, conf: Int) {
        window.addLast(state to conf)
        while (window.size > 3) window.removeFirst()
        when {
            conf > CONFIDENT -> push(state, conf)
            window.count { it.first == state } >= 2 -> push(state, CONFIDENT)
        }
    }

    /* ---------- 3+4: instant hardware triggers ---------- */
    private fun startStepAndMotionSensors() {
        sensors = getSystemService(SensorManager::class.java)
        val s = sensors ?: return
        /* first step ⇒ WALKING — no waiting for Play Services (needs the
         * same ACTIVITY_RECOGNITION grant on API 29+) */
        if (Build.VERSION.SDK_INT < 29 || hasPermission(Manifest.permission.ACTIVITY_RECOGNITION)) {
            s.getDefaultSensor(Sensor.TYPE_STEP_DETECTOR)?.let {
                s.registerListener(this, it, SensorManager.SENSOR_DELAY_FASTEST)
            }
        }
        armSignificantMotion()
    }

    private fun armSignificantMotion() {
        val s = sensors ?: return
        val sm = s.getDefaultSensor(Sensor.TYPE_SIGNIFICANT_MOTION) ?: return
        motionListener = object : TriggerEventListener() {
            override fun onTrigger(event: TriggerEvent?) {
                /* a stale STILL must not outlive real movement: drop the
                 * injection so the fast sources re-decide immediately */
                if (lastState == "STILL") clearInjection()
                armSignificantMotion() // one-shot sensor — re-arm every time
            }
        }
        s.requestTriggerSensor(motionListener, sm)
    }

    override fun onSensorChanged(e: SensorEvent?) {
        if (e?.sensor?.type != Sensor.TYPE_STEP_DETECTOR) return
        val now = System.currentTimeMillis()
        if (now - lastStepPush > 2000) { // steps land per stride — refresh, don't spam
            lastStepPush = now
            push("WALKING", 75)
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) { /* not used */ }

    /* ---------- 5: fused-location speed bypass ---------- */
    @SuppressLint("MissingPermission")
    private fun startFusedSpeed() {
        if (!hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)) return
        fused = LocationServices.getFusedLocationProviderClient(this)
        locCallback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                for (loc in result.locations) {
                    /* every fix also feeds the page's own detector — fused
                     * fixes at 1.5 s beat WebView geolocation on both rate
                     * and quality */
                    ArBridge.onFix?.invoke(
                        loc.latitude, loc.longitude,
                        if (loc.hasSpeed()) loc.speed else -1f, loc.accuracy,
                    )
                    if (loc.hasSpeed() && loc.speed > VEHICLE_SPEED) {
                        if (++fastFixes >= 2) push("IN_VEHICLE", 92)
                    } else {
                        fastFixes = 0
                    }
                }
            }
        }
        fused?.requestLocationUpdates(
            LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, FIX_INTERVAL_MS).build(),
            locCallback!!,
            mainLooper,
        )
    }

    /* ---------- 6: Bluetooth car audio ---------- */
    private fun startBtCarWatch() {
        if (Build.VERSION.SDK_INT >= 31 && !hasPermission(Manifest.permission.BLUETOOTH_CONNECT)) return
        btReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                intent ?: return
                @Suppress("DEPRECATION")
                val device = intent.getParcelableExtra<BluetoothDevice>(BluetoothDevice.EXTRA_DEVICE) ?: return
                val cls = try { device.bluetoothClass?.deviceClass } catch (_: SecurityException) { null } ?: return
                val car = cls == BluetoothClass.Device.AUDIO_VIDEO_CAR_AUDIO ||
                    cls == BluetoothClass.Device.AUDIO_VIDEO_HANDSFREE
                if (!car) return
                when (intent.action) {
                    BluetoothDevice.ACTION_ACL_CONNECTED -> push("IN_VEHICLE", 85)
                    BluetoothDevice.ACTION_ACL_DISCONNECTED ->
                        if (lastState == "IN_VEHICLE") clearInjection()
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction(BluetoothDevice.ACTION_ACL_CONNECTED)
            addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED)
        }
        ContextCompat.registerReceiver(this, btReceiver, filter, ContextCompat.RECEIVER_EXPORTED)
    }

    /* ---------- teardown ---------- */
    override fun onDestroy() {
        try {
            arPendingIntent?.let { ActivityRecognition.getClient(this).removeActivityUpdates(it) }
            arTransitionIntent?.let { ActivityRecognition.getClient(this).removeActivityTransitionUpdates(it) }
        } catch (_: SecurityException) { /* permission got revoked */ }
        arReceiver?.let { unregisterReceiver(it) }
        arReceiver = null
        btReceiver?.let { unregisterReceiver(it) }
        btReceiver = null
        locCallback?.let { fused?.removeLocationUpdates(it) }
        locCallback = null
        motionListener?.let { sensors?.cancelTriggerSensor(it, sensors?.getDefaultSensor(Sensor.TYPE_SIGNIFICANT_MOTION)) }
        motionListener = null
        sensors?.unregisterListener(this)
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
}
