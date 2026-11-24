package app.timeline.personal

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.location.LocationManager
import androidx.core.content.ContextCompat
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * Switches recording on and off. Three cheap sources feed the database, none of them a Google service:
 *  - the recorder ([TrackingService]) waits on the phone's motion chips and runs GPS only while you move,
 *  - passive location keeps, for free, positions other apps already asked Android for,
 *  - an hourly check-in covers the time you stand still (a recent free position, or a short GPS try).
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

    private fun passiveIntent(c: Context): PendingIntent =
        PendingIntent.getBroadcast(c, 2, Intent(c, PassiveReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)

    /** Idempotent: safe to call whenever the app starts, the phone boots, or a permission is granted. */
    fun register(c: Context) {
        if (!enabled(c) || !hasFine(c)) return
        TrackingService.ensure(c)
        registerPassive(c)
        scheduleHeartbeat(c)
    }

    @SuppressLint("MissingPermission")
    private fun registerPassive(c: Context) {
        try {
            c.getSystemService(LocationManager::class.java).requestLocationUpdates(LocationManager.PASSIVE_PROVIDER, 60_000L, 50f, passiveIntent(c))
        } catch (e: Exception) { /* permission revoked meanwhile */ }
    }

    private fun scheduleHeartbeat(c: Context) {
        val request = PeriodicWorkRequestBuilder<HeartbeatWorker>(Policy.HEARTBEAT_MINUTES, TimeUnit.MINUTES).build()
        WorkManager.getInstance(c).enqueueUniquePeriodicWork("heartbeat", ExistingPeriodicWorkPolicy.KEEP, request)
    }

    /** One check-in right away, so the first recording does not wait an hour. */
    fun checkInNow(c: Context) {
        if (enabled(c)) WorkManager.getInstance(c).enqueue(OneTimeWorkRequestBuilder<HeartbeatWorker>().build())
    }

    fun stop(c: Context) {
        setEnabled(c, false)
        try { c.getSystemService(LocationManager::class.java).removeUpdates(passiveIntent(c)) } catch (e: Exception) {}
        WorkManager.getInstance(c).cancelUniqueWork("heartbeat")
        c.stopService(Intent(c, TrackingService::class.java))
    }
}
