package app.timeline.personal

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionResult

/** Android tells us when you start or stop walking, cycling or driving. This is what keeps GPS off while you are still. */
class ActivityReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (!Recorder.enabled(context) || !ActivityTransitionResult.hasResult(intent)) return
        val result = ActivityTransitionResult.extractResult(intent) ?: return
        val db = Db.get(context)
        val now = System.currentTimeMillis()
        val bootNow = SystemClock.elapsedRealtime()
        for (e in result.transitionEvents) {
            val eventAgoMs = bootNow - e.elapsedRealTimeNanos / 1_000_000L
            db.insertAct(Act(now - eventAgoMs, e.activityType, e.transitionType == ActivityTransition.ACTIVITY_TRANSITION_ENTER))
        }
        val last = result.transitionEvents.lastOrNull() ?: return
        val enter = last.transitionType == ActivityTransition.ACTIVITY_TRANSITION_ENTER
        val mode = Policy.modeFor(last.activityType)
        when {
            enter && Policy.isStill(last.activityType) -> TrackingService.still(context)
            enter && mode != null -> TrackingService.start(context, mode)
            !enter && Policy.isStill(last.activityType) -> TrackingService.start(context, Mode.WALK) // started moving; the kind of movement follows
        }
    }
}
