"""Tests for streamhub_sdk.migrations — stdlib sqlite3 only, no fixtures needed."""

import os
import sqlite3

import pytest

from streamhub_sdk.migrations import (
    MigrationError,
    apply_migrations,
    discover_migrations,
)


def write(migrations_dir, name, sql):
    os.makedirs(migrations_dir, exist_ok=True)
    with open(os.path.join(migrations_dir, name), "w", encoding="utf-8") as fh:
        fh.write(sql)


def user_version(db_path):
    conn = sqlite3.connect(db_path)
    try:
        return conn.execute("PRAGMA user_version").fetchone()[0]
    finally:
        conn.close()


def table_names(db_path):
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
        return sorted(r[0] for r in rows)
    finally:
        conn.close()


# --- discovery ---------------------------------------------------------------


def test_discover_sorts_numerically_not_lexically(tmp_path):
    mdir = str(tmp_path / "m")
    write(mdir, "001_a.sql", "SELECT 1;")
    write(mdir, "002_b.sql", "SELECT 1;")
    write(mdir, "010_c.sql", "SELECT 1;")
    write(mdir, "README.md", "not a migration")
    write(mdir, ".hidden.sql", "not matching")
    versions = [m.version for m in discover_migrations(mdir)]
    assert versions == [1, 2, 10]


def test_discover_rejects_duplicate_version(tmp_path):
    mdir = str(tmp_path / "m")
    write(mdir, "001_a.sql", "SELECT 1;")
    write(mdir, "001_b.sql", "SELECT 1;")
    with pytest.raises(MigrationError, match="duplicate migration version 1"):
        discover_migrations(mdir)


def test_discover_rejects_non_positive_version(tmp_path):
    mdir = str(tmp_path / "m")
    write(mdir, "000_init.sql", "SELECT 1;")
    with pytest.raises(MigrationError, match="positive integer"):
        discover_migrations(mdir)


def test_discover_missing_dir_is_empty(tmp_path):
    assert discover_migrations(str(tmp_path / "nope")) == []


# --- apply -------------------------------------------------------------------


def test_apply_fresh_db_runs_all_and_sets_version(tmp_path):
    mdir = str(tmp_path / "m")
    write(mdir, "001_a.sql", "CREATE TABLE a (id INTEGER PRIMARY KEY);")
    write(mdir, "002_b.sql", "CREATE TABLE b (id INTEGER PRIMARY KEY);")
    db = str(tmp_path / "data" / "app.db")

    applied = apply_migrations(db, mdir)
    assert applied == 2
    assert user_version(db) == 2
    assert table_names(db) == ["a", "b"]
    # A brand-new (empty) db has nothing to protect → no backup written.
    assert not os.path.exists(f"{db}.pre-migrate-v0.bak")


def test_apply_is_idempotent(tmp_path):
    mdir = str(tmp_path / "m")
    write(mdir, "001_a.sql", "CREATE TABLE a (id INTEGER PRIMARY KEY);")
    db = str(tmp_path / "app.db")

    assert apply_migrations(db, mdir) == 1
    assert apply_migrations(db, mdir) == 0  # nothing pending on re-run
    assert user_version(db) == 1


def test_apply_new_migration_backs_up_existing_data(tmp_path):
    mdir = str(tmp_path / "m")
    write(mdir, "001_a.sql", "CREATE TABLE a (id INTEGER PRIMARY KEY);")
    db = str(tmp_path / "app.db")
    apply_migrations(db, mdir)

    # Populate, then ship a second migration → the existing db is backed up.
    conn = sqlite3.connect(db)
    conn.execute("INSERT INTO a (id) VALUES (42)")
    conn.commit()
    conn.close()

    write(mdir, "002_b.sql", "CREATE TABLE b (id INTEGER PRIMARY KEY);")
    applied = apply_migrations(db, mdir)
    assert applied == 1
    assert user_version(db) == 2
    backup = f"{db}.pre-migrate-v1.bak"
    assert os.path.exists(backup)
    # The backup is the PRE-migration schema (v1: only table a, row intact).
    assert table_names(backup) == ["a"]
    assert user_version(backup) == 1
    conn = sqlite3.connect(backup)
    assert conn.execute("SELECT id FROM a").fetchone()[0] == 42
    conn.close()


def test_apply_refuses_downgrade(tmp_path):
    mdir = str(tmp_path / "m")
    write(mdir, "001_a.sql", "CREATE TABLE a (id INTEGER PRIMARY KEY);")
    db = str(tmp_path / "app.db")

    # Simulate a db written by NEWER code (schema v5) than the migrations on disk.
    conn = sqlite3.connect(db, isolation_level=None)
    conn.execute("PRAGMA user_version = 5")
    conn.close()

    with pytest.raises(MigrationError, match="refusing to downgrade"):
        apply_migrations(db, mdir)
    assert user_version(db) == 5  # untouched


def test_apply_rolls_back_a_failing_migration(tmp_path):
    mdir = str(tmp_path / "m")
    write(mdir, "001_a.sql", "CREATE TABLE a (id INTEGER PRIMARY KEY);")
    db = str(tmp_path / "app.db")
    assert apply_migrations(db, mdir) == 1  # 001 applied first, alone

    # Now ship 002, which creates a table THEN hits an error — the whole
    # migration must roll back (schema + version bump).
    write(
        mdir,
        "002_bad.sql",
        "CREATE TABLE b (id INTEGER PRIMARY KEY);\n"
        "INSERT INTO does_not_exist VALUES (1);",
    )
    with pytest.raises(MigrationError, match="002_bad.sql"):
        apply_migrations(db, mdir)

    # 002 fully rolled back: table b gone, version still 1, table a intact.
    assert user_version(db) == 1
    assert table_names(db) == ["a"]


def test_apply_no_migrations_returns_zero(tmp_path):
    db = str(tmp_path / "app.db")
    assert apply_migrations(db, str(tmp_path / "empty")) == 0
