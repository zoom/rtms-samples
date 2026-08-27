# Go webhook and RTMS WebSocket receiver.
FROM golang:1.24-bookworm AS build
WORKDIR /src
COPY boilerplate/working_go/go.mod boilerplate/working_go/go.sum ./
RUN go mod download
COPY boilerplate/working_go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/rtms-sample .

FROM gcr.io/distroless/static-debian12:nonroot AS runtime
WORKDIR /app
COPY --from=build /out/rtms-sample /app/rtms-sample
EXPOSE 3000
ENTRYPOINT ["/app/rtms-sample"]
