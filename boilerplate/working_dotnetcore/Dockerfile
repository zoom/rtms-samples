# ASP.NET Core webhook and RTMS WebSocket receiver.
FROM mcr.microsoft.com/dotnet/sdk:7.0 AS build
WORKDIR /src
COPY boilerplate/working_dotnetcore/rtms-sample.csproj ./
RUN dotnet restore
COPY boilerplate/working_dotnetcore ./
RUN dotnet publish rtms-sample.csproj -c Release -o /out --no-restore /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:7.0 AS runtime
ENV ASPNETCORE_URLS=http://+:3000
RUN useradd --system --uid 10001 --create-home appuser
WORKDIR /app
COPY --from=build /out ./
USER appuser
EXPOSE 3000
ENTRYPOINT ["dotnet", "rtms-sample.dll"]
