"""Single-worker local service; bind address and port are deployment settings."""
import os
import sys
from pathlib import Path
import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parent / "backend"))

uvicorn.run(
    "api.index:app",
    host=os.getenv("INKSIGHT_BIND_HOST", "127.0.0.1"),
    port=int(os.getenv("INKSIGHT_BACKEND_PORT", "8080")),
    workers=1,
)
