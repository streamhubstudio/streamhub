# StreamHub LPR worker — CPU image.
#
# Runs one worker per app/room, reading the app's HLS stream (or an RTSP
# camera via LPR_SOURCE) and emitting plate events to the framework channels
# / direct callback. For GPU, install fast-alpr[gpu] on an nvidia/cuda base
# and run with `--gpus all` + LPR_DEVICE=cuda.
FROM python:3.11-slim

# ffmpeg/libs OpenCV needs to decode HLS/RTSP.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libglib2.0-0 libgl1 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY lpr_worker ./lpr_worker

# Pre-cache the default ONNX models (detector + OCR) so the first frame isn't
# blocked on a download. Best-effort: an offline build still succeeds.
ENV LPR_MODEL_DIR=/models
RUN python -c "from lpr_worker.alpr import PlateReader; \
from lpr_worker.config import DEFAULT_DETECTOR, DEFAULT_OCR_MODEL; \
PlateReader(DEFAULT_DETECTOR, DEFAULT_OCR_MODEL, model_dir='/models')._ensure()" || true

ENV PYTHONUNBUFFERED=1
# Config is passed via LPR_* env at run time (see README).
ENTRYPOINT ["python", "-m", "lpr_worker"]
