# StreamHub Vision Edge runtime — CPU image.
#
# One image, two run modes (see README):
#   worker : python -m vision_edge --model <m> --app <a> --room <r>   (VISION_* env)
#   edge   : python -m vision_edge --edge                             (STREAMHUB_* env)
# For GPU, swap the base for an nvidia/cuda image, install the CUDA torch wheels
# and run with `--gpus all` + VISION_DEVICE=cuda. The local demography engine
# additionally needs the [demography] extra (insightface + onnxruntime).
FROM python:3.11-slim

# ffmpeg/libs OpenCV needs to decode HLS/RTSP.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libglib2.0-0 libgl1 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU-only torch wheels first (keeps the image from pulling CUDA).
RUN pip install --no-cache-dir \
        torch torchvision --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY vision_edge ./vision_edge

# Pre-cache the nano weights so the first frame isn't blocked on a download.
RUN python -c "from ultralytics import YOLO; YOLO('yolo11n.pt')" || true

ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "-m", "vision_edge"]
