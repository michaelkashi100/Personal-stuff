package app.timeline.personal

import android.annotation.SuppressLint
import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.google.android.gms.location.CurrentLocationRequest
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import com.google.android.gms.tasks.Tasks
import java.util.concurrent.TimeUnit

/**
 * Once an hour, one coarse location (Wi-Fi / cell, a few seconds). It is the evidence for the time you stand still,
 * and each run also re-registers the other sources in case Android dropped them.
 */
class HeartbeatWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    @SuppressLint("MissingPermission")
    override fun doWork(): Result {
        val c = applicationContext
        if (!Recorder.enabled(c)) return Result.success()
        Recorder.register(c)
        if (!Recorder.hasFine(c) || TrackingService.running) return Result.success()
        try {
            val request = CurrentLocationRequest.Builder()
                .setPriority(Priority.PRIORITY_BALANCED_POWER_ACCURACY)
                .setDurationMillis(20_000L)
                .setMaxUpdateAgeMillis(10 * 60_000L)
                .build()
            val loc = Tasks.await(LocationServices.getFusedLocationProviderClient(c).getCurrentLocation(request, CancellationTokenSource().token), 25, TimeUnit.SECONDS)
            if (loc != null && Policy.accept(loc.accuracy)) {
                Db.get(c).insertFixes(listOf(Fix(loc.time, loc.latitude, loc.longitude, loc.accuracy, if (loc.hasSpeed()) loc.speed else -1f, 3)))
            }
        } catch (e: Exception) { /* no fix this time; try again next hour */ }
        return Result.success()
    }
}
