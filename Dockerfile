# One container: browser-lite-server (Wisp relay + packaged demo + browser profile in /data).
# Build first: npm ci && npm run build, and the demo: tools/package-demo.sh <engine-dir> build/demo
# HTTPS comes from in front (browsers only grant SharedArrayBuffer in a secure context).
# Build: docker build --build-arg NODE_IMAGE="$(grep '^NODE_IMAGE=' versions.env | cut -d= -f2)" .
ARG NODE_IMAGE
FROM ${NODE_IMAGE}
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/server/package.json packages/server/
RUN npm ci --omit=dev -w @browser-lite/server --no-audit --no-fund
COPY packages/server/dist packages/server/dist
COPY build/demo /app/site
RUN mkdir -p /data && chown node:node /data
ENV PORT=8080 SITE_DIR=/app/site PROFILE_DIR=/data NODE_ENV=production
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "packages/server/dist/bin/browser-lite-server.js"]
