import httpx
import pytest
from fastapi import FastAPI

from dibs import rate_limit
from dibs.rate_limit import (
    REQUESTS_PER_MINUTE,
    SCAN_REQUESTS_PER_MINUTE,
    RateLimiter,
    RateLimitMiddleware,
)

pytestmark = pytest.mark.anyio


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


# --- RateLimiter ---


def test_allows_up_to_the_limit_then_refuses():
    limiter = RateLimiter(FakeClock())

    assert [limiter.allow("1.1.1.1", "all", 2) for _ in range(3)] == [True, True, False]


def test_each_client_and_each_rule_counts_separately():
    limiter = RateLimiter(FakeClock())
    limiter.allow("1.1.1.1", "all", 1)

    assert not limiter.allow("1.1.1.1", "all", 1)
    assert limiter.allow("2.2.2.2", "all", 1)
    assert limiter.allow("1.1.1.1", "scan", 1)


def test_the_count_resets_after_a_minute():
    clock = FakeClock()
    limiter = RateLimiter(clock)
    limiter.allow("1.1.1.1", "all", 1)

    clock.now += 59
    assert not limiter.allow("1.1.1.1", "all", 1)
    clock.now += 1
    assert limiter.allow("1.1.1.1", "all", 1)


def test_old_windows_are_cleared_so_memory_cannot_grow_forever(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(rate_limit, "MAX_TRACKED", 3)
    clock = FakeClock()
    limiter = RateLimiter(clock)
    for client in ("a", "b", "c"):
        limiter.allow(client, "all", 1)

    clock.now += 61
    limiter.allow("d", "all", 1)

    assert len(limiter._windows) == 1


# --- The middleware, on a small app of its own, because the real one has it off in tests ---


def make_client(ip: str = "1.1.1.1", app: FastAPI | None = None) -> httpx.AsyncClient:
    if app is None:
        app = make_app()
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, client=(ip, 1234)), base_url="http://test"
    )


def make_app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(RateLimitMiddleware, limiter=RateLimiter(FakeClock()))

    @app.get("/bills/abc")
    def bill() -> dict:
        return {}

    @app.get("/health")
    def health() -> dict:
        return {}

    @app.post("/receipts/upload-url")
    def upload() -> dict:
        return {}

    @app.post("/bills/from-receipt")
    def scan() -> dict:
        return {}

    return app


async def test_normal_use_gets_through():
    async with make_client() as client:
        for _ in range(REQUESTS_PER_MINUTE):
            assert (await client.get("/bills/abc")).status_code == 200


async def test_too_many_requests_get_a_429_that_says_when_to_retry():
    async with make_client() as client:
        for _ in range(REQUESTS_PER_MINUTE):
            await client.get("/bills/abc")

        response = await client.get("/bills/abc")

    assert response.status_code == 429
    assert response.headers["retry-after"] == "60"
    assert "Try again in a minute" in response.json()["detail"]


async def test_one_address_being_limited_does_not_affect_another():
    app = make_app()
    async with make_client("1.1.1.1", app) as busy, make_client("2.2.2.2", app) as other:
        for _ in range(REQUESTS_PER_MINUTE + 1):
            await busy.get("/bills/abc")

        assert (await other.get("/bills/abc")).status_code == 200


@pytest.mark.parametrize("path", ["/receipts/upload-url", "/bills/from-receipt"])
async def test_scanning_has_a_much_tighter_limit(path: str):
    async with make_client() as client:
        for _ in range(SCAN_REQUESTS_PER_MINUTE):
            assert (await client.post(path)).status_code == 200

        assert (await client.post(path)).status_code == 429
        assert (await client.get("/bills/abc")).status_code == 200


async def test_both_scan_steps_share_one_limit():
    async with make_client() as client:
        for _ in range(SCAN_REQUESTS_PER_MINUTE // 2):
            await client.post("/receipts/upload-url")
            await client.post("/bills/from-receipt")

        assert (await client.post("/receipts/upload-url")).status_code == 429


async def test_health_checks_are_never_limited():
    async with make_client() as client:
        for _ in range(REQUESTS_PER_MINUTE + 5):
            await client.get("/bills/abc")

        assert (await client.get("/health")).status_code == 200


def test_the_real_app_has_it_off_unless_configured():
    from dibs.main import app

    assert not any(m.cls is RateLimitMiddleware for m in app.user_middleware)
