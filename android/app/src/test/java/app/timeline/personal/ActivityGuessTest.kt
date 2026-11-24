package app.timeline.personal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ActivityGuessTest {
    private fun g(steps: Int, speed: Double, shake: Double = -1.0) = ActivityGuess.classify(ActivityGuess.Window(steps, 60.0, speed, shake))

    @Test fun stepsMeanWalkingOrRunning() {
        assertEquals(Policy.WALKING, g(100, 1.4))
        assertEquals(Policy.WALKING, g(100, -1.0))
        assertEquals(Policy.RUNNING, g(165, 3.0))
    }

    @Test fun noStepsIsDecidedBySpeedAndShaking() {
        assertEquals(Policy.STILL, g(0, 0.2))
        assertEquals(Policy.WALKING, g(0, 1.5))                  // walking with the phone in a bag that does not count steps
        assertEquals(Policy.ON_BICYCLE, g(0, 5.5, 2.5))
        assertEquals(Policy.IN_VEHICLE, g(0, 5.5, 0.3))           // slow traffic: smooth, no steps
        assertEquals(Policy.IN_VEHICLE, g(0, 15.0))
        assertEquals(Policy.STILL, g(0, -1.0))
        assertNull(g(20, -1.0))                                    // a few steps, no speed: unknown
    }

    @Test fun walkingInsideABusIsNotWalkingAtBusSpeed() {
        assertNotEquals(Policy.WALKING, g(60, 12.0))
    }

    @Test fun shakeIsTheSpreadOfAcceleration() {
        val calm = FloatArray(50) { 9.81f }
        val bumpy = FloatArray(50) { if (it % 2 == 0) 7f else 12.6f }
        assertEquals(0.0, ActivityGuess.shake(calm, 50), 1e-6)
        assertTrue(ActivityGuess.shake(bumpy, 50) > 2.5)
        assertEquals(-1.0, ActivityGuess.shake(calm, 5), 0.0)
    }

    @Test fun startAndStopRules() {
        assertTrue(Policy.shouldStartGps(0, true, 0.0))
        assertTrue(Policy.shouldStartGps(45, false, 0.0))
        assertFalse(Policy.shouldStartGps(8, false, 0.0))          // a few steps around the room
        assertTrue(Policy.shouldStartGps(0, false, 500.0))         // another app's fix shows you far away
        val now = 10_000_000L
        assertFalse(Policy.shouldStopGps(now, now - 60_000L, now - 10 * 60_000L))   // still stepping
        assertFalse(Policy.shouldStopGps(now, now - 10 * 60_000L, now - 60_000L))   // still moving (driving, no steps)
        assertTrue(Policy.shouldStopGps(now, now - 4 * 60_000L, now - 4 * 60_000L))
        assertEquals(Mode.DRIVE, Policy.modeForActivity(Policy.IN_VEHICLE)); assertEquals(Mode.WALK, Policy.modeForActivity(null))
        assertEquals("WIFI", Policy.sourceName("network", 30f)); assertEquals("CELL", Policy.sourceName("network", 800f)); assertEquals("GPS", Policy.sourceName("gps", 5f))
    }

    @Test fun wifiCodesAreStableScrambledAndSkipUnknown() {
        val a = WifiHash.of("AA:BB:CC:DD:EE:FF", "salt1")!!
        assertEquals(a, WifiHash.of("aa:bb:cc:dd:ee:ff", "salt1"))
        assertNotEquals(a, WifiHash.of("aa:bb:cc:dd:ee:ff", "salt2"))
        assertEquals(16, a.length); assertFalse(a.contains("aa:bb"))
        assertNull(WifiHash.of("02:00:00:00:00:00", "s")); assertNull(WifiHash.of(null, "s"))
    }
}
