# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/package.json
COPY packages/dashboard/package.json packages/dashboard/package.json
COPY packages/sdk-node/package.json packages/sdk-node/package.json
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run db:generate --workspace=packages/api
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/package.json
COPY packages/dashboard/package.json packages/dashboard/package.json
COPY packages/sdk-node/package.json packages/sdk-node/package.json
RUN npm ci

COPY --from=build /app/packages/api/dist ./packages/api/dist
COPY --from=build /app/packages/dashboard/dist ./packages/dashboard/dist
COPY --from=build /app/packages/api/prisma ./packages/api/prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/live').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["sh", "-c", "npm exec --workspace=packages/api prisma migrate deploy && node packages/api/dist/index.js"]
