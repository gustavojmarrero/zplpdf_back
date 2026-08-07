# Node 22 LTS. NestJS 11 exige Node >= 20, así que la 18 anterior dejó de ser
# viable con esta actualización — y llevaba en EOL desde abril de 2025.
FROM node:22-slim

WORKDIR /app

COPY package*.json ./

# `ci` y no `install --legacy-peer-deps`. Esa bandera era lo que mantenía en pie
# una combinación que el propio paquete declaraba imposible —swagger 11 sobre
# NestJS 10—: silenciaba el conflicto en cada build de producción, y el problema
# solo salió a la luz cuando el CI intentó instalar de verdad. Con las versiones
# ya alineadas no hace falta, y `ci` instala exactamente el árbol del lockfile.
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 8080
CMD [ "npm", "run", "start:prod" ]
