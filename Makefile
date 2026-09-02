# CreditIQ — KPMG credit risk model development platform
.DEFAULT_GOAL := help
PY := backend/.venv/bin/python

DEPS := fastapi>=0.115 "uvicorn[standard]>=0.32" "pandas>=2.2,<3" numpy>=1.26 \
        scipy>=1.13 statsmodels>=0.14 scikit-learn>=1.5 pyarrow>=17 \
        python-multipart httpx optbinning>=0.19 pytest ruff

.PHONY: help setup data fred test lint dev backend frontend reset clean

help:  ## show this help
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) \
	 | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n",$$1,$$2}'

setup:  ## one time: create the venv, install dependencies, build the panels
	uv venv --python 3.12 backend/.venv
	uv pip install --python $(PY) $(DEPS)
	cd frontend && npm install
	$(MAKE) data

fred:  ## refresh the committed FRED cache (needs network; the app does not)
	cd backend && .venv/bin/python -m creditiq.mev.fred_cache

data:  ## regenerate every synthetic panel, deterministically
	cd backend && .venv/bin/python -m creditiq.data.build

test:  ## backend test suite
	cd backend && .venv/bin/python -m pytest tests -q

lint:
	cd backend && .venv/bin/ruff check creditiq tests || true
	cd frontend && ./node_modules/.bin/tsc -b --pretty false

dev:  ## run backend and frontend together
	@echo "CreditIQ starting — the API warms its caches for about 30 seconds."
	@$(MAKE) -j2 backend frontend

backend:
	cd backend && .venv/bin/uvicorn creditiq.api.main:app --reload --port 8000

frontend:
	cd frontend && npm run dev

reset:  ## clean demo state — safe to run between back-to-back demos
	rm -f versions/*.json
	rm -rf data/cache
	$(MAKE) data
	@echo "Demo state reset. Restart the backend to clear its caches."

clean:
	find . -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true
	rm -rf backend/.pytest_cache backend/.ruff_cache frontend/dist
