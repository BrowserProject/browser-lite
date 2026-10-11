FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs ./
USER node
EXPOSE 5001
CMD ["node", "server.mjs"]
