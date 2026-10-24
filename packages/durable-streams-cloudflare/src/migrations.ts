/**
 * The StreamObject tables, as code rather than a directory: alchemy's `SqlMigrations` reads a
 * directory relative to where alchemy runs, which breaks once this package is installed in
 * someone else's stack. Effect's migrator records applied ids in `effect_sql_migrations`. It
 * skips id 0, so ids start at 1.
 */
import { Effect } from 'effect';
import { SqlClient } from 'effect/sql';
import * as Migrator from '@effect/sql-sqlite-do/SqliteMigrator';

export const migrate = Migrator.run({
    loader: Migrator.fromRecord({
        // engine-design.md "Tables". In a Durable Object, `stream` always holds the object's one path.
        '1_create_stream_tables': Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;

            yield* sql`
        CREATE TABLE streams (
          stream            TEXT    PRIMARY KEY,
          generation        INTEGER NOT NULL,
          content_type      TEXT    NOT NULL,
          tail              INTEGER NOT NULL,
          closed            INTEGER NOT NULL,
          closed_by         TEXT,
          ttl_seconds       INTEGER,
          expires_at        TEXT,
          created_at        TEXT    NOT NULL,
          last_accessed_at  TEXT    NOT NULL,
          last_stream_seq   TEXT
        )
      `;

            yield* sql`
        CREATE TABLE chunks (
          stream      TEXT    NOT NULL,
          msg_offset  INTEGER NOT NULL,
          part        INTEGER NOT NULL,
          data        BLOB    NOT NULL,
          PRIMARY KEY (stream, msg_offset, part)
        )
      `;

            yield* sql`
        CREATE TABLE producers (
          stream    TEXT    NOT NULL,
          id        TEXT    NOT NULL,
          epoch     INTEGER NOT NULL,
          last_seq  INTEGER NOT NULL,
          PRIMARY KEY (stream, id)
        )
      `;
        }),
        // engine-design.md "Forks".
        '2_add_forks': Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;

            // fork: the PUT that made this stream a fork (source, offset and sub-offset as requested), JSON
            yield* sql`ALTER TABLE streams ADD COLUMN fork TEXT`;
            // copy: set while the fork is still being created (claimed, or copying and how far), JSON
            yield* sql`ALTER TABLE streams ADD COLUMN copy TEXT`;
            // soft_deleted: deleted while forks still copy from it; answers 410
            yield* sql`ALTER TABLE streams ADD COLUMN soft_deleted INTEGER NOT NULL DEFAULT 0`;

            // on a source: one row per fork made from it
            yield* sql`
        CREATE TABLE forks (
          stream  TEXT NOT NULL,
          fork    TEXT NOT NULL,
          PRIMARY KEY (stream, fork)
        )
      `;

            // on a purged fork: a removeFork call to its source that failed, kept to retry.
            // due_at is in epoch milliseconds.
            yield* sql`
        CREATE TABLE pending_releases (
          stream    TEXT    NOT NULL,
          source    TEXT    NOT NULL,
          attempts  INTEGER NOT NULL,
          due_at    INTEGER NOT NULL,
          PRIMARY KEY (stream, source)
        )
      `;
        }),
    }),
});
