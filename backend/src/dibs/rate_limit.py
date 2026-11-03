# Limits how many requests one IP address can make. With no logins, this is what keeps one person
# from flooding the API or burning through the day's scans before anyone else gets one.

# Counts live in this process's memory, which only works with one server, like live updates. Each
# rule counts in fixed one-minute windows, which is simple and close enough for this job.

import json
import time
from collections.abc import Callable
from dataclasses import dataclass

from starlette.types import ASGIApp, Receive, Scope, Send

WINDOW_SECONDS = 60
# Friends at a table often share one Wi-Fi address, and each screen makes several requests a minute,
# so this has to leave room for a whole table.
REQUESTS_PER_MINUTE = 300
# Each photo uses both of these, and a scan costs money, so these are much tighter.
SCAN_REQUESTS_PER_MINUTE = 10
SCAN_PATHS = {"/receipts/upload-url", "/bills/from-receipt"}
# So uptime monitors and the container's health check can't be limited.
EXEMPT_PATHS = {"/health"}
# Old windows get cleared out once this many are being tracked, so memory can't grow forever.
MAX_TRACKED = 10_000


@dataclass
class Window:
    started_at: float
    count: int


class RateLimiter:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._windows: dict[tuple[str, str], Window] = {}

    def allow(self, client: str, rule: str, limit: int) -> bool:
        now = self._clock()
        if len(self._windows) >= MAX_TRACKED:
            self._windows = {
                key: window
                for key, window in self._windows.items()
                if now - window.started_at < WINDOW_SECONDS
            }

        window = self._windows.get((client, rule))
        if window is None or now - window.started_at >= WINDOW_SECONDS:
            window = Window(started_at=now, count=0)
            self._windows[(client, rule)] = window
        window.count += 1
        return window.count <= limit


class RateLimitMiddleware:
    def __init__(self, app: ASGIApp, limiter: RateLimiter | None = None) -> None:
        self.app = app
        self.limiter = limiter or RateLimiter()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        # WebSockets connect once and then wait, and each bill's connections are capped separately.
        if scope["type"] != "http" or scope["path"] in EXEMPT_PATHS:
            await self.app(scope, receive, send)
            return

        client = scope["client"][0] if scope.get("client") else "unknown"
        allowed = self.limiter.allow(client, "all", REQUESTS_PER_MINUTE)
        if scope["path"] in SCAN_PATHS:
            allowed = self.limiter.allow(client, "scan", SCAN_REQUESTS_PER_MINUTE) and allowed

        if allowed:
            await self.app(scope, receive, send)
            return

        body = json.dumps({"detail": "That's a lot of requests. Try again in a minute."}).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 429,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"retry-after", str(WINDOW_SECONDS).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
