/**
 * Postgres client using Railway's built-in DATABASE_URL.
 * Railway sets this automatically when you add a Postgres database to your project.
 */

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS installations (
      team_id      TEXT PRIMARY KEY,
      team_name    TEXT,
      bot_token    TEXT NOT NULL,
      bot_user_id  TEXT,
      installed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS requests (
      id                       TEXT NOT NULL,
      team_id                  TEXT NOT NULL,
      requester_id             TEXT NOT NULL,
      shift_details            TEXT NOT NULL,
      candidates               TEXT NOT NULL DEFAULT '[]',
      current_index            INTEGER NOT NULL DEFAULT 0,
      status                   TEXT NOT NULL DEFAULT 'awaiting_names',
      accepted_by              TEXT,
      current_asked_user_id    TEXT,
      current_asked_channel_id TEXT,
      conversation_history     TEXT NOT NULL DEFAULT '[]',
      created_at               TEXT NOT NULL,
      PRIMARY KEY (team_id, id)
    );
  `);
  console.log("✅ Database ready");
}

module.exports = { pool, migrate };
