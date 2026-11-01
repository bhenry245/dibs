from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """App configuration, read from environment variables (12-factor).

    Each field maps to an env var with the same name, uppercased:
    `database_url` is set by `DATABASE_URL`. Defaults are for local dev only.
    For local dev, values can also come from a git-ignored `.env` file in backend/.
    """

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://dibs:dibs@localhost:5433/dibs"
    anthropic_api_key: str | None = None
    receipt_model: str = "claude-sonnet-5-5"


settings = Settings()
