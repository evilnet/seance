# soju for Seance's soju.im/bouncer-networks work; see run.sh.
FROM golang:1.27-alpine AS build
RUN apk add --no-cache git gcc musl-dev sqlite-dev
ARG SOJU_REF=master
RUN git clone --depth 1 --branch "$SOJU_REF" https://codeberg.org/emersion/soju.git /src
WORKDIR /src
RUN go build -tags libsqlite3 -o /out/ ./cmd/soju ./cmd/sojudb ./cmd/sojuctl

FROM alpine
RUN apk add --no-cache sqlite-libs ca-certificates
COPY --from=build /out/ /usr/local/bin/
ENTRYPOINT ["soju"]
