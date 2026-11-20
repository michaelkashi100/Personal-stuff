package app.timeline.personal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

class BundleTest {
    private val h = "a".repeat(64)
    private fun json(vararg paths: String, built: Long = 1_700_000_000L) =
        "{\"version\":\"x\",\"built\":$built,\"files\":[" + paths.joinToString(",") { "{\"path\":\"$it\",\"sha256\":\"$h\",\"size\":100}" } + "]}"

    @Test fun parsesAManifest() {
        val m = Bundle.parse(json("index.html", "lib/leaflet.js"))
        assertEquals(1_700_000_000L, m.built)
        assertEquals(listOf("index.html", "lib/leaflet.js"), m.files.map { it.path })
        assertEquals(h, m.files[0].sha256)
        assertNull(Bundle.problem(m))
    }

    @Test fun refusesPathsThatCouldEscapeTheFolder() {
        for (bad in listOf("../x.js", "/etc/passwd", "a/../../b", "./a", "a//b", ".hidden", "a b.js", "a\\b.js", "", "a/")) {
            assertFalse("should refuse '$bad'", Bundle.safePath(bad))
        }
        for (good in listOf("index.html", "lib/leaflet.js", "lib/images/marker-icon-2x.png", "icons/icon-192.png", "a-b_c.1.js")) {
            assertTrue("should allow '$good'", Bundle.safePath(good))
        }
        assertNotNull(Bundle.problem(Bundle.parse(json("index.html", "../evil.js"))))
    }

    @Test fun refusesBrokenManifests() {
        assertNotNull(Bundle.problem(Manifest(1, emptyList())))
        assertNotNull(Bundle.problem(Bundle.parse(json("app.js"))))                       // no index.html
        assertNotNull(Bundle.problem(Bundle.parse(json("index.html", "index.html"))))     // duplicates
        assertNotNull(Bundle.problem(Manifest(1, listOf(Entry("index.html", "zz", 1)))))  // not a hash
        assertNotNull(Bundle.problem(Manifest(1, listOf(Entry("index.html", h, Bundle.MAX_FILE_BYTES + 1)))))
    }

    @Test fun onlyNewerBuildsAreInstalled() {
        assertTrue(Bundle.isNewer(200, 100)); assertFalse(Bundle.isNewer(100, 100)); assertFalse(Bundle.isNewer(50, 100))
    }

    @Test fun hashesLikeSha256() {
        // well-known SHA-256 of "abc"
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", Bundle.sha256Hex("abc".toByteArray()))
    }

    @Test fun readsTheBuildNumberFromTheReleaseName() {
        assertEquals(12, Bundle.parseBuild("Timeline for Android (build 12)"))
        assertEquals(103, Bundle.parseBuild("build 103"))
        assertNull(Bundle.parseBuild("no number"))
    }

    @Test fun theRealBundledManifestPassesTheAppsOwnChecks() {
        val f = File("src/main/assets/www/bundle.json")          // written by the build before the tests run
        assumeTrue("no bundled manifest in this checkout", f.exists())
        val m = Bundle.parse(f.readText())
        assertNull(Bundle.problem(m))
        assertTrue(m.built >= 1_700_000_000L)
        // every listed file is really there with the listed hash
        for (e in m.files) {
            val file = File("src/main/assets/www/" + e.path)
            assertTrue("missing ${e.path}", file.exists())
            assertEquals("hash of ${e.path}", e.sha256, Bundle.sha256Hex(file.readBytes()))
        }
    }
}
