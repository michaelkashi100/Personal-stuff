package app.timeline.personal

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Android forgets activity registrations when the phone restarts or the app is updated; put them back. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (Recorder.enabled(context)) Recorder.register(context)
    }
}
