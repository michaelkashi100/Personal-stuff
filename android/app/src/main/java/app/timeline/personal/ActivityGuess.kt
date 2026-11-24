package app.timeline.personal

/**
 * The app's own guess of what you are doing, from the phone's own sensors only (no Google service):
 * the step counter (a low-power chip that counts steps), the GPS speed while GPS is on, and how much the phone shakes.
 *
 *  - steps at a walking rhythm            -> walking (running above ~140 steps a minute and > 2.2 m/s)
 *  - no steps, slow                       -> still (or walking with the phone lying still, if it moves slowly)
 *  - no steps, 2.5-8 m/s, rhythmic shaking -> cycling
 *  - no steps, faster or smooth           -> in a vehicle
 */
object ActivityGuess {
    /** One minute (or so) of evidence. Unknown values are negative. */
    data class Window(val steps: Int, val seconds: Double, val speed: Double, val shake: Double)

    fun classify(w: Window): Int? {
        val perMin = if (w.seconds > 0) w.steps * 60.0 / w.seconds else 0.0
        if (perMin >= 140 && (w.speed < 0 || w.speed > 2.2)) return Policy.RUNNING
        if (perMin >= 40 && (w.speed < 0 || w.speed < 3.5)) return Policy.WALKING
        if (w.speed < 0) return if (perMin < 5) Policy.STILL else null
        if (w.speed < 0.6) return Policy.STILL
        if (w.speed < 2.5) return Policy.WALKING                 // moving at walking pace with the phone still in a bag
        if (w.speed < 8.0) return if (w.shake >= 0 && w.shake < 0.6) Policy.IN_VEHICLE else Policy.ON_BICYCLE
        return Policy.IN_VEHICLE
    }

    /** Standard deviation of acceleration magnitude (m/s2): bikes shake, cars glide. */
    fun shake(magnitudes: FloatArray, n: Int): Double {
        if (n < 10) return -1.0
        var s = 0.0; var s2 = 0.0
        for (i in 0 until n) { s += magnitudes[i]; s2 += magnitudes[i].toDouble() * magnitudes[i] }
        val mean = s / n
        return Math.sqrt(Math.max(0.0, s2 / n - mean * mean))
    }
}
