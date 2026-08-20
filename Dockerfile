# Helios — one image, one process, one port.
#
# The frontend is built in a node stage and the assets are copied into the
# Python image, which serves both the API and the app. Splitting them into two
# services buys nothing for a demo and adds a reverse proxy, a second port and a
# CORS configuration to get wrong in a conference room.

# ── stage 1: build the frontend ──────────────────────────────────────────────
FROM node:20-slim AS web
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ── stage 2: the application ─────────────────────────────────────────────────
FROM python:3.12-slim AS app
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Build tools are needed for the scientific stack's optional C extensions and are
# removed in the same layer so they do not ship.
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential \
 && rm -rf /var/lib/apt/lists/*

COPY backend/pyproject.toml ./backend/
RUN pip install --upgrade pip \
 && pip install "fastapi>=0.115" "uvicorn[standard]>=0.32" "pandas>=2.2,<3" \
      "numpy>=1.26" "scipy>=1.13" "statsmodels>=0.14" "scikit-learn>=1.5" \
      "pyarrow>=17" "python-multipart>=0.0.12" "httpx>=0.27" "optbinning>=0.19" \
 && apt-get purge -y build-essential && apt-get autoremove -y

COPY backend/ ./backend/
COPY data/ ./data/
COPY versions/ ./versions/
COPY --from=web /build/dist ./frontend/dist

# The synthetic panels are gitignored, so generate them at build time. This keeps
# the image self-contained: it starts with no network and no configuration.
RUN cd backend && python -m helios.data.build

ENV PYTHONPATH=/app/backend
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import httpx,sys; sys.exit(0 if httpx.get('http://127.0.0.1:8000/api/health',timeout=4).status_code==200 else 1)"

CMD ["uvicorn", "helios.api.main:app", "--host", "0.0.0.0", "--port", "8000", \
     "--app-dir", "/app/backend"]
