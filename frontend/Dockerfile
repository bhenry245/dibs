# The web server as a production image. Build from frontend/.

# Stage 1: uses Node to build the React app into plain HTML, CSS and JavaScript files.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: only Caddy and the built files. Node and node_modules are left behind, so the final
# image is much smaller and has much less in it that could need a security patch.
FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
