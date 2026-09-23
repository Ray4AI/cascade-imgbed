FROM node:22-alpine

RUN apk add --no-cache su-exec

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3080 \
    HOST=0.0.0.0

RUN mkdir -p /data/images

EXPOSE 3080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3080/healthz || exit 1

# entrypoint fixes /data ownership then drops to user 'node'
ENTRYPOINT ["/app/entrypoint.sh"]
