package app.timeline.personal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ScreenSessionsTest {
    private val m = 60_000L
    @Test fun pairsOnAndOff() {
        val r = ScreenSessions.build(listOf(ScreenEv(0, true), ScreenEv(10 * m, false), ScreenEv(30 * m, true), ScreenEv(33 * m, false)), 60 * m)
        assertEquals(listOf(Session(0, 10 * m), Session(30 * m, 33 * m)), r.sessions)
        assertNull(r.openStart)
        assertEquals(33 * m, r.lastEvent)
    }
    @Test fun ignoresGlances() {
        val r = ScreenSessions.build(listOf(ScreenEv(0, true), ScreenEv(3_000, false)), 10 * m)
        assertEquals(0, r.sessions.size)
    }
    @Test fun stillOnCountsUntilNowAndReportsTheStart() {
        val r = ScreenSessions.build(listOf(ScreenEv(5 * m, true)), 20 * m)
        assertEquals(listOf(Session(5 * m, 20 * m)), r.sessions)
        assertEquals(5 * m, r.openStart)
    }
    @Test fun repeatedOnAndStrayOffAreHarmless() {
        val r = ScreenSessions.build(listOf(ScreenEv(m, false), ScreenEv(2 * m, true), ScreenEv(3 * m, true), ScreenEv(8 * m, false)), 30 * m)
        assertEquals(listOf(Session(2 * m, 8 * m)), r.sessions)
    }
    @Test fun unsortedEventsAreSorted() {
        val r = ScreenSessions.build(listOf(ScreenEv(8 * m, false), ScreenEv(2 * m, true)), 30 * m)
        assertEquals(listOf(Session(2 * m, 8 * m)), r.sessions)
    }
    @Test fun jsonIsPairs() {
        assertEquals("[[1,2],[3,4]]", ScreenSessions.toJson(listOf(Session(1, 2), Session(3, 4))))
        assertEquals("[]", ScreenSessions.toJson(emptyList()))
    }
}
