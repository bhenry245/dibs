from fastapi import FastAPI

from dibs.routes import router

app = FastAPI(title="Dibs API")
app.include_router(router)


@app.get("/health")
def health() -> dict[str, str]:
    """Liveness check used by Docker, load balancers, and uptime monitors."""
    return {"status": "ok"}
