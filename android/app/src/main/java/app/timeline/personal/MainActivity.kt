package app.timeline.personal

import android.Manifest
import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.provider.Settings
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.webkit.WebViewAssetLoader
import java.io.BufferedWriter
import java.io.OutputStreamWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Hosts the Timeline web app (bundled in the APK, so it works offline) and gives it a small bridge,
 * [Bridge], to the recorder. The web page decides what to show; this class only owns what a page cannot do:
 * permissions, background recording, files and the screen.
 */
class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val asked = HashSet<String>()

    private val pickFiles = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        fileCallback?.onReceiveValue(uris.toTypedArray())
        fileCallback = null
    }
    private val askLocation = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { nextStep() }
    private val askOne = registerForActivityResult(ActivityResultContracts.RequestPermission()) { nextStep() }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        web = WebView(this).apply {
            setBackgroundColor(0xFF080D18.toInt())
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            addJavascriptInterface(Bridge(this@MainActivity), "TLNative")
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    loader.shouldInterceptRequest(request.url)

                // Only our own pages may run here (they can reach the bridge); anything else opens in the browser.
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (request.url.host == WebViewAssetLoader.DEFAULT_DOMAIN) return false
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                    return true
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                    fileCallback?.onReceiveValue(null)
                    fileCallback = callback
                    pickFiles.launch(arrayOf("*/*"))
                    return true
                }
            }
        }
        setContentView(web)
        web.loadUrl("https://${WebViewAssetLoader.DEFAULT_DOMAIN}/assets/www/index.html")
    }

    override fun onResume() {
        super.onResume()
        Recorder.register(this)   // picks up permissions granted in Settings, and re-registers after an update
        notifyWeb()
    }

    /** Tell the page that something changed (it re-reads the status and any new recordings). */
    fun notifyWeb() {
        web.post { web.evaluateJavascript("window.__tlNativeChanged&&window.__tlNativeChanged()", null) }
    }

    // ---- permissions: one step at a time, in the order Android requires ----
    fun startSetup() {
        Recorder.setEnabled(this, true)
        asked.clear()
        nextStep()
    }

    private fun nextStep() {
        when {
            !Recorder.hasFine(this) && asked.add("fine") ->
                askLocation.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
            Recorder.hasFine(this) && !Recorder.hasBackground(this) && asked.add("background") ->
                askOne.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
            !Recorder.hasActivity(this) && asked.add("activity") ->
                askOne.launch(Manifest.permission.ACTIVITY_RECOGNITION)
            Build.VERSION.SDK_INT >= 33 && !Recorder.hasNotifications(this) && asked.add("notifications") ->
                askOne.launch(Manifest.permission.POST_NOTIFICATIONS)
            else -> {
                Recorder.register(this)
                notifyWeb()
            }
        }
    }

    // ---- what the bridge needs ----
    fun statusJson(): String {
        val s = Db.get(this).stats()
        return "{\"native\":true,\"recording\":${Recorder.enabled(this)},\"fine\":${Recorder.hasFine(this)}," +
            "\"bg\":${Recorder.hasBackground(this)},\"activity\":${Recorder.hasActivity(this)}," +
            "\"notifications\":${Recorder.hasNotifications(this)},\"fixes\":${s.count},\"first\":${s.first},\"last\":${s.last}}"
    }

    fun recordsJson(since: Long): String {
        val db = Db.get(this)
        val out = StringBuilder()
        RecordsJson.write(out, db.fixes(since), db.acts(since), System.currentTimeMillis())
        return out.toString()
    }

    fun exportBackup(): String {
        return try {
            val name = "timeline-recorded-" + SimpleDateFormat("yyyyMMdd-HHmm", Locale.US).format(Date()) + ".json"
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, "application/json")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: return "{\"ok\":false,\"error\":\"could not create the file\"}"
            val stream = contentResolver.openOutputStream(uri) ?: return "{\"ok\":false,\"error\":\"could not open the file\"}"
            BufferedWriter(OutputStreamWriter(stream, Charsets.UTF_8)).use { w ->
                val db = Db.get(this)
                RecordsJson.write(w, db.fixes(0), db.acts(0), System.currentTimeMillis())
            }
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            contentResolver.update(uri, values, null, null)
            "{\"ok\":true,\"name\":\"$name\"}"
        } catch (e: Exception) {
            "{\"ok\":false,\"error\":\"" + (e.message ?: "error").replace(Regex("[\"\\\\\\n\\r]"), " ") + "\"}"
        }
    }

    fun setKeepScreenOn(on: Boolean) {
        runOnUiThread {
            if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    fun openSettings(kind: String) {
        runOnUiThread {
            val intent = if (kind == "battery") Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
            try { startActivity(intent) } catch (e: Exception) { /* no such settings page on this phone */ }
        }
    }
}

/** The only door from the web page to the phone. It exists only for pages served from the app itself. */
class Bridge(private val activity: MainActivity) {
    @JavascriptInterface fun status(): String = activity.statusJson()

    @JavascriptInterface fun recordsJson(since: Long): String = activity.recordsJson(since)

    @JavascriptInterface fun setRecording(on: Boolean) {
        activity.runOnUiThread {
            if (on) activity.startSetup()
            else { Recorder.stop(activity); activity.notifyWeb() }
        }
    }

    @JavascriptInterface fun keepScreenOn(on: Boolean) = activity.setKeepScreenOn(on)

    @JavascriptInterface fun openSettings(kind: String) = activity.openSettings(kind)

    @JavascriptInterface fun exportBackup(): String = activity.exportBackup()

    @JavascriptInterface fun clearRecorded() {
        Db.get(activity).clear()
    }
}
