package app.timeline.personal

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.os.Process

/**
 * Phone use, for the "time on the phone while you were still" numbers. It reads the same screen on/off events that
 * Digital Wellbeing uses (Android's "Usage access"; Digital Wellbeing's own data cannot be read by other apps).
 * Android only keeps about a week of these events, so the app copies them into its own database each time it runs.
 * Only start and end times are kept: no app names, nothing is uploaded.
 */
object UsageSync {
    private const val SCREEN_ON = 15          // UsageEvents.Event.SCREEN_INTERACTIVE
    private const val SCREEN_OFF = 16         // UsageEvents.Event.SCREEN_NON_INTERACTIVE
    private const val BACK_DAYS = 7L

    private fun prefs(c: Context) = c.getSharedPreferences("usage", Context.MODE_PRIVATE)

    @Suppress("DEPRECATION")
    fun granted(c: Context): Boolean = try {
        val ops = c.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), c.packageName) == AppOpsManager.MODE_ALLOWED
    } catch (e: Exception) { false }

    /** When the first copy started: before this moment there is no data, so it must not be shown as "0 minutes". */
    fun since(c: Context): Long = prefs(c).getLong("since", 0L)

    @Synchronized
    fun sync(c: Context) {
        if (!granted(c)) return
        val now = System.currentTimeMillis()
        val p = prefs(c)
        val from = p.getLong("from", now - BACK_DAYS * 86_400_000L)
        val usm = c.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val evs = ArrayList<ScreenEv>()
        val events = usm.queryEvents(from, now)
        val e = UsageEvents.Event()
        while (events.hasNextEvent()) {
            events.getNextEvent(e)
            if (e.eventType == SCREEN_ON) evs.add(ScreenEv(e.timeStamp, true))
            else if (e.eventType == SCREEN_OFF) evs.add(ScreenEv(e.timeStamp, false))
        }
        val r = ScreenSessions.build(evs, now)
        Db.get(c).upsertScreen(r.sessions)
        // next time start a little before where this one stopped (a session still open now is re-read from its start)
        val ed = p.edit()
        ed.putLong("from", (r.openStart ?: r.lastEvent ?: now) - 60_000L)
        if (!p.contains("since")) ed.putLong("since", from)
        ed.apply()
    }
}
