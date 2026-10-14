GO ?= go
LINT ?= golangci-lint
LINT_VERSION := 2.14.0

.PHONY: check build test lint fmt check-layout

check: check-layout lint test build

build:
	$(GO) build -o bin/keelbox ./cmd/keelbox

test:
	$(GO) test -race -count=1 ./...

lint:
	@test "$$($(LINT) version --short)" = "$(LINT_VERSION)" || { printf 'Install golangci-lint v%s; see README.md.\n' '$(LINT_VERSION)' >&2; exit 1; }
	$(LINT) config verify
	$(LINT) run ./...

fmt:
	$(LINT) fmt

check-layout:
	@test ! -e reports && test ! -e research_notes || { printf 'Keep research and generated reports outside the repository.\n' >&2; exit 1; }
