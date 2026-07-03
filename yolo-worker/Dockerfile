# StreamHub YOLO worker — CPU image.
#
# Runs one worker per app/room, reading the app's HLS stream and POSTing
# detections to a callback URL. For GPU, swap the base for an nvidia/cuda image
# + install the CUDA torch wheels, and run with `--gpus all` + YOLO_DEVICE=cuda.
FROM python:3.11-slim

# ffmpeg/libs OpenCV needs to decode HLS; curl for the HEALTHCHECK.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libglib2.0-0 libgl1 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU-only torch wheels first (keeps the image from pulling CUDA).
RUN pip install --no-cache-dir \
        torch torchvision --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY yolo_worker ./yolo_worker

# Pre-cache the nano weights so the first frame isn't blocked on a download.
RUN python -c "from ultralytics import YOLO; YOLO('yolov8n.pt')" || true

ENV PYTHONUNBUFFERED=1
# Config is passed via YOLO_* env at run time (see README).
ENTRYPOINT ["python", "-m", "yolo_worker"]
