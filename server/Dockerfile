# syntax=docker/dockerfile:1
#
# The control plane is a plain web service: it issues no commands, opens no
# interface and holds no capabilities. That is what makes it a good fit for a
# container — there is nothing here that wants the host.
#
#   docker compose build api
#   docker compose up -d

# --- build -------------------------------------------------------------------
# better-sqlite3 compiles against the Node headers, so the toolchain has to be
# present while installing and gone afterwards.
#
# Both stages sit on the same bookworm base deliberately. The .node file this
# produces is linked against glibc, and moving it to an Alpine/musl runtime
# fails at require() time rather than at build time — the error names a symbol,
# not the mistake.
FROM node:24-bookworm-slim AS build
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Copied before the sources so a source edit does not re-run the install.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# A second clean install rather than `npm prune --omit=dev`: prune leaves the
# build's leftovers in the tree, and the runtime image should carry exactly the
# production dependency set and nothing else.
RUN rm -rf node_modules && npm ci --omit=dev


# --- runtime -----------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    DATABASE_PATH=/data/vpn.db

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# Kept so `docker compose exec api node scripts/add-node.mjs` works; the script
# imports from ../dist, which is already built above.
COPY scripts ./scripts

# The database is the only thing this service writes. Creating the directory
# here, owned by `node`, is what makes a fresh *named* volume come up writable:
# Docker seeds a new named volume from the image path, ownership included.
# A bind mount gets no such treatment — chown it to uid 1000 on the host first,
# or the first write fails with SQLITE_CANTOPEN.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000

# A slim image has no curl, and installing one only to poll a health endpoint
# is a poor trade. Node 24 has fetch built in.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Not `npm start`: npm would sit between Docker and Node as PID 1 and swallow
# SIGTERM, so every stop would wait out the timeout and then get killed —
# which for SQLite means being cut off mid-checkpoint.
CMD ["node", "dist/index.js"]
