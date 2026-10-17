# Ein Container: Wisp-Relay + fertige Seite + Browser-Profil in /data (relay/server.mjs).
# Vorher die Seite bauen: tools/package-site.sh <engine-ordner> build/site
# HTTPS kommt von davor (Browser geben SharedArrayBuffer nur in einem sicheren Kontext).
# Bauen: docker build --build-arg NODE_IMAGE="$(grep '^NODE_IMAGE=' versions.env | cut -d= -f2)" .
ARG NODE_IMAGE
FROM ${NODE_IMAGE}
WORKDIR /app
COPY relay/package.json relay/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY relay/*.mjs ./
COPY build/site /app/site
RUN mkdir -p /data && chown node:node /data
ENV PORT=8080 SITE_DIR=/app/site PROFILE_DIR=/data NODE_ENV=production
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.mjs"]
