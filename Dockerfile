# Resmi ve hafif OpenJDK 17 çalışma ortamı
FROM eclipse-temurin:17-jre-alpine

# Çalışma dizini
WORKDIR /app

# server.jar dosyasını kopyala
COPY server.jar /app/

# Varsayılan port tanımı
ENV PORT=3000
EXPOSE 3000

# Sunucuyu 512MB RAM limitiyle başlat (Render ücretsiz paketine tam uyumlu)
CMD ["java", "-Xmx512M", "-Xms256M", "-jar", "server.jar"]
