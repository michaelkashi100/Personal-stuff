package app.timeline.personal

/** One stretch of time with the screen on (the phone in use). */
data class Session(val start: Long, val end: Long)

/** A screen on/off event from Android's usage events. */
data class ScreenEv(val t: Long, val on: Boolean)

/** What [ScreenSessions.build] found: finished sessions, plus when the screen turned on if it is still on at the end. */
data class ScreenResult(val sessions: List<Session>, val openStart: Long?, val lastEvent: Long?)

/**
 * Turns screen on/off events into "phone in use" sessions. Pure logic (no Android types) so it is unit-tested on the JVM.
 * A glance shorter than [MIN_MS] (a notification lighting the screen) is not counted as using the phone.
 */
object ScreenSessions {
    const val MIN_MS = 5_000L

    fun build(events: List<ScreenEv>, now: Long): ScreenResult {
        val out = ArrayList<Session>()
        var open: Long? = null
        var last: Long? = null
        for (e in events.sortedBy { it.t }) {
            last = e.t
            if (e.on) { if (open == null) open = e.t }
            else {
                val s = open
                if (s != null && e.t - s >= MIN_MS) out.add(Session(s, e.t))
                open = null
            }
        }
        val s = open
        if (s != null && now - s >= MIN_MS) out.add(Session(s, now))
        return ScreenResult(out, open, last)
    }

    /** JSON array of [start,end] pairs, the format the web app reads. */
    fun toJson(list: List<Session>): String {
        val sb = StringBuilder("[")
        list.forEachIndexed { i, s -> if (i > 0) sb.append(','); sb.append('[').append(s.start).append(',').append(s.end).append(']') }
        return sb.append(']').toString()
    }
}
