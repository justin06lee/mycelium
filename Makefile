PREFIX ?= $(HOME)/.local
BIN := bin/myc

.PHONY: all build install update deps test

all: build install

build: deps
	bun run build

install:
	@test -f $(BIN) || $(MAKE) build
	mkdir -p $(PREFIX)/bin
	cp $(BIN) $(PREFIX)/bin/myc
	@echo "installed $(PREFIX)/bin/myc"

# No daemons to stop: a fresh binary replaces the old one.
update:
	rm -f $(PREFIX)/bin/myc $(BIN)
	$(MAKE) build install

deps:
	bun install

test: deps
	bun run typecheck
	bun test
