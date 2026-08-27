# Spring Boot Video SDK RTMS webhook and media receiver.
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /src
COPY video-sdk/vsdk_working_java/pom.xml ./
RUN touch .env && mvn -B dependency:go-offline
COPY video-sdk/vsdk_working_java ./
RUN touch .env && mvn -B -DskipTests package

FROM eclipse-temurin:17-jre-jammy AS runtime
RUN useradd --system --uid 10001 --create-home appuser
WORKDIR /app
COPY --from=build /src/target/*.jar /app/app.jar
USER appuser
EXPOSE 3000
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
