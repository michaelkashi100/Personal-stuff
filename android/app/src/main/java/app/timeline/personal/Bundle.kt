package app.timeline.personal

import org.json.JSONObject
import java.security.MessageDigest

/** One file of the web app, as listed in bundle.json. */
data class Entry(val path: String, val sha256: String, val size: Long)

/** The list of files that make up one version of the web app. [built] is a build time in epoch seconds: bigger = newer. */
data class Manifest(val built: Long, val files: List<Entry>)

/**
 * The rules for updating the web app over the air. No Android types, so they are unit-tested on the JVM.
 * The app only ever downloads the files named in a manifest from one fixed address, checks every file's SHA-256,
 * refuses paths that could escape the target folder, and swaps the whole folder in one step.
 */
object Bundle {
    const val MAX_FILE_BYTES = 8L * 1024 * 1024
    const val MAX_TOTAL_BYTES = 40L * 1024 * 1024
    const val MAX_FILES = 200

    private val SAFE = Regex("^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$")

    /** A relative path made of plain names: no "..", no leading slash or dot-segments, no odd characters. */
    fun safePath(path: String): Boolean = SAFE.matches(path) && !path.split('/').any { it == ".." || it == "." }

    fun parse(json: String): Manifest {
        val o = JSONObject(json)
        val arr = o.getJSONArray("files")
        val files = ArrayList<Entry>(arr.length())
        for (i in 0 until arr.length()) {
            val f = arr.getJSONObject(i)
            files.add(Entry(f.getString("path"), f.getString("sha256").lowercase(), f.getLong("size")))
        }
        return Manifest(o.getLong("built"), files)
    }

    /** null when the manifest is fine, otherwise what is wrong with it. */
    fun problem(m: Manifest): String? {
        if (m.files.isEmpty()) return "no files"
        if (m.files.size > MAX_FILES) return "too many files"
        if (m.files.none { it.path == "index.html" }) return "no index.html"
        var total = 0L
        for (e in m.files) {
            if (!safePath(e.path)) return "unsafe path: ${e.path}"
            if (e.sha256.length != 64 || !e.sha256.all { it in '0'..'9' || it in 'a'..'f' }) return "bad hash for ${e.path}"
            if (e.size < 0 || e.size > MAX_FILE_BYTES) return "bad size for ${e.path}"
            total += e.size
        }
        if (total > MAX_TOTAL_BYTES) return "too big"
        if (m.files.map { it.path }.toSet().size != m.files.size) return "duplicate paths"
        return null
    }

    fun isNewer(remoteBuilt: Long, localBuilt: Long) = remoteBuilt > localBuilt

    fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /** "Timeline for Android (build 12)" -> 12 */
    fun parseBuild(releaseName: String): Int? = Regex("build\\s+(\\d+)").find(releaseName)?.groupValues?.get(1)?.toIntOrNull()
}
