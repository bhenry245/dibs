# The API as a production image. Build from backend/.

FROM python:3.13-slim

# Don't buffer logs, so they appear right away, and don't write .pyc files nobody will reuse.
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1

RUN pip install --no-cache-dir uv==0.13.6

WORKDIR /app

# Dependencies come first, so changing the code doesn't reinstall them on every build. --locked
# installs exactly what uv.lock says, and --no-dev leaves out test tools.
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --locked --no-dev --no-install-project

COPY src ./src
COPY alembic ./alembic
COPY alembic.ini ./
RUN uv sync --locked --no-dev

# If someone ever broke out of the app, they wouldn't be root inside the container.
RUN useradd --create-home --uid 1000 dibs
USER dibs

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD .venv/bin/python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"

# Brings the database up to date, then starts one worker. Exactly one, because WebSocket connections
# live in the process's memory, so a second worker's screens wouldn't hear about changes. Forwarded
# headers are trusted because only Caddy can reach this port, and rate limits need the real client IP.
CMD ["sh", "-c", ".venv/bin/alembic upgrade head && exec .venv/bin/uvicorn dibs.main:app --host 0.0.0.0 --port 8000 --workers 1 --proxy-headers --forwarded-allow-ips='*'"]
