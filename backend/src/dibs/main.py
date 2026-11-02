from fastapi import FastAPI

from dibs.draft_routes import router as draft_router
from dibs.live import router as live_router
from dibs.routes import router
from dibs.settlement_routes import router as settlement_router

app = FastAPI(title="Dibs API")
app.include_router(router)
app.include_router(draft_router)
app.include_router(live_router)
app.include_router(settlement_router)


@app.get("/health")
def health() -> dict[str, str]:
    """Liveness check used by Docker, load balancers, and uptime monitors."""
    return {"status": "ok"}
