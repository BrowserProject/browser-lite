# One container: Wisp relay + built site + browser profile in /data (relay/server.mjs).
# Build the site first: tools/package-site.sh <engine-dir> build/site
# HTTPS comes from in front (browsers only grant SharedArrayBuffer in a secure context).
# Build: docker build --build-arg NODE_IMAGE="$(grep '^NODE_IMAGE=' versions.env | cut -d= -f2)" .
ARG NODE_IMAGE
FROM ${NODE_IMAGE}
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY relay/package.json relay/
RUN npm ci --omit=dev -w relay --no-audit --no-fund
COPY relay/*.mjs relay/
COPY build/site /app/site
RUN mkdir -p /data && chown node:node /data
ENV PORT=8080 SITE_DIR=/app/site PROFILE_DIR=/data NODE_ENV=production
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "relay/server.mjs"]
