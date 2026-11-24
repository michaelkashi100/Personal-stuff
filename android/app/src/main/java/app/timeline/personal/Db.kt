package app.timeline.personal

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

data class Stats(val count: Long, val first: Long, val last: Long)

/** The recorded locations. Stored only in this app's private storage on the phone. */
class Db private constructor(context: Context) : SQLiteOpenHelper(context, "timeline.db", null, 3) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE fixes(t INTEGER PRIMARY KEY, lat REAL NOT NULL, lng REAL NOT NULL, acc REAL NOT NULL, spd REAL NOT NULL, src INTEGER NOT NULL)")
        db.execSQL("CREATE TABLE acts(id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, type INTEGER NOT NULL, enter INTEGER NOT NULL)")
        db.execSQL("CREATE INDEX acts_t ON acts(t)")
        db.execSQL("CREATE TABLE screen(start INTEGER PRIMARY KEY, stop INTEGER NOT NULL)")
        db.execSQL(SIG_TABLE)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) db.execSQL("CREATE TABLE IF NOT EXISTS screen(start INTEGER PRIMARY KEY, stop INTEGER NOT NULL)")
        if (oldVersion < 3) db.execSQL(SIG_TABLE)
    }

    /** Phone-in-use sessions. A session that was still open is replaced when it is read again with its real end. */
    @Synchronized
    fun upsertScreen(list: List<Session>) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            for (s in list) {
                val v = ContentValues(2)
                v.put("start", s.start); v.put("stop", s.end)
                db.insertWithOnConflict("screen", null, v, SQLiteDatabase.CONFLICT_REPLACE)
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun screen(since: Long): List<Session> {
        val out = ArrayList<Session>()
        readableDatabase.rawQuery("SELECT start, stop FROM screen WHERE stop >= ? ORDER BY start", arrayOf(since.toString())).use {
            while (it.moveToNext()) out.add(Session(it.getLong(0), it.getLong(1)))
        }
        return out
    }

    @Synchronized
    fun insertFixes(list: List<Fix>) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            for (f in list) {
                val v = ContentValues(6)
                v.put("t", f.t); v.put("lat", f.lat); v.put("lng", f.lng); v.put("acc", f.acc.toDouble()); v.put("spd", f.spd.toDouble()); v.put("src", f.src)
                db.insertWithOnConflict("fixes", null, v, SQLiteDatabase.CONFLICT_IGNORE)
                if (f.hasSignal) {
                    val g = ContentValues(8)
                    g.put("t", f.t); f.alt?.let { g.put("alt", it) }; f.vacc?.let { g.put("vacc", it.toDouble()) }; f.prov?.let { g.put("prov", it) }
                    f.sat?.let { g.put("sat", it) }; f.cn0?.let { g.put("cn0", it.toDouble()) }; f.wifiN?.let { g.put("wifiN", it) }; f.wifiH?.let { g.put("wifiH", it) }
                    db.insertWithOnConflict("sig", null, g, SQLiteDatabase.CONFLICT_IGNORE)
                }
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    @Synchronized
    fun insertAct(a: Act) {
        val v = ContentValues(3)
        v.put("t", a.t); v.put("type", a.type); v.put("enter", if (a.enter) 1 else 0)
        writableDatabase.insert("acts", null, v)
    }

    /** Streams the fixes in time order without loading them all into memory. */
    fun fixes(since: Long): Sequence<Fix> = sequence {
        val c = readableDatabase.rawQuery(
            "SELECT f.t, f.lat, f.lng, f.acc, f.spd, f.src, s.alt, s.vacc, s.prov, s.sat, s.cn0, s.wifiN, s.wifiH FROM fixes f LEFT JOIN sig s ON s.t = f.t WHERE f.t >= ? ORDER BY f.t",
            arrayOf(since.toString()))
        c.use {
            while (it.moveToNext()) yield(Fix(it.getLong(0), it.getDouble(1), it.getDouble(2), it.getFloat(3), it.getFloat(4), it.getInt(5),
                if (it.isNull(6)) null else it.getDouble(6), if (it.isNull(7)) null else it.getFloat(7), if (it.isNull(8)) null else it.getString(8),
                if (it.isNull(9)) null else it.getInt(9), if (it.isNull(10)) null else it.getFloat(10), if (it.isNull(11)) null else it.getInt(11),
                if (it.isNull(12)) null else it.getString(12)))
        }
    }

    fun acts(since: Long): List<Act> {
        val out = ArrayList<Act>()
        readableDatabase.rawQuery("SELECT t, type, enter FROM acts WHERE t >= ? ORDER BY t", arrayOf(since.toString())).use {
            while (it.moveToNext()) out.add(Act(it.getLong(0), it.getInt(1), it.getInt(2) == 1))
        }
        return out
    }

    fun stats(): Stats {
        readableDatabase.rawQuery("SELECT COUNT(*), COALESCE(MIN(t), 0), COALESCE(MAX(t), 0) FROM fixes", null).use {
            return if (it.moveToFirst()) Stats(it.getLong(0), it.getLong(1), it.getLong(2)) else Stats(0, 0, 0)
        }
    }

    @Synchronized
    fun clear() {
        val db = writableDatabase
        db.delete("fixes", null, null)
        db.delete("acts", null, null)
        db.delete("sig", null, null)
    }

    /** Signal details older than [before] are no longer needed for the cleaning: delete them. */
    @Synchronized
    fun pruneSignals(before: Long): Int = writableDatabase.delete("sig", "t < ?", arrayOf(before.toString()))

    companion object {
        private const val SIG_TABLE = "CREATE TABLE IF NOT EXISTS sig(t INTEGER PRIMARY KEY, alt REAL, vacc REAL, prov TEXT, sat INTEGER, cn0 REAL, wifiN INTEGER, wifiH TEXT)"
        @Volatile private var instance: Db? = null
        fun get(context: Context): Db = instance ?: synchronized(this) {
            instance ?: Db(context.applicationContext).also { instance = it }
        }
    }
}
