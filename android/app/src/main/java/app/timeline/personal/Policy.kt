package app.timeline.personal

import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

enum class Mode { DRIVE, BIKE, WALK }

data class Params(val intervalMs: Long, val minDistanceM: Float, val maxDelayMs: Long)

/**
 * Everything that decides how much battery recording uses. No Android types here, so it is unit-tested on the JVM.
 *
 * The idea (the same one Google uses): while you are still nothing runs at all. Android's activity recognition
 * (a low-power sensor service) wakes the app when you start moving; GPS is then used in batches, and it is switched
 * off a few minutes after you stop.
 */
object Policy {
    /** Keep recording this long after "still" is reported, to capture the arrival. */
    const val STOP_AFTER_STILL_MS = 3 * 60_000L
    /** Safety net: stop if there has been no movement at all for this long, even if "still" was never reported. */
    const val MAX_IDLE_MS = 10 * 60_000L
    /** A fix this far from the previous one counts as movement. */
    const val MOVE_THRESHOLD_M = 25.0
    /** Fixes less accurate than this are noise. */
    const val MAX_ACCURACY_M = 200f
    /** While still, one coarse check-in this often (a few seconds of cheap Wi-Fi/cell location). */
    const val HEARTBEAT_MINUTES = 60L
    /** Free fixes that other apps cause are kept, but at most one per this interval. */
    const val PASSIVE_MIN_GAP_MS = 10_000L

    // DetectedActivity codes
    const val IN_VEHICLE = 0
    const val ON_BICYCLE = 1
    const val ON_FOOT = 2
    const val STILL = 3
    const val WALKING = 7
    const val RUNNING = 8

    /** GPS is batched: fixes are delivered together, so the CPU wakes up once per [Params.maxDelayMs] instead of once per fix. */
    fun paramsFor(mode: Mode): Params = when (mode) {
        Mode.DRIVE -> Params(5_000L, 10f, 40_000L)
        Mode.BIKE -> Params(5_000L, 8f, 40_000L)
        Mode.WALK -> Params(10_000L, 8f, 60_000L)
    }

    fun modeFor(activityType: Int): Mode? = when (activityType) {
        IN_VEHICLE -> Mode.DRIVE
        ON_BICYCLE -> Mode.BIKE
        ON_FOOT, WALKING, RUNNING -> Mode.WALK
        else -> null
    }

    fun isStill(activityType: Int) = activityType == STILL

    fun accept(accuracyM: Float) = accuracyM <= MAX_ACCURACY_M

    fun moved(distanceM: Double) = distanceM >= MOVE_THRESHOLD_M

    fun idleTooLong(nowMs: Long, lastMoveAtMs: Long) = nowMs - lastMoveAtMs > MAX_IDLE_MS

    fun distanceM(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
        val r = Math.PI / 180.0
        val dLat = (lat2 - lat1) * r
        val dLng = (lng2 - lng1) * r
        val h = sin(dLat / 2) * sin(dLat / 2) + cos(lat1 * r) * cos(lat2 * r) * sin(dLng / 2) * sin(dLng / 2)
        return 12_742_000.0 * asin(sqrt(h))
    }
}
