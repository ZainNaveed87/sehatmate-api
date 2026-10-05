FROM python:3.12.14-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 OTEL_SDK_DISABLED=true
RUN apt-get update && apt-get install -y --no-install-recommends libportaudio2 libstdc++6 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 voice
WORKDIR /app
COPY requirements.lock.txt .
RUN pip install --no-cache-dir --disable-pip-version-check --only-binary=:all: -r requirements.lock.txt \
    && pip check \
    && python -c "import av; from livekit import rtc; import livekit.agents; import livekit.plugins.deepgram"
COPY sehatmate_voice/ ./sehatmate_voice/
COPY worker.py .
USER voice
EXPOSE 8081
HEALTHCHECK --interval=15s --timeout=3s --start-period=45s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8081/', timeout=2).close()" || exit 1
CMD ["python", "worker.py", "start"]
