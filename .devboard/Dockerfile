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

# The dashboard runs every git-backed action — a flow checkpoint, a goal
# commit, the commit gate, publish — by spawning `git` by name, so the runtime
# stage ships it. The agent CLI stays the operator's: mount it and name it in
# AGENT_COMMAND (default `omp acp`), because `serve` refuses to start, naming
# the program, when the image cannot resolve an executable it could spawn.
# The container runs as root while the documented `-v "$PWD:/repo"` mount is
# owned by the host user, and git refuses a repository owned by another user, so
# the image trusts the mounted repository; without this every git-backed action
# fails with "dubious ownership".
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && git config --system --add safe.directory '*' \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/target/release/devboard /usr/local/bin/devboard
RUN mkdir -p /data /repo/adrs

ENV HOST=0.0.0.0
ENV PORT=8080
ENV ADRS_DIR=/repo/adrs
ENV STATE_DIR=/data

EXPOSE 8080

ENTRYPOINT ["devboard", "serve"]
