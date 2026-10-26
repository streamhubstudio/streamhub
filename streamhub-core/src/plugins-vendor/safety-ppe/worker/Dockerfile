# StreamHub safety-ppe worker — CPU image.
#
# Runs one worker per app/room, reading the app's HLS stream and recording
# PPE violations (SQLite + evidence JPEGs + signed webhook). For GPU, swap
# onnxruntime for onnxruntime-gpu on an nvidia/cuda base and run with
# `--gpus all` + SAFETY_PPE_EXECUTION_PROVIDER=cuda.
FROM python:3.11-slim

# ffmpeg/libs OpenCV needs to decode HLS.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libglib2.0-0 libgl1 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY safety_ppe_worker ./safety_ppe_worker

# Optionally pre-cache the ~100 MB ONNX model at build time so the first frame
# isn't blocked on a download (adds the model to the image):
#   docker build --build-arg PRELOAD_MODEL=1 -t streamhub-safety-ppe .
ARG PRELOAD_MODEL=0
ENV SAFETY_PPE_MODEL_DIR=/models
RUN if [ "$PRELOAD_MODEL" = "1" ]; then \
      python -c "from safety_ppe_worker.detector import ensure_model; \
from safety_ppe_worker.config import DEFAULT_MODEL_URL; \
ensure_model('/models', DEFAULT_MODEL_URL)"; \
    fi

ENV PYTHONUNBUFFERED=1
# Config is passed via SAFETY_PPE_* env at run time (see README).
ENTRYPOINT ["python", "-m", "safety_ppe_worker"]
