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
    # A cap on scans across the whole app, because each one costs money and there are no logins yet.
    receipt_daily_limit: int = 50
    # Uploads cost storage rather than a Claude call, but they still need a cap.
    receipt_upload_daily_limit: int = 100
    # Set by Terraform's receipts_bucket_name output. Without it, scanning is switched off.
    receipts_bucket: str | None = None
    aws_region: str = "us-east-2"
    # Your login locally. Production leaves this empty and uses the server's own AWS role.
    aws_profile: str | None = None


settings = Settings()
