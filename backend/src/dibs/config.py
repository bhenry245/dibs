from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """App configuration, read from environment variables (12-factor).

    Each field maps to an env var with the same name, uppercased:
    `database_url` is set by `DATABASE_URL`. Defaults are for local dev only.
    """

    database_url: str = "postgresql+asyncpg://dibs:dibs@localhost:5433/dibs"


settings = Settings()
