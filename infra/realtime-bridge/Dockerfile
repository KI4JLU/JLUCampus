# The live transcription bridge: browser WebRTC to the gateway's realtime WebSocket (see
# README.md). Ported from HAWKI's realtime bridge (GNU GPL v3).
#   docker build -t justcampus-realtime-bridge infra/realtime-bridge
#   docker build --network host -t justcampus-realtime-bridge infra/realtime-bridge  # no bridge NAT
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
  && useradd --system --uid 10001 --no-create-home bridge

COPY bridge.py .

USER bridge

# WebRTC media needs UDP on ephemeral ports; run with network_mode: host.
EXPOSE 8089

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
    CMD python -c "import urllib.request,os; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\", \"8089\")}/health', timeout=3)"

CMD ["python", "bridge.py"]
