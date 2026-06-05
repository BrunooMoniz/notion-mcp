# notion-mcp — container image.
#
# Single stage on node:22-slim. We intentionally KEEP devDependencies in the
# image: `npm run migrate` and `npm run reindex` run through `tsx` (a devDep),
# so omitting dev deps would break those flows. The compiled server itself runs
# from dist/ (plain node).
FROM node:22-slim

WORKDIR /app

# Install deps first (better layer caching). Keep devDeps — tsx is needed at
# runtime for `npm run migrate` / `npm run reindex`.
COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the source and build TypeScript -> dist/.
COPY . .
RUN npm run build

EXPOSE 3456

# Default process is the MCP server. The indexer/classifier/migrate services
# override this with their own `command` in docker-compose.yml.
CMD ["node", "dist/index.js"]
