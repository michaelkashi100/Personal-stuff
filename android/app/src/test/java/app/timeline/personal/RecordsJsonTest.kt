package app.timeline.personal

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class RecordsJsonTest {
    private val t0 = 1_781_000_000_000L
    private fun fix(i: Int, spd: Float = 1.5f) = Fix(t0 + i * 5_000L, 32.0853 + i * 0.0001, 34.7818 + i * 0.0001, 8.5f, spd, 1)

    @Test fun producesValidJsonInGoogleRawSignalsShape() {
        val json = RecordsJson.build((0 until 3).map { fix(it) }.asSequence(), emptyList(), t0)
        val arr = JSONObject(json).getJSONArray("rawSignals")
        assertEquals(3, arr.length())
        val p = arr.getJSONObject(0).getJSONObject("position")
        assertEquals("32.085300°, 34.781800°", p.getString("LatLng"))
        assertEquals(8.5, p.getDouble("accuracyMeters"), 1e-9)
        assertEquals(1.5, p.getDouble("speedMetersPerSecond"), 1e-9)
        assertTrue(p.getString("timestamp").endsWith("Z"))
    }

    @Test fun writesSignalDetailsWhenKnown() {
        val f = fix(0).copy(alt = 41.5, vacc = 3f, prov = "network", sat = 7, cn0 = 31.5f, wifiN = 14, wifiH = "0a1b2c3d4e5f6a7b")
        val p = JSONObject(RecordsJson.build(sequenceOf(f), emptyList(), t0)).getJSONArray("rawSignals").getJSONObject(0).getJSONObject("position")
        assertEquals(41.5, p.getDouble("altitudeMeters"), 1e-9); assertEquals(3.0, p.getDouble("verticalAccuracyMeters"), 1e-9)
        assertEquals("WIFI", p.getString("source")); assertEquals(7, p.getInt("sat")); assertEquals(31.5, p.getDouble("cn0"), 1e-9)
        assertEquals(14, p.getInt("wifiN")); assertEquals("0a1b2c3d4e5f6a7b", p.getString("wifiH"))
        assertTrue(!JSONObject(RecordsJson.build(sequenceOf(fix(0)), emptyList(), t0)).getJSONArray("rawSignals").getJSONObject(0).getJSONObject("position").has("altitudeMeters"))
    }

    @Test fun neverWritesAnUnsafeWifiCode() {
        val p = JSONObject(RecordsJson.build(sequenceOf(fix(0).copy(wifiH = "a\"b")), emptyList(), t0)).getJSONArray("rawSignals").getJSONObject(0).getJSONObject("position")
        assertTrue(!p.has("wifiH"))
    }

    @Test fun leavesOutSpeedWhenUnknown() {
        val json = RecordsJson.build(sequenceOf(fix(0, -1f)), emptyList(), t0)
        assertTrue(!JSONObject(json).getJSONArray("rawSignals").getJSONObject(0).getJSONObject("position").has("speedMetersPerSecond"))
    }

    @Test fun emptyDataIsStillValid() {
        assertEquals(0, JSONObject(RecordsJson.build(emptySequence(), emptyList(), t0)).getJSONArray("rawSignals").length())
    }

    @Test fun expandsActivityTransitionsIntoOneRecordPerMinute() {
        val acts = listOf(Act(t0, Policy.IN_VEHICLE, true), Act(t0 + 5 * 60_000L, Policy.IN_VEHICLE, false))
        val recs = RecordsJson.activityRecords(acts, t0 + 3_600_000L)
        assertEquals(6, recs.size)                       // minutes 0..5
        assertTrue(recs.all { it.second == "IN_VEHICLE" })
        assertEquals(t0, recs.first().first); assertEquals(t0 + 5 * 60_000L, recs.last().first)
    }

    @Test fun switchingActivityClosesThePreviousOne() {
        val acts = listOf(Act(t0, Policy.WALKING, true), Act(t0 + 2 * 60_000L, Policy.IN_VEHICLE, true), Act(t0 + 4 * 60_000L, Policy.IN_VEHICLE, false))
        val recs = RecordsJson.activityRecords(acts, t0 + 3_600_000L)
        assertEquals(listOf("WALKING", "WALKING", "WALKING"), recs.take(3).map { it.second })
        assertEquals(3, recs.count { it.second == "IN_VEHICLE" })
    }

    @Test fun stillProducesNoRecordsAndEndsTheActivity() {
        val acts = listOf(Act(t0, Policy.WALKING, true), Act(t0 + 60_000L, Policy.STILL, true))
        assertEquals(2, RecordsJson.activityRecords(acts, t0 + 3_600_000L).size)
        assertEquals(0, RecordsJson.activityRecords(listOf(Act(t0, Policy.STILL, true)), t0 + 3_600_000L).size)
    }

    @Test fun anActivityThatNeverEndedStopsAtNowOrSixHours() {
        val open = listOf(Act(t0, Policy.IN_VEHICLE, true))
        assertEquals(3, RecordsJson.activityRecords(open, t0 + 2 * 60_000L).size)
        assertEquals(361, RecordsJson.activityRecords(open, t0 + 24 * 3_600_000L).size)
    }

    @Test fun writesASampleThatTheWebAppParserChecks() {
        val fixes = (0 until 200).map { fix(it, 8f).copy(alt = 30.0 + it % 3, vacc = 4f, prov = "gps", sat = 9, cn0 = 34f, wifiN = 12, wifiH = if (it < 10) "ab12cd34ef56ab78" else null) }
        val acts = listOf(Act(t0 - 60_000L, Policy.IN_VEHICLE, true), Act(t0 + 16 * 60_000L, Policy.IN_VEHICLE, false))
        val out = File("build/tmp/export-sample.json").also { it.parentFile.mkdirs() }
        out.writeText(RecordsJson.build(fixes.asSequence(), acts, t0 + 3_600_000L))
        assertTrue(out.length() > 0)
    }
}
