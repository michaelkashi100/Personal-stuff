package app.timeline.personal

import java.time.Instant
import java.util.Locale

/**
 * The recorded data as Google's on-device Timeline `rawSignals` format, which the web app already understands:
 * positions (with accuracy and speed) and activity records. The activity transitions Android reports (one event when
 * an activity starts, one when it ends) are expanded into one record per minute so they cover the whole stretch.
 */
object RecordsJson {
    fun typeName(type: Int): String? = when (type) {
        Policy.IN_VEHICLE -> "IN_VEHICLE"
        Policy.ON_BICYCLE -> "ON_BICYCLE"
        Policy.ON_FOOT -> "ON_FOOT"
        Policy.WALKING -> "WALKING"
        Policy.RUNNING -> "RUNNING"
        else -> null
    }

    /** One (time, type) record per [stepMs] for every interval in which a moving activity was active. */
    fun activityRecords(acts: List<Act>, nowMs: Long, stepMs: Long = 60_000L, maxMs: Long = 6 * 3_600_000L): List<Pair<Long, String>> {
        val out = ArrayList<Pair<Long, String>>()
        var cur: Int? = null
        var start = 0L
        fun close(end: Long) {
            val name = cur?.let { typeName(it) } ?: return
            var t = start
            while (t <= end) { out.add(t to name); t += stepMs }
        }
        for (a in acts.sortedBy { it.t }) {
            if (a.enter) {
                if (cur != null && cur != a.type) close(a.t)
                cur = if (Policy.isStill(a.type) || typeName(a.type) == null) null else a.type
                start = a.t
            } else if (cur == a.type) {
                close(a.t)
                cur = null
            }
        }
        if (cur != null) close(minOf(nowMs, start + maxMs))
        return out
    }

    fun write(out: Appendable, fixes: Sequence<Fix>, acts: List<Act>, nowMs: Long) {
        out.append("{\"rawSignals\":[")
        var first = true
        for (f in fixes) {
            if (!first) out.append(',')
            first = false
            out.append("{\"position\":{\"LatLng\":\"")
                .append(String.format(Locale.US, "%.6f°, %.6f°", f.lat, f.lng))
                .append("\",\"accuracyMeters\":").append(String.format(Locale.US, "%.1f", f.acc))
                .append(",\"timestamp\":\"").append(Instant.ofEpochMilli(f.t).toString()).append('"')
            if (f.spd >= 0f) out.append(",\"speedMetersPerSecond\":").append(String.format(Locale.US, "%.2f", f.spd))
            out.append("}}")
        }
        for ((t, type) in activityRecords(acts, nowMs)) {
            if (!first) out.append(',')
            first = false
            out.append("{\"activityRecord\":{\"probableActivities\":[{\"type\":\"").append(type)
                .append("\",\"confidence\":0.8}],\"timestamp\":\"").append(Instant.ofEpochMilli(t).toString()).append("\"}}")
        }
        out.append("]}")
    }

    fun build(fixes: Sequence<Fix>, acts: List<Act>, nowMs: Long): String =
        StringBuilder().also { write(it, fixes, acts, nowMs) }.toString()
}
