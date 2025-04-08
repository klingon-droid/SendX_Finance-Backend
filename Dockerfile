FROM node:18-slim

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy the rest of the application
COPY . .

# Create dist directory
RUN mkdir -p dist

# Build TypeScript files
RUN npm run build

# Start the application from the dist directory
CMD ["node", "dist/samplebot.js"] 