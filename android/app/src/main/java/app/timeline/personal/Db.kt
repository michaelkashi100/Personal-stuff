package app.timeline.personal

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

data class Stats(val count: Long, val first: Long, val last: Long)

/** The recorded locations. Stored only in this app's private storage on the phone. */
class Db private constructor(context: Context) : SQLiteOpenHelper(context, "timeline.db", null, 1) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE fixes(t INTEGER PRIMARY KEY, lat REAL NOT NULL, lng REAL NOT NULL, acc REAL NOT NULL, spd REAL NOT NULL, src INTEGER NOT NULL)")
        db.execSQL("CREATE TABLE acts(id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, type INTEGER NOT NULL, enter INTEGER NOT NULL)")
        db.execSQL("CREATE INDEX acts_t ON acts(t)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {}

    @Synchronized
    fun insertFixes(list: List<Fix>) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            for (f in list) {
                val v = ContentValues(6)
                v.put("t", f.t); v.put("lat", f.lat); v.put("lng", f.lng); v.put("acc", f.acc.toDouble()); v.put("spd", f.spd.toDouble()); v.put("src", f.src)
                db.insertWithOnConflict("fixes", null, v, SQLiteDatabase.CONFLICT_IGNORE)
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
        val c = readableDatabase.rawQuery("SELECT t, lat, lng, acc, spd, src FROM fixes WHERE t >= ? ORDER BY t", arrayOf(since.toString()))
        c.use {
            while (it.moveToNext()) yield(Fix(it.getLong(0), it.getDouble(1), it.getDouble(2), it.getFloat(3), it.getFloat(4), it.getInt(5)))
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
    }

    companion object {
        @Volatile private var instance: Db? = null
        fun get(context: Context): Db = instance ?: synchronized(this) {
            instance ?: Db(context.applicationContext).also { instance = it }
        }
    }
}
