# Production image: the Rust server serving the built site and proxying
# tiles/search through Redis (set REDIS_URL; without it, a plain proxy).

# 1. The site (static files; the wasm kernel is committed, so no Rust here)
FROM node:22-bookworm-slim AS site
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Public origin for canonical / share-image URLs, e.g. --build-arg SITE_URL=https://example.com
ARG SITE_URL
ENV SITE_URL=${SITE_URL}
# Google Analytics (GA4) measurement ID, e.g. G-XXXXXXXXXX; unset = no analytics.
ARG GA_ID
ENV GA_ID=${GA_ID}
RUN npm run build

# 2. The server
FROM rust:1-slim-bookworm AS server
WORKDIR /src
COPY crates/server ./
RUN cargo build --release

# 3. Runtime
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server /src/target/release/topography-server /usr/local/bin/topography-server
COPY --from=site /app/dist ./dist
ENV STATIC_DIR=/app/dist
# Railway (and most hosts) provide PORT; the server listens on 0.0.0.0:$PORT.
CMD ["topography-server"]
