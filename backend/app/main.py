"""Native-client backend boundary.

This app is intentionally additive. ``api/main.py`` remains the compatibility
service until each feature has migrated behind these versioned routes.
"""

from fastapi import FastAPI

from backend.app.api.realtime_tokens import router as realtime_router

app = FastAPI(title="Setu mobile backend", version="0.1.0")
app.include_router(realtime_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "mobile-backend-boundary"}
