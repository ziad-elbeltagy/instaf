# ---- Base Stage ----
FROM node:20-alpine AS base

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# ---- Dependencies Stage ----
FROM base AS dependencies

# Install dependencies
RUN npm install --only=production

# ---- Release Stage ----
FROM base AS release

# Set Node environment to production
ENV NODE_ENV=production


# Copy dependencies from the 'dependencies' stage
COPY --from=dependencies /usr/src/app/node_modules ./node_modules

# Copy the rest of your application code
COPY . .


CMD [ "node", "bot.js" ]
