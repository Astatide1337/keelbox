GO ?= go
LINT ?= golangci-lint
ifeq ($(origin LINT),default)
LINT := golangci-lint
endif
LINT_VERSION := $(shell cat .golangci-version)
VULN_VERSION := $(shell cat .govulncheck-version)
FUZZ_TIME ?= 10s
GO_BIN := $(shell command -v "$(GO)" 2>/dev/null)
ifneq ($(GO_BIN),)
export PATH := $(dir $(GO_BIN)):$(PATH)
endif

.PHONY: check build test fuzz audit lint lint-version check-policy fmt check-layout

check: check-layout lint check-policy test build

build: check-layout
	$(GO) build -o bin/keelbox ./cmd/keelbox

test: check-layout
	$(GO) test -race -count=1 ./...

fuzz: check-layout
	$(GO) test ./internal/keelbox -run='^$$' -fuzz='^FuzzConfig$$' -fuzztime=$(FUZZ_TIME) -parallel=2
	$(GO) test ./internal/keelbox -run='^$$' -fuzz='^FuzzResourceMetadata$$' -fuzztime=$(FUZZ_TIME) -parallel=2

audit: check-layout
	$(GO) run golang.org/x/vuln/cmd/govulncheck@v$(VULN_VERSION) -test ./...

lint-version: check-layout
	@test "$$($(LINT) version --short)" = "$(LINT_VERSION)" || { printf 'Install golangci-lint v%s; see README.md.\n' '$(LINT_VERSION)' >&2; exit 1; }

lint: lint-version
	$(LINT) config verify
	$(LINT) run ./...

check-policy: lint-version
	$(GO) run ./tools/check-policy -lint "$(LINT)"

fmt: lint-version
	$(LINT) fmt

check-layout:
	@test ! -e reports && test ! -L reports && test ! -e research_notes && test ! -L research_notes || { printf 'Keep research and generated reports outside the repository.\n' >&2; exit 1; }
	@links="$$(find cmd internal tools $(wildcard examples) -type l -print)" || exit $$?; \
	test -z "$$links" || { printf 'Source symlinks are forbidden:\n%s\n' "$$links" >&2; exit 1; }
