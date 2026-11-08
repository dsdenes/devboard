# The Devboard harness runs as one native binary. The client is embedded at
# compile time, so the build stage needs only the Rust toolchain and the image
# carries no Node, Bun, or npm.
FROM rust:1.88-bookworm AS build

WORKDIR /src

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY omp ./omp
COPY prompts ./prompts
COPY templates ./templates
RUN cargo build --release -p devboard

FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/target/release/devboard /usr/local/bin/devboard
RUN mkdir -p /data /repo/adrs

ENV HOST=0.0.0.0
ENV PORT=8080
ENV ADRS_DIR=/repo/adrs
ENV STATE_DIR=/data

EXPOSE 8080

ENTRYPOINT ["devboard", "serve"]
