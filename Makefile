WASM     := src/wasm/contour.wasm
RUST_SRC := $(wildcard crates/contour/src/*.rs) crates/contour/Cargo.toml
WASM_OUT := crates/contour/target/wasm32-unknown-unknown/release/contour.wasm

.PHONY: dev build preview wasm clean

## dev: start the Vite dev server (installs deps / rebuilds wasm when needed)
dev: node_modules $(WASM)
	npx vite

## build: production build into dist/
build: node_modules $(WASM)
	npm run build

## preview: serve the production build
preview: build
	npx vite preview

## wasm: rebuild the Rust contour kernel
wasm: $(WASM)

# Only touches Rust when the source is newer than the committed .wasm; without
# cargo it falls back to the committed artifact.
$(WASM): $(RUST_SRC)
	@if command -v cargo >/dev/null 2>&1; then \
	  cargo build --release --target wasm32-unknown-unknown --manifest-path crates/contour/Cargo.toml && \
	  cp $(WASM_OUT) $@; \
	else \
	  echo "cargo not found; using committed $@"; touch $@; \
	fi

node_modules: package.json
	npm install
	@touch node_modules

clean:
	rm -rf dist crates/contour/target
