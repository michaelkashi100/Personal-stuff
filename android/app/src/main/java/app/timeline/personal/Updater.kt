package app.timeline.personal

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.DigestInputStream
import java.security.MessageDigest

/**
 * Keeps the app current without reinstalling it.
 *
 *  - The screens and the analysis (the web app) are fetched from the project's own site when a newer build exists.
 *    Every file is checked against the SHA-256 in bundle.json and the whole folder is swapped in one step, so a
 *    broken download can never leave a half-updated app. Without a network the app keeps using what it has.
 *  - The recorder itself (this APK) cannot be swapped silently by Android. When a newer one exists, the Update
 *    button downloads it and hands it to Android's installer, which asks for one confirmation.
 *
 * The only network traffic is to the two addresses below and never carries any of your data.
 */
object Updater {
    const val SITE = "https://michaelkashi100.github.io/Personal-stuff/"
    private const val RELEASE_API = "https://api.github.com/repos/michaelkashi100/Personal-stuff/releases/tags/android-latest"
    private const val APK_URL = "https://github.com/michaelkashi100/Personal-stuff/releases/download/android-latest/timeline.apk"
    private const val CHECK_EVERY_MS = 2 * 60_000L   // one tiny request (bundle.json); a newer build shows up the next time you open the app

    @Volatile var checking = false
    @Volatile var installing = false
    @Volatile var latestBuild = 0
    @Volatile var message = ""

    private fun prefs(c: Context) = c.getSharedPreferences("update", Context.MODE_PRIVATE)
    fun auto(c: Context) = prefs(c).getBoolean("auto", true)
    fun setAuto(c: Context, on: Boolean) = prefs(c).edit().putBoolean("auto", on).apply()

    fun installedBuild(c: Context): Int = c.packageManager.getPackageInfo(c.packageName, 0).longVersionCode.toInt()

    private fun open(url: String): HttpURLConnection {
        val u = URL(url)
        require(u.protocol == "https") { "https only" }
        val con = u.openConnection() as HttpURLConnection
        con.connectTimeout = 10_000
        con.readTimeout = 20_000
        con.useCaches = false
        con.instanceFollowRedirects = true
        con.setRequestProperty("Cache-Control", "no-cache")
        con.setRequestProperty("User-Agent", "TimelineApp")
        return con
    }

    private fun getText(url: String, accept: String? = null): String {
        val con = open(url)
        if (accept != null) con.setRequestProperty("Accept", accept)
        if (con.responseCode != 200) throw IllegalStateException("HTTP ${con.responseCode}")
        return con.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
    }

    /** Checks both kinds of update. [force] is a tap on "Check now"; otherwise it only runs when automatic updates are on and it has been a while. */
    fun checkAll(a: MainActivity, force: Boolean) {
        if (checking || installing) return
        if (!force && (!auto(a) || System.currentTimeMillis() - prefs(a).getLong("last", 0L) < CHECK_EVERY_MS)) return
        checking = true
        if (force) message = ""
        a.notifyWeb()
        Thread {
            try {
                val web = WebBundle.update(a)
                try { latestBuild = Bundle.parseBuild(JSONObject(getText(RELEASE_API, "application/vnd.github+json")).optString("name")) ?: latestBuild } catch (e: Exception) { /* offline: keep what we knew */ }
                if (web !is WebBundle.Outcome.Failed) prefs(a).edit().putLong("last", System.currentTimeMillis()).apply()   // a failed check is retried at the next open
                when (web) {
                    is WebBundle.Outcome.Updated -> { message = "Updated the app's screens."; a.onWebUpdated() }
                    is WebBundle.Outcome.UpToDate -> if (force) message = if (latestBuild > installedBuild(a)) "A new version of the recorder is ready." else "Everything is up to date."
                    is WebBundle.Outcome.Failed -> if (force) message = "Could not check for updates: ${web.why}"
                }
            } finally {
                checking = false
                a.notifyWeb()
            }
        }.start()
    }

    /** Downloads the new APK and hands it to Android's installer (one confirmation from you). */
    fun installApk(a: MainActivity) {
        if (installing) return
        if (!a.packageManager.canRequestPackageInstalls()) {
            message = "Allow Timeline to install updates in the page that just opened, go back, then tap Update again."
            a.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${a.packageName}")))
            a.notifyWeb()
            return
        }
        installing = true
        message = "Downloading the update…"
        a.notifyWeb()
        Thread {
            try {
                val apk = File(a.cacheDir, "update.apk")
                val con = open(APK_URL)
                if (con.responseCode != 200) throw IllegalStateException("HTTP ${con.responseCode}")
                con.inputStream.use { input -> apk.outputStream().use { out -> input.copyTo(out) } }
                if (apk.length() < 1_000_000L || apk.length() > 80L * 1024 * 1024) throw IllegalStateException("unexpected file size")
                message = "Ready. Confirm the update when Android asks."
                a.notifyWeb()
                commit(a, apk)
            } catch (e: Exception) {
                installing = false
                message = "Could not download the update: ${e.message}"
                a.notifyWeb()
            }
        }.start()
    }

