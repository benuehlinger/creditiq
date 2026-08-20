# Helios — KPMG credit risk model development platform
.DEFAULT_GOAL := help
PY := backend/.venv/bin/python
PIP := uv pip install --python backend/.venv/bin/python

.PHONY: help setup data fred test lint dev backend frontend clean reset

help:  ## show this help
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n",$$1,$$2}'

setup:  ## create the venv and install everything
	uv venv --python 3.12 backend/.venv
	$(PIP) -e "backend[binning,dev]"
	cd frontend && npm install

fred:  ## refresh the committed FRED cache (needs network; the app does not)
	$(PY) -m helios.mev.fred_cache

data:  ## regenerate every synthetic panel, deterministically
	cd backend && .venv/bin/python -m helios.data.build

test:  ## run the backend test suite
	cd backend && .venv/bin/python -m pytest tests -q

lint:
	cd backend && .venv/bin/ruff check helios tests

dev:  ## run backend and frontend together
	@echo "starting Helios..."
	@$(MAKE) -j2 backend frontend

backend:
	cd backend && .venv/bin/uvicorn helios.api.main:app --reload --port 8000

frontend:
	cd frontend && npm run dev

reset:  ## restore a clean demo state (safe to run between demos)
	rm -rf versions/*.json
	cd backend && .venv/bin/python -m helios.data.build

clean:
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
	rm -rf backend/.pytest_cache backend/.ruff_cache
