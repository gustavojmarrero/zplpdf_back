FROM node:18-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --legacy-peer-deps

COPY . .
RUN npm run build

EXPOSE 8080
CMD [ "npm", "run", "start:prod" ]