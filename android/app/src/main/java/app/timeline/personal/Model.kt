package app.timeline.personal

/** One recorded location. [src]: 1 = recorded while moving, 2 = passive (free, from other apps), 3 = hourly check-in. [spd] is -1 when unknown. */
data class Fix(val t: Long, val lat: Double, val lng: Double, val acc: Float, val spd: Float, val src: Int)

/** An activity transition reported by Android's activity recognition (type uses DetectedActivity codes). */
data class Act(val t: Long, val type: Int, val enter: Boolean)
