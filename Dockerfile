FROM node:20-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --legacy-peer-deps
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
