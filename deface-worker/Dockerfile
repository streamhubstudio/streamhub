# StreamHub deface worker — CPU image.
#
# Runs one worker per app/room, reading the app's HLS stream and POSTing face
# boxes to the callback / live-data channel. For GPU, swap onnxruntime for
# onnxruntime-gpu on an nvidia/cuda base and run with `--gpus all` +
# DEFACE_EXECUTION_PROVIDER=cuda.
FROM python:3.11-slim

# ffmpeg/libs OpenCV needs to decode HLS.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libglib2.0-0 libgl1 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY deface_worker ./deface_worker

# Pre-cache centerface.onnx so the first frame isn't blocked on a download.
ENV DEFACE_MODEL_DIR=/models
RUN python -c "from deface_worker.centerface import ensure_model; \
from deface_worker.config import DEFAULT_MODEL_URL; \
ensure_model('/models', DEFAULT_MODEL_URL)" || true

ENV PYTHONUNBUFFERED=1
# Config is passed via DEFACE_* env at run time (see README).
ENTRYPOINT ["python", "-m", "deface_worker"]
