# C++ Zoom event WebSocket and RTMS receiver.
FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends cmake g++ libboost-system-dev libcurl4-openssl-dev libssl-dev make && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY boilerplate/working_cplusplus_wss ./
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --parallel

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libboost-system1.74.0 libcurl4 libssl3 && rm -rf /var/lib/apt/lists/* && useradd --system --uid 10001 --create-home appuser
WORKDIR /app
COPY --from=build /src/bin/ZoomWebSocketClient /app/ZoomWebSocketClient
USER appuser
ENTRYPOINT ["/app/ZoomWebSocketClient"]
