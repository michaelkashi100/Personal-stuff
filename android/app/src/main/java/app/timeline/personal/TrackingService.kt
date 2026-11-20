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
import android.location.Location
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority

/**
 * Records GPS while you are moving, and nothing else. It is started by [ActivityReceiver] when Android reports
 * that you started moving and stops itself a few minutes after you are still again, so GPS is off almost all day.
 * Fixes arrive in batches (see [Policy.paramsFor]) so the processor sleeps between them.
 */
class TrackingService : Service() {
    private lateinit var client: FusedLocationProviderClient
    private val handler = Handler(Looper.getMainLooper())
    private var mode: Mode? = null
    private var lastLat: Double? = null
    private var lastLng: Double? = null
    private var lastMoveAt = 0L

    private val callback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) = onFixes(result.locations)
    }
    private val stopRunnable = Runnable { stopSelf() }
    private val idleCheck = object : Runnable {
        override fun run() {
            if (Policy.idleTooLong(System.currentTimeMillis(), lastMoveAt)) stopSelf() else handler.postDelayed(this, 60_000L)
        }
    }

    override fun onCreate() {
        super.onCreate()
        client = LocationServices.getFusedLocationProviderClient(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startAsForeground()           // must happen promptly after startForegroundService
        running = true
        if (!Recorder.hasFine(this)) { stopSelf(); return START_NOT_STICKY }
        if (intent?.action == ACTION_STILL) {
            // still for a while: keep going a little longer to capture the arrival, then stop
            handler.removeCallbacks(stopRunnable)
            handler.postDelayed(stopRunnable, Policy.STOP_AFTER_STILL_MS)
        } else {
            handler.removeCallbacks(stopRunnable)
            val m = runCatching { Mode.valueOf(intent?.getStringExtra(EXTRA_MODE) ?: "WALK") }.getOrDefault(Mode.WALK)
            if (m != mode) request(m)
            lastMoveAt = System.currentTimeMillis()
            handler.removeCallbacks(idleCheck)
            handler.postDelayed(idleCheck, 60_000L)
        }
        return START_NOT_STICKY
    }

    @SuppressLint("MissingPermission")
    private fun request(m: Mode) {
        val p = Policy.paramsFor(m)
        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, p.intervalMs)
            .setMinUpdateDistanceMeters(p.minDistanceM)
            .setMaxUpdateDelayMillis(p.maxDelayMs)
            .build()
        if (mode != null) client.removeLocationUpdates(callback)
        client.requestLocationUpdates(request, callback, Looper.getMainLooper())
        mode = m
    }

    private fun onFixes(list: List<Location>) {
        val fixes = ArrayList<Fix>(list.size)
        for (l in list) {
            if (!Policy.accept(l.accuracy)) continue
            fixes.add(Fix(l.time, l.latitude, l.longitude, l.accuracy, if (l.hasSpeed()) l.speed else -1f, 1))
            val la = lastLat
            val ln = lastLng
            if (la == null || ln == null || Policy.moved(Policy.distanceM(la, ln, l.latitude, l.longitude))) {
                lastMoveAt = System.currentTimeMillis(); lastLat = l.latitude; lastLng = l.longitude
            }
        }
        if (fixes.isNotEmpty()) Db.get(this).insertFixes(fixes)
    }

    private fun startAsForeground() {
        val nm = getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Recording a trip", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
        }
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n: Notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("Recording your trip")
            .setContentText("Saved only on this phone. Stops when you do.")
            .setOngoing(true)
            .setContentIntent(open)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
        ServiceCompat.startForeground(this, NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
    }

    override fun onDestroy() {
        running = false
        handler.removeCallbacksAndMessages(null)
        if (mode != null) try { client.removeLocationUpdates(callback) } catch (e: Exception) {}
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        @Volatile var running = false
        const val EXTRA_MODE = "mode"
        const val ACTION_STILL = "app.timeline.personal.STILL"
        private const val CHANNEL = "recording"
        private const val NOTIFICATION_ID = 7

        fun start(c: Context, mode: Mode) {
            ContextCompat.startForegroundService(c, Intent(c, TrackingService::class.java).putExtra(EXTRA_MODE, mode.name))
        }

        fun still(c: Context) {
            if (running) ContextCompat.startForegroundService(c, Intent(c, TrackingService::class.java).setAction(ACTION_STILL))
        }
    }
}
