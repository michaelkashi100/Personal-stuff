package app.timeline.personal

/**
 * One recorded location. [src]: 1 = recorded while moving, 2 = passive (free, from other apps), 3 = hourly check-in.
 * [spd] is -1 when unknown. The rest are signal details used only by the GPS cleaning, and deleted after a few days:
 * altitude and its accuracy, the Android location provider, satellites used, signal strength of the 4 strongest
 * satellites (dB-Hz), Wi-Fi networks in range, and a scrambled code of the connected Wi-Fi network (never its name).
 */
data class Fix(
    val t: Long, val lat: Double, val lng: Double, val acc: Float, val spd: Float, val src: Int,
    val alt: Double? = null, val vacc: Float? = null, val prov: String? = null,
    val sat: Int? = null, val cn0: Float? = null, val wifiN: Int? = null, val wifiH: String? = null,
) {
    val hasSignal get() = alt != null || vacc != null || prov != null || sat != null || cn0 != null || wifiN != null || wifiH != null
}

/** An activity change (type uses Android's DetectedActivity codes, see [Policy]): written by the app's own guess. */
data class Act(val t: Long, val type: Int, val enter: Boolean)
