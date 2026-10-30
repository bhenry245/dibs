# Dibs backend

FastAPI service with async SQLAlchemy and Alembic migrations, backed by PostgreSQL.

Setup, run and test instructions are in the [root README](../README.md#running-locally).

| Path | Contains |
|---|---|
| `src/dibs/main.py` | FastAPI app and routes |
| `src/dibs/config.py` | Settings, read from environment variables (`DATABASE_URL`) |
| `src/dibs/db.py` | Database engine and per-request session |
| `src/dibs/models.py` | SQLAlchemy models (one class per table) |
| `alembic/versions/` | Migration history: the source of truth for the schema |
| `tests/` | pytest tests |
