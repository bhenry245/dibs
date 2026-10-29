from fastapi import FastAPI

app = FastAPI(title="Dibs API")


@app.get("/health")
def health() -> dict[str, str]:
    """Liveness check used by Docker, load balancers, and uptime monitors."""
    return {"status": "ok"}
