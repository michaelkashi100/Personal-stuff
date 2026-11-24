package app.timeline.personal

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.TriggerEvent
import android.hardware.TriggerEventListener
import android.location.GnssStatus
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import java.util.UUID

/**
 * The recorder. It stays quietly in the background (Android requires a small notification for that) and uses only the
 * phone's own hardware, no Google service:
 *  - the "significant motion" chip and the step counter wake it when you start moving (they cost almost nothing),
 *  - then GPS runs, batched, and the app guesses walking / cycling / driving itself ([ActivityGuess]),
 *  - a few minutes after you stop, GPS is switched off again.
 * With each fix it notes what the cleaning can use: altitude, satellites and their signal strength, how many Wi-Fi
 * networks are around, and a scrambled code of the Wi-Fi you are connected to.
 */
class TrackingService : Service() {
    private lateinit var lm: LocationManager
    private lateinit var sm: SensorManager
    private var wm: WifiManager? = null
    private val handler = Handler(Looper.getMainLooper())
    private var gpsMode: Mode? = null
    private var activity: Int? = null
    private var lastLat: Double? = null
    private var lastLng: Double? = null
    private var lastMoveAt = 0L
    private var lastStepAt = 0L
    private var stepBase = -1f
    private val stepLog = ArrayDeque<Pair<Long, Float>>()      // (time, cumulative steps)
    private var sats = -1
    private var cn0 = -1f
    private val minuteSpeeds = ArrayList<Float>()
    private val accel = FloatArray(400)
    private var accelN = 0
    private lateinit var salt: String

