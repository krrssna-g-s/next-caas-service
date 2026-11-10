# Node 22.5+ is required for the built-in SQLite module (node:sqlite); Node 26 is the current LTS.
FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json yarn.lock ./
RUN npm install -g yarn@1.22.22 && yarn install --frozen-lockfile

FROM node:26-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install -g yarn@1.22.22 && yarn build

FROM node:26-alpine AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    CAAS_DATA_DIR=/data \
    CAAS_SEED_DIR=/app/content-seed

COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
# Seed content is read from disk at runtime, so it is copied explicitly.
COPY --from=build --chown=node:node /app/content-seed ./content-seed
# New Relic agent defaults (no secrets); the agent reads it from the working directory.
COPY --from=build --chown=node:node /app/newrelic.js ./newrelic.js

# The embedded database lives here. In EKS this is the pod's own volume.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000
CMD ["node", "server.js"]
