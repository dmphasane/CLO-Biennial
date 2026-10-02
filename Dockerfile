# NEDLO Stokvel Fund — Node backend
FROM node:20-slim

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm install

# Copy the rest of the app
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
