FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY klaket_worker ./klaket_worker

# faster-whisper model cache lives on a volume so models download once.
ENV HF_HOME=/models
# Argos Translate packages persist on the same volume.
ENV XDG_DATA_HOME=/models

ENTRYPOINT ["python", "-m", "klaket_worker"]
