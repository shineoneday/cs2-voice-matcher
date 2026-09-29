FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src
COPY *.csproj .
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:9.0
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends zstd curl && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /data /app/uploads /app/models
RUN curl -L -o /app/models/speaker_model.onnx https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM/resolve/main/voxceleb_resnet34_LM.onnx
COPY --from=build /app .
EXPOSE 8080
ENV ASPNETCORE_URLS=http://+:8080
ENV DB_PATH=/data/voiceprints.db
ENV SPEAKER_MODEL_PATH=/app/models/speaker_model.onnx
ENTRYPOINT ["dotnet", "cs2-voice-matcher.dll"]
