package app.timeline.personal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PolicyTest {
    @Test fun batchesGpsSoTheCpuWakesRarely() {
        for (m in Mode.values()) {
            val p = Policy.paramsFor(m)
            assertTrue("$m interval", p.intervalMs in 5_000L..10_000L)
            assertTrue("$m batches at least 30 s of fixes", p.maxDelayMs >= 30_000L)
            assertTrue("$m distance filter", p.minDistanceM >= 5f)
        }
        assertTrue(Policy.paramsFor(Mode.WALK).intervalMs >= Policy.paramsFor(Mode.DRIVE).intervalMs)
    }

    @Test fun mapsActivityCodesToModes() {
        assertEquals(Mode.DRIVE, Policy.modeFor(Policy.IN_VEHICLE))
        assertEquals(Mode.BIKE, Policy.modeFor(Policy.ON_BICYCLE))
        assertEquals(Mode.WALK, Policy.modeFor(Policy.WALKING))
        assertEquals(Mode.WALK, Policy.modeFor(Policy.RUNNING))
        assertEquals(Mode.WALK, Policy.modeFor(Policy.ON_FOOT))
        assertNull(Policy.modeFor(Policy.STILL))
        assertNull(Policy.modeFor(5)) // tilting
        assertTrue(Policy.isStill(Policy.STILL))
    }

    @Test fun dropsInaccurateFixesOnly() {
        assertTrue(Policy.accept(5f)); assertTrue(Policy.accept(200f)); assertFalse(Policy.accept(450f))
    }

    @Test fun distanceIsRight() {
        // one degree of latitude is about 111.2 km
        assertEquals(111_195.0, Policy.distanceM(0.0, 0.0, 1.0, 0.0), 300.0)
        assertEquals(0.0, Policy.distanceM(32.1, 34.8, 32.1, 34.8), 1e-6)
        assertTrue(Policy.moved(Policy.distanceM(32.1, 34.8, 32.1003, 34.8)))     // about 33 m
        assertFalse(Policy.moved(Policy.distanceM(32.1, 34.8, 32.1001, 34.8)))    // about 11 m: GPS wobble
    }

    @Test fun stopsAfterTenIdleMinutes() {
        assertFalse(Policy.idleTooLong(9 * 60_000L, 0)); assertTrue(Policy.idleTooLong(11 * 60_000L, 0))
        assertTrue(Policy.STOP_AFTER_STILL_MS < Policy.MAX_IDLE_MS)
    }
}