    private val gpsListener = object : LocationListener {
        override fun onLocationChanged(location: Location) = onFixes(listOf(location))
        override fun onLocationChanged(locations: MutableList<Location>) = onFixes(locations)
        @Deprecated("old API") override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) {}
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
    }
    private val gnss = object : GnssStatus.Callback() {
        override fun onSatelliteStatusChanged(status: GnssStatus) {
            var used = 0; val c = ArrayList<Float>()
            for (i in 0 until status.satelliteCount) { if (status.usedInFix(i)) used++; c.add(status.getCn0DbHz(i)) }
            c.sortDescending()
            sats = used; cn0 = if (c.size >= 4) (c[0] + c[1] + c[2] + c[3]) / 4f else -1f
        }
    }
    private val motion = object : TriggerEventListener() {
        override fun onTrigger(event: TriggerEvent?) { startGps(Mode.WALK) }
    }
    private val sensors = object : SensorEventListener {
        override fun onSensorChanged(e: SensorEvent) {
            when (e.sensor.type) {
                Sensor.TYPE_STEP_COUNTER -> onSteps(e.values[0])
                Sensor.TYPE_ACCELEROMETER -> if (accelN < accel.size) { val x = e.values[0]; val y = e.values[1]; val z = e.values[2]; accel[accelN++] = Math.sqrt((x * x + y * y + z * z).toDouble()).toFloat() }
            }
        }
        override fun onAccuracyChanged(s: Sensor?, a: Int) {}
    }
    private val minute = object : Runnable {
        override fun run() { everyMinute(); handler.postDelayed(this, 60_000L) }
    }

    override fun onCreate() {
        super.onCreate()
        lm = getSystemService(LocationManager::class.java)
        sm = getSystemService(SensorManager::class.java)
        wm = applicationContext.getSystemService(WifiManager::class.java)
        val p = Recorder.prefs(this)
        salt = p.getString("wifiSalt", null) ?: UUID.randomUUID().toString().also { p.edit().putString("wifiSalt", it).apply() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startAsForeground(false)       // must happen promptly after startForegroundService
        if (!Recorder.enabled(this) || !Recorder.hasFine(this)) { stopSelf(); return START_NOT_STICKY }
        if (!running) {
            running = true
            armMotion()
            if (Recorder.hasActivity(this)) sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)?.let { sm.registerListener(sensors, it, SensorManager.SENSOR_DELAY_NORMAL, 60_000_000) }
            handler.postDelayed(minute, 60_000L)
        }
        if (intent?.action == ACTION_MOVED) startGps(Mode.WALK)    // a free fix from another app says you moved far
        return START_STICKY
    }

    private fun armMotion() {
        val s = sm.getDefaultSensor(Sensor.TYPE_SIGNIFICANT_MOTION) ?: return
        try { sm.requestTriggerSensor(motion, s) } catch (e: Exception) { /* not available */ }
    }

    private fun onSteps(total: Float) {
        val now = System.currentTimeMillis()
        if (stepBase >= 0 && total > stepBase) lastStepAt = now
        stepBase = total
        stepLog.addLast(now to total)
        while (stepLog.isNotEmpty() && now - stepLog.first().first > 3 * 60_000L) stepLog.removeFirst()
        if (gpsMode == null && Policy.shouldStartGps(stepsSince(now - 2 * 60_000L), false, 0.0)) startGps(Mode.WALK)
    }

    private fun stepsSince(t: Long): Int {
        val first = stepLog.firstOrNull { it.first >= t } ?: return 0
        return (stepLog.last().second - first.second).toInt().coerceAtLeast(0)
    }

    @SuppressLint("MissingPermission")
    private fun startGps(m: Mode) {
        if (!Recorder.hasFine(this)) return
        val now = System.currentTimeMillis()
        if (gpsMode == null) { lastMoveAt = now; lastStepAt = maxOf(lastStepAt, now - 60_000L); startAsForeground(true) }
        if (gpsMode == m) return
        val p = Policy.paramsFor(m)
        try {
            if (gpsMode != null) lm.removeUpdates(gpsListener)
            if (Build.VERSION.SDK_INT >= 31) {
                val req = android.location.LocationRequest.Builder(p.intervalMs).setMinUpdateDistanceMeters(p.minDistanceM)
                    .setMaxUpdateDelayMillis(p.maxDelayMs).setQuality(android.location.LocationRequest.QUALITY_HIGH_ACCURACY).build()
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, req, ContextCompat.getMainExecutor(this), gpsListener)
            } else {
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, p.intervalMs, p.minDistanceM, gpsListener, Looper.getMainLooper())
            }
            if (gpsMode == null) {
                if (Build.VERSION.SDK_INT >= 30) lm.registerGnssStatusCallback(ContextCompat.getMainExecutor(this), gnss)
                else lm.registerGnssStatusCallback(gnss, handler)
                sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)?.let { sm.registerListener(sensors, it, 200_000, 10_000_000) }   // 5 Hz, batched
            }
            gpsMode = m
        } catch (e: SecurityException) { /* permission revoked */ } catch (e: IllegalArgumentException) { /* no GPS on this phone */ }
    }

    private fun stopGps() {
        if (gpsMode == null) return
        try { lm.removeUpdates(gpsListener) } catch (e: Exception) {}
        try { lm.unregisterGnssStatusCallback(gnss) } catch (e: Exception) {}
        sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)?.let { sm.unregisterListener(sensors, it) }
        gpsMode = null; sats = -1; cn0 = -1f
        setActivity(Policy.STILL)
        armMotion()
        startAsForeground(false)
    }

    /** Once a minute while recording: guess the activity, adapt GPS to it, and stop when you have stopped. */
    private fun everyMinute() {
        val now = System.currentTimeMillis()
        if (gpsMode == null) return
        if (Policy.shouldStopGps(now, lastStepAt, lastMoveAt) || Policy.idleTooLong(now, lastMoveAt)) { stopGps(); return }
        val sp = minuteSpeeds.sorted()
        val speed = if (sp.isEmpty()) -1.0 else sp[sp.size / 2].toDouble()
        val guess = ActivityGuess.classify(ActivityGuess.Window(stepsSince(now - 60_000L), 60.0, speed, ActivityGuess.shake(accel, accelN)))
        minuteSpeeds.clear(); accelN = 0
        if (guess != null && guess != Policy.STILL) { setActivity(guess); startGps(Policy.modeForActivity(guess)) }
    }

    private fun setActivity(type: Int) {
        if (type == activity) return
        val now = System.currentTimeMillis()
        val db = Db.get(this)
        activity?.let { db.insertAct(Act(now, it, false)) }
        db.insertAct(Act(now, type, true))
        activity = type
    }

    @SuppressLint("MissingPermission")
    private fun wifi(): Pair<Int?, String?> {
        val w = wm ?: return null to null
        val n = try { w.scanResults?.size } catch (e: Exception) { null }          // the last scan Android made anyway: no new scan
        @Suppress("DEPRECATION") val h = try { WifiHash.of(w.connectionInfo?.bssid, salt) } catch (e: Exception) { null }
        return n to h
    }

    private fun onFixes(list: List<Location>) {
        val fixes = ArrayList<Fix>(list.size)
        val (wn, wh) = wifi()
        for (l in list) {
            if (!Policy.accept(l.accuracy)) continue
            if (l.hasSpeed()) minuteSpeeds.add(l.speed)
            fixes.add(Fix(l.time, l.latitude, l.longitude, l.accuracy, if (l.hasSpeed()) l.speed else -1f, 1,
                if (l.hasAltitude()) l.altitude else null, if (l.hasVerticalAccuracy()) l.verticalAccuracyMeters else null, l.provider,
                if (sats >= 0) sats else null, if (cn0 > 0) cn0 else null, wn, wh))
            val la = lastLat
            val ln = lastLng
            if (la == null || ln == null || Policy.moved(Policy.distanceM(la, ln, l.latitude, l.longitude))) {
                lastMoveAt = System.currentTimeMillis(); lastLat = l.latitude; lastLng = l.longitude
            }
        }
        if (fixes.isNotEmpty()) Db.get(this).insertFixes(fixes)
    }

    private fun startAsForeground(recording: Boolean) {
        val nm = getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Timeline recorder", NotificationManager.IMPORTANCE_MIN).apply { setShowBadge(false) })
        }
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n: Notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(if (recording) "Recording your trip" else "Timeline is ready")
            .setContentText(if (recording) "Saved only on this phone. Stops when you do." else "GPS is off until you start moving.")
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setContentIntent(open)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
        ServiceCompat.startForeground(this, NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
    }

    override fun onDestroy() {
        running = false
        handler.removeCallbacksAndMessages(null)
        try { lm.removeUpdates(gpsListener) } catch (e: Exception) {}
        try { lm.unregisterGnssStatusCallback(gnss) } catch (e: Exception) {}
        try { sm.unregisterListener(sensors) } catch (e: Exception) {}
        sm.getDefaultSensor(Sensor.TYPE_SIGNIFICANT_MOTION)?.let { try { sm.cancelTriggerSensor(motion, it) } catch (e: Exception) {} }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        @Volatile var running = false
        const val ACTION_MOVED = "app.timeline.personal.MOVED"
        private const val CHANNEL = "recorder"
        private const val NOTIFICATION_ID = 7

        /** Make sure the recorder is running (safe to call often). */
        fun ensure(c: Context, moved: Boolean = false) {
            val i = Intent(c, TrackingService::class.java)
            if (moved) i.action = ACTION_MOVED
            try { ContextCompat.startForegroundService(c, i) } catch (e: Exception) { /* Android refused a background start: the next app open retries */ }
        }
    }
}
