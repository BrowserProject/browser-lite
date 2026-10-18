# Images of browser-lite-server (packages/server), built and tested by tools/build-images.sh:
#   target server  the server alone: Wisp relay, /healthz, SITE_DIR and PROFILE_DIR optional
#   target demo    the server with the packaged demo (build context "site") and the browser
#                  profile in /data
# Build first: npm ci && npm run build, and for demo the site: tools/package-demo.sh.
# HTTPS comes from in front (browsers only grant SharedArrayBuffer in a secure context).
ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS server
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/server/package.json packages/server/
RUN npm ci --omit=dev -w @browser-lite/server --no-audit --no-fund
COPY packages/server/dist packages/server/dist
COPY LICENSE ./
ENV PORT=8080 NODE_ENV=production
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "packages/server/dist/bin/browser-lite-server.js"]

FROM server AS demo
USER root
RUN mkdir -p /data && chown node:node /data
USER node
COPY --from=site . /app/site
ENV SITE_DIR=/app/site PROFILE_DIR=/data
