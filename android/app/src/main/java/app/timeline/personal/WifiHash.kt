package app.timeline.personal

import java.security.MessageDigest

/**
 * A scrambled code for a Wi-Fi network: the same network always gives the same code on this phone, but the code
 * cannot be turned back into the network's name or address (a salted hash, the salt never leaves the app).
 */
object WifiHash {
    fun of(bssid: String?, salt: String): String? {
        val b = bssid?.lowercase()?.trim() ?: return null
        if (b.isEmpty() || b == "02:00:00:00:00:00" || b == "00:00:00:00:00:00") return null   // Android's "unknown"
        val d = MessageDigest.getInstance("SHA-256").digest((salt + "|" + b).toByteArray())
        return d.take(8).joinToString("") { "%02x".format(it) }
    }
}
