using Microsoft.Data.Sqlite;

namespace Cs2VoiceMatcher.Core
{
    public static class DatabaseSchema
    {
        public static void EnsureCreated(SqliteConnection conn)
        {
            using var cmd = conn.CreateCommand();
            cmd.CommandText = @"
                PRAGMA journal_mode=WAL;

                CREATE TABLE IF NOT EXISTS demos (
                    demo_id     INTEGER PRIMARY KEY AUTOINCREMENT,
                    file_path   TEXT NOT NULL,
                    file_hash   TEXT NOT NULL UNIQUE,
                    map_name    TEXT,
                    host_name   TEXT,
                    player_count INTEGER DEFAULT 0,
                    processed_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS voice_profiles (
                    profile_id      INTEGER PRIMARY KEY AUTOINCREMENT,
                    steam_id        INTEGER NOT NULL,
                    player_name     TEXT,
                    team_number     INTEGER DEFAULT 0,
                    demo_id         INTEGER NOT NULL REFERENCES demos(demo_id),
                    mfcc_embedding  BLOB,
                    mfcc_stddev     BLOB,
                    total_frames    INTEGER DEFAULT 0,
                    speaking_seconds REAL DEFAULT 0,
                    created_at      TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS aggregated_profiles (
                    steam_id        INTEGER PRIMARY KEY,
                    known_names     TEXT,
                    mfcc_embedding  BLOB,
                    total_frames    INTEGER DEFAULT 0,
                    total_speaking  REAL DEFAULT 0,
                    demo_count      INTEGER DEFAULT 0,
                    updated_at      TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS voice_matches (
                    match_id        INTEGER PRIMARY KEY AUTOINCREMENT,
                    steam_id_1      INTEGER NOT NULL,
                    steam_id_2      INTEGER NOT NULL,
                    similarity      REAL NOT NULL,
                    different_names INTEGER DEFAULT 0,
                    names_1         TEXT,
                    names_2         TEXT,
                    computed_at     TEXT NOT NULL,
                    UNIQUE(steam_id_1, steam_id_2)
                );

                CREATE INDEX IF NOT EXISTS idx_profiles_steam ON voice_profiles(steam_id);
                CREATE INDEX IF NOT EXISTS idx_profiles_demo ON voice_profiles(demo_id);
                CREATE INDEX IF NOT EXISTS idx_matches_sim ON voice_matches(similarity DESC);
                CREATE INDEX IF NOT EXISTS idx_matches_diff ON voice_matches(different_names, similarity DESC);
            ";
            cmd.ExecuteNonQuery();
        }
    }
}
