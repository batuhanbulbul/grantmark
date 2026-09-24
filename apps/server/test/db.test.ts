import { describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate, openDatabase } from '../src/db';

const tables = (db: ReturnType<typeof openDatabase>) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
    (row) => row.name,
  );

describe('database', () => {
  it('applies every migration when opened', () => {
    const db = openDatabase(':memory:');
    expect(tables(db)).toEqual(
      expect.arrayContaining(['declarations', 'events', 'registries', 'rights_subjects', 'schema_migrations', 'subject_class_members']),
    );
    const applied = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as { id: number }[];
    expect(applied.map((row) => row.id)).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it('does nothing when migrated again', () => {
    const db = openDatabase(':memory:');
    expect(migrate(db)).toBe(0);
  });

  it('numbers migrations in order without gaps', () => {
    expect(MIGRATIONS.map((m) => m.id)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  });

  it('enforces foreign keys', () => {
    const db = openDatabase(':memory:');
    expect(() =>
      db
        .prepare(
          `INSERT INTO declarations (hcrn, version, content, sha256, registry_url, first_published_at)
           VALUES ('HCRN-0000-0068-F', 1, x'00', 'x', 'https://unknown.example', '2026-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('keeps the event log append-only', () => {
    const db = openDatabase(':memory:');
    db.prepare("INSERT INTO events (at, type, subject, data) VALUES ('2026-01-01T00:00:00.000Z', 'test', 'x', '{}')").run();
    expect(() => db.prepare("UPDATE events SET type = 'changed'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM events').run()).toThrow(/append-only/);
  });
});