    private fun commit(c: Context, apk: File) {
        val installer = c.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            apk.inputStream().use { input -> session.openWrite("timeline.apk", 0, apk.length()).use { out -> input.copyTo(out); session.fsync(out) } }
            val intent = Intent(c, InstallReceiver::class.java).setPackage(c.packageName)
            val pending = PendingIntent.getBroadcast(c, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
            session.commit(pending.intentSender)
        }
    }
}

/** The web app, stored in the app's private folder once a newer build has been downloaded. */
object WebBundle {
    sealed class Outcome {
        object UpToDate : Outcome()
        data class Updated(val built: Long) : Outcome()
        data class Failed(val why: String) : Outcome()
    }

    private fun live(c: Context) = File(c.filesDir, "www")

    fun bundledBuilt(c: Context): Long = try {
        c.assets.open("www/bundle.json").use { Bundle.parse(it.readBytes().toString(Charsets.UTF_8)).built }
    } catch (e: Exception) { 0L }

    private fun downloadedBuilt(c: Context): Long = try {
        val f = File(live(c), "bundle.json")
        if (f.exists() && File(live(c), "index.html").exists()) Bundle.parse(f.readText()).built else 0L
    } catch (e: Exception) { 0L }

    /** The folder to serve the web app from, or null to serve the copy that came with the APK (also deletes a downloaded copy the APK has overtaken). */
    fun serveDir(c: Context): File? {
        if (downloadedBuilt(c) > bundledBuilt(c)) return live(c)
        if (live(c).exists()) live(c).deleteRecursively()
        return null
    }

    fun servingBuilt(c: Context): Long = maxOf(bundledBuilt(c), downloadedBuilt(c))

    fun update(c: Context): Outcome {
        return try {
            // a unique address each time: GitHub's servers keep copies for 10 minutes, so a plain request can get an old list
            val con = URL(Updater.SITE + "bundle.json?t=" + System.currentTimeMillis()).openConnection() as HttpURLConnection
            con.connectTimeout = 10_000; con.readTimeout = 20_000; con.useCaches = false
            con.setRequestProperty("Cache-Control", "no-cache"); con.setRequestProperty("User-Agent", "TimelineApp")
            if (con.responseCode != 200) return Outcome.Failed("HTTP ${con.responseCode}")
            val text = con.inputStream.use { it.readBytes() }.toString(Charsets.UTF_8)
            val remote = Bundle.parse(text)
            Bundle.problem(remote)?.let { return Outcome.Failed(it) }
            if (!Bundle.isNewer(remote.built, servingBuilt(c))) return Outcome.UpToDate

            val staging = File(c.filesDir, "www_new")
            staging.deleteRecursively(); staging.mkdirs()
            for (e in remote.files) {
                val dest = File(staging, e.path)
                dest.parentFile?.mkdirs()
                fetch(Updater.SITE + e.path + "?b=" + remote.built, dest, e)   // this build's copy, never an older cached one
            }
            File(staging, "bundle.json").writeText(text)

            val old = File(c.filesDir, "www_old")
            old.deleteRecursively()
            if (live(c).exists() && !live(c).renameTo(old)) return Outcome.Failed("could not replace the old copy")
            if (!staging.renameTo(live(c))) { old.renameTo(live(c)); return Outcome.Failed("could not install the new copy") }
            old.deleteRecursively()
            Outcome.Updated(remote.built)
        } catch (e: Exception) {
            Outcome.Failed(e.message ?: e.javaClass.simpleName)
        }
    }

    private fun fetch(url: String, dest: File, entry: Entry) {
        val con = URL(url).openConnection() as HttpURLConnection
        con.connectTimeout = 10_000; con.readTimeout = 20_000; con.useCaches = false
        con.setRequestProperty("User-Agent", "TimelineApp")
        if (con.responseCode != 200) throw IllegalStateException("HTTP ${con.responseCode} for ${entry.path}")
        val digest = MessageDigest.getInstance("SHA-256")
        var total = 0L
        DigestInputStream(con.inputStream, digest).use { input ->
            dest.outputStream().use { out ->
                val buf = ByteArray(16 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    total += n
                    if (total > Bundle.MAX_FILE_BYTES) throw IllegalStateException("${entry.path} is too big")
                    out.write(buf, 0, n)
                }
            }
        }
        val hex = digest.digest().joinToString("") { "%02x".format(it) }
        if (total != entry.size || hex != entry.sha256) throw IllegalStateException("${entry.path} did not match its checksum")
    }
}
