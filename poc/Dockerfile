# Runs the G-pass benchmark against a synthetic FluxOS fleet.
# The "before" side is a checkout of the base commit mounted at /before, so the
# comparison is against committed code rather than a re-description of it.
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts || npm install --omit=dev --ignore-scripts
COPY . .
CMD ["node", "poc/fleet.js"]
