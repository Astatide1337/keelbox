FROM golang:1.25-alpine AS build
WORKDIR /src
COPY main.go message.txt ./
RUN CGO_ENABLED=0 go build -trimpath -o /hello main.go

FROM busybox:1.37.0
COPY --from=build /hello /hello
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/hello"]
