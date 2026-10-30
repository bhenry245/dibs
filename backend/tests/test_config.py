from dibs.config import Settings


def test_database_url_comes_from_environment(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://u:p@example.com:5432/x")

    assert Settings().database_url == "postgresql+asyncpg://u:p@example.com:5432/x"
