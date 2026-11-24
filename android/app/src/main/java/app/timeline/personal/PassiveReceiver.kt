package app.timeline.personal

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.location.Location
import android.location.LocationManager
import android.os.Build

/** Keeps, at no cost, the locations other apps (maps, weather...) already asked Android for. */
@Suppress("DEPRECATION")
class PassiveReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (!Recorder.enabled(context)) return
        val list = ArrayList<Location>()
        if (Build.VERSION.SDK_INT >= 31) intent.getParcelableArrayListExtra<Location>(LocationManager.KEY_LOCATIONS)?.let { list.addAll(it) }
        if (list.isEmpty()) (intent.getParcelableExtra<Location>(LocationManager.KEY_LOCATION_CHANGED))?.let { list.add(it) }
        if (list.isEmpty()) return
        val prefs = Recorder.prefs(context)
        var last = prefs.getLong("lastPassive", 0L)
        val out = ArrayList<Fix>()
        for (l in list) {
            if (!Policy.accept(l.accuracy) || l.time - last < Policy.PASSIVE_MIN_GAP_MS) continue
            last = l.time
            out.add(Fix(l.time, l.latitude, l.longitude, l.accuracy, if (l.hasSpeed()) l.speed else -1f, 2,
                if (l.hasAltitude()) l.altitude else null, if (l.hasVerticalAccuracy()) l.verticalAccuracyMeters else null, l.provider))
        }
        if (out.isEmpty()) return
        Db.get(context).insertFixes(out)
        // a free fix far from the last one means you are on the move: let the recorder start GPS
        val pl = prefs.getFloat("passiveLat", Float.NaN); val pg = prefs.getFloat("passiveLng", Float.NaN); val f = out.last()
        if (!pl.isNaN() && Policy.shouldStartGps(0, false, Policy.distanceM(pl.toDouble(), pg.toDouble(), f.lat, f.lng))) TrackingService.ensure(context, moved = true)
        prefs.edit().putLong("lastPassive", last).putFloat("passiveLat", f.lat.toFloat()).putFloat("passiveLng", f.lng.toFloat()).apply()
    }
}
