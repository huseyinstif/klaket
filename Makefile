# Klaket — developer shortcuts (docker compose is the only requirement)

.PHONY: up down rebuild logs e2e test test-api test-worker clean

up:            ## Start the full stack (API :8484, dashboard :5180)
	docker compose up -d --build

down:          ## Stop everything
	docker compose down

rebuild:       ## Rebuild images from scratch and restart
	docker compose build --no-cache && docker compose up -d

logs:          ## Tail all service logs
	docker compose logs -f

e2e:           ## Run the 20-check end-to-end smoke test (stack must be up)
	bash scripts/e2e.sh

test: test-api test-worker  ## Run all unit tests

test-api:      ## Go API unit tests
	docker run --rm -v "$(CURDIR)/apps/api:/app" -w /app golang:1.23-alpine go test ./...

test-worker:   ## Python worker unit tests
	docker run --rm -v "$(CURDIR)/apps/worker:/app" -w /app python:3.12-slim \
		sh -c "pip install -q pytest && python -m pytest tests/ -q"

clean:         ## Stop and remove volumes (deletes processed job data!)
	docker compose down -v

help:          ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'
