package app.timeline.personal

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.google.android.gms.location.LocationResult

/** Keeps, at no cost, the locations other apps (maps, weather...) already asked Android for. */
class PassiveReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (!Recorder.enabled(context) || !LocationResult.hasResult(intent)) return
        val result = LocationResult.extractResult(intent) ?: return
        val prefs = Recorder.prefs(context)
        var last = prefs.getLong("lastPassive", 0L)
        val out = ArrayList<Fix>()
        for (l in result.locations) {
            if (!Policy.accept(l.accuracy) || l.time - last < Policy.PASSIVE_MIN_GAP_MS) continue
            last = l.time
            out.add(Fix(l.time, l.latitude, l.longitude, l.accuracy, if (l.hasSpeed()) l.speed else -1f, 2))
        }
        if (out.isNotEmpty()) {
            Db.get(context).insertFixes(out)
            prefs.edit().putLong("lastPassive", last).apply()
        }
    }
}
