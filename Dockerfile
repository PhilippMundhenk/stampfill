# syntax=docker/dockerfile:1
# Dependencies are installed on the build platform (not under QEMU emulation when cross-building for
# arm64): every runtime dependency is pure JavaScript, so node_modules is identical on all platforms.
FROM --platform=$BUILDPLATFORM node:26-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:26-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a
LABEL org.opencontainers.image.title="stampfill" \
      org.opencontainers.image.description="Stamp text onto PDF templates from a web form, then print or download the result" \
      org.opencontainers.image.source="https://github.com/PhilippMundhenk/stampfill" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production DATA_DIR=/data PORT=8080 HOST=0.0.0.0
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json stampfill.js LICENSE ./
COPY locales/ ./locales/
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "stampfill.js"]
