FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN go mod tidy && CGO_ENABLED=0 go build -ldflags="-s -w" -o /klaket-api .

FROM alpine:3.20
RUN adduser -D klaket
USER klaket
COPY --from=build /klaket-api /usr/local/bin/klaket-api
EXPOSE 8484
ENTRYPOINT ["klaket-api"]
