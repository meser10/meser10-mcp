# MCP server image for @meser10/mcp-server.
# Speaks MCP over stdio, so run it with:  docker run -i --rm <image>
# Credentials are supplied at run time, never baked in:
#   docker run -i --rm -e MESER10_API_KEY=... -e MESER10_USER_ID=... <image>

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Default to the safest mode. Override with -e MESER10_MODE=write|send|destructive.
ENV MESER10_MODE=read
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
ENTRYPOINT ["node", "dist/index.js"]
