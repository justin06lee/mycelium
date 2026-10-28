PREFIX ?= $(HOME)/.local
BIN := bin/myc

.PHONY: all build install update deps test grammars

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

# The Swift grammar is committed prebuilt: its npm package ships no wasm. This rebuilds it, patched, with the
# tree-sitter CLI (brew install tree-sitter-cli), which fetches its own wasi-sdk on first use.
SWIFT_GRAMMAR ?= 0.7.1
grammars:
	rm -rf .grammar-build && mkdir -p .grammar-build
	curl -fsSL "$$(bun pm view tree-sitter-swift@$(SWIFT_GRAMMAR) dist.tarball)" | tar xz -C .grammar-build
	# 0.7.1's scanner allocates its state with calloc(0, …); in wasm that state leaks from one parse into the next.
	sed -i.orig 's/calloc(0, sizeof(struct ScannerState))/calloc(1, sizeof(struct ScannerState))/' .grammar-build/package/src/scanner.c
	cd .grammar-build/package && tree-sitter build --wasm -o ../../grammars/tree-sitter-swift.wasm .
	rm -rf .grammar-build
