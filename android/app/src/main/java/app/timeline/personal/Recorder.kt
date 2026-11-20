package app.timeline.personal

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.DetectedActivity
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import java.util.concurrent.TimeUnit

/**
 * Switches recording on and off. Three cheap sources feed the database:
 *  - activity recognition wakes the app when you start or stop moving (a low-power sensor service, no GPS),
 *  - passive location receives, for free, the fixes other apps cause,
 *  - an hourly coarse check-in covers the time you stand still.
 * GPS itself only runs inside [TrackingService], and only while you move.
 */
object Recorder {
    fun prefs(c: Context): SharedPreferences = c.getSharedPreferences("rec", Context.MODE_PRIVATE)
    fun enabled(c: Context) = prefs(c).getBoolean("enabled", false)
    fun setEnabled(c: Context, on: Boolean) = prefs(c).edit().putBoolean("enabled", on).apply()

    private fun has(c: Context, p: String) = ContextCompat.checkSelfPermission(c, p) == PackageManager.PERMISSION_GRANTED
    fun hasFine(c: Context) = has(c, Manifest.permission.ACCESS_FINE_LOCATION)
    fun hasBackground(c: Context) = has(c, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
    fun hasActivity(c: Context) = has(c, Manifest.permission.ACTIVITY_RECOGNITION)
    fun hasNotifications(c: Context) = android.os.Build.VERSION.SDK_INT < 33 || has(c, Manifest.permission.POST_NOTIFICATIONS)

    private fun pending(c: Context, code: Int, cls: Class<*>): PendingIntent =
        PendingIntent.getBroadcast(c, code, Intent(c, cls), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)

    /** Idempotent: safe to call whenever the app starts, the phone boots, or a permission is granted. */
    fun register(c: Context) {
        if (!enabled(c)) return
        registerActivity(c)
        registerPassive(c)
        scheduleHeartbeat(c)
    }

    @SuppressLint("MissingPermission")
    private fun registerActivity(c: Context) {
        if (!hasActivity(c)) return
        try {
            val types = intArrayOf(DetectedActivity.IN_VEHICLE, DetectedActivity.ON_BICYCLE, DetectedActivity.WALKING, DetectedActivity.RUNNING, DetectedActivity.STILL)
            val transitions = ArrayList<ActivityTransition>()
            for (t in types) {
                for (k in intArrayOf(ActivityTransition.ACTIVITY_TRANSITION_ENTER, ActivityTransition.ACTIVITY_TRANSITION_EXIT)) {
                    transitions.add(ActivityTransition.Builder().setActivityType(t).setActivityTransition(k).build())
                }
            }
            ActivityRecognition.getClient(c).requestActivityTransitionUpdates(ActivityTransitionRequest(transitions), pending(c, 1, ActivityReceiver::class.java))
        } catch (e: SecurityException) { /* permission revoked meanwhile */ }
    }

    @SuppressLint("MissingPermission")
    private fun registerPassive(c: Context) {
        if (!hasFine(c)) return
        try {
            val request = LocationRequest.Builder(Priority.PRIORITY_PASSIVE, 60_000L).setMinUpdateDistanceMeters(50f).build()
            LocationServices.getFusedLocationProviderClient(c).requestLocationUpdates(request, pending(c, 2, PassiveReceiver::class.java))
        } catch (e: SecurityException) { /* permission revoked meanwhile */ }
    }

    private fun scheduleHeartbeat(c: Context) {
        val request = PeriodicWorkRequestBuilder<HeartbeatWorker>(Policy.HEARTBEAT_MINUTES, TimeUnit.MINUTES).build()
        WorkManager.getInstance(c).enqueueUniquePeriodicWork("heartbeat", ExistingPeriodicWorkPolicy.KEEP, request)
    }

    fun stop(c: Context) {
        setEnabled(c, false)
        try { ActivityRecognition.getClient(c).removeActivityTransitionUpdates(pending(c, 1, ActivityReceiver::class.java)) } catch (e: Exception) {}
        try { LocationServices.getFusedLocationProviderClient(c).removeLocationUpdates(pending(c, 2, PassiveReceiver::class.java)) } catch (e: Exception) {}
        WorkManager.getInstance(c).cancelUniqueWork("heartbeat")
        c.stopService(Intent(c, TrackingService::class.java))
    }
}
