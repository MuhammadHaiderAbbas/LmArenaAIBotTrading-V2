.PHONY: up down logs admin backend-install backend-test backend-dev migrate frontend-install frontend-dev frontend-build e2e lint

up:                ## Full stack in Docker -> http://localhost:8080
	docker compose up -d --build
down:
	docker compose down
logs:
	docker compose logs -f backend web
admin:             ## make admin EMAIL=you@example.com
	docker compose exec backend python -m app.cli create-admin --email $(EMAIL)

backend-install:
	cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
migrate:
	cd backend && .venv/bin/alembic upgrade head
backend-dev:
	cd backend && .venv/bin/uvicorn app.main:app --reload --port 8000
backend-test:
	cd backend && .venv/bin/ruff check . && .venv/bin/pytest -q

frontend-install:
	cd frontend && npm ci
frontend-dev:
	cd frontend && npm run dev
frontend-build:
	cd frontend && npm run build
e2e:             ## Build the production bundle, then run Playwright against vite preview
	cd frontend && npm run e2e

lint: backend-test frontend-build
