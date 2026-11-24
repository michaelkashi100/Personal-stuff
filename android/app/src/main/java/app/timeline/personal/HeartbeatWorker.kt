package app.timeline.personal

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.CancellationSignal
import androidx.core.content.ContextCompat
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Once an hour: one position for the time you stand still. A recent free position (one another app caused) is used if
 * there is one; otherwise GPS is tried for up to 25 seconds (nothing is asked of Google's location service). Each run
 * also restarts the recorder if Android stopped it, and deletes signal details that are no longer needed.
 */
class HeartbeatWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    @SuppressLint("MissingPermission")
    override fun doWork(): Result {
        val c = applicationContext
        try { UsageSync.sync(c) } catch (e: Exception) { /* usage access not granted or unavailable */ }
        try { Db.get(c).pruneSignals(System.currentTimeMillis() - Policy.SIGNAL_KEEP_MS) } catch (e: Exception) {}
        if (!Recorder.enabled(c)) return Result.success()
        Recorder.register(c)
        if (!Recorder.hasFine(c)) return Result.success()
        val lm = c.getSystemService(LocationManager::class.java)
        var loc: Location? = try { lm.getLastKnownLocation(LocationManager.PASSIVE_PROVIDER) } catch (e: Exception) { null }
        if (loc == null || System.currentTimeMillis() - loc.time > 15 * 60_000L) {
            loc = null
            if (Build.VERSION.SDK_INT >= 30) try {
                val latch = CountDownLatch(1); var got: Location? = null; val cancel = CancellationSignal()
                lm.getCurrentLocation(LocationManager.GPS_PROVIDER, cancel, ContextCompat.getMainExecutor(c)) { l -> got = l; latch.countDown() }
                if (!latch.await(25, TimeUnit.SECONDS)) cancel.cancel()
                loc = got
            } catch (e: Exception) { /* no GPS indoors: try again next hour */ }
        }
        val l = loc ?: return Result.success()
        if (Policy.accept(l.accuracy)) {
            Db.get(c).insertFixes(listOf(Fix(l.time, l.latitude, l.longitude, l.accuracy, if (l.hasSpeed()) l.speed else -1f, 3,
                if (l.hasAltitude()) l.altitude else null, if (l.hasVerticalAccuracy()) l.verticalAccuracyMeters else null, l.provider)))
        }
        return Result.success()
    }
}
