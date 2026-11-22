# La imagen oficial de Playwright trae Chromium y sus dependencias del sistema.
# Mantener la versión alineada con "playwright" de package.json.
FROM mcr.microsoft.com/playwright:v1.65.1-noble

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# Capturas de las ejecuciones: un volumen para que sobrevivan a un reinicio.
RUN mkdir -p /data && chown pwuser:pwuser /data
VOLUME /data
USER pwuser

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# Sin credenciales en la imagen: BOT_SERVICE_TOKEN, MB_BOT_USERNAME y MB_BOT_PASSWORD
# se pasan como variables de entorno al correrla.
CMD ["node", "src/index.js"]
