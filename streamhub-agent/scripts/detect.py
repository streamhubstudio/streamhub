#!/usr/bin/env python3
"""StreamHub Agent — edge detection worker (YOLO + ByteTrack, on-device).

Spawned by the C agent (src/detect_edge.c), ONE per camera, when a camera runs
in edge detection mode (detect.mode: edge). Reads the camera's RTSP feed, runs
inference on the device and writes annotated frames + detection events to the
filesystem. In remote/off mode this worker is never spawned, so its ML
dependencies (ultralytics, opencv) are only needed for edge deployments:

    pip install -r scripts/requirements.txt

Communication with the C agent is via files (no sockets):
  - <output_dir>/frame.jpg        — annotated JPEG (overwritten each cycle)
  - <output_dir>/detections.json  — latest detection events + line counts,
    in the same shape the agent exposes for remote mode, so the WebUI/MQTT
    consumers are identical regardless of mode.
"""

import argparse
import json
import os
import signal
import subprocess
import sys
import time

import cv2
from ultralytics import YOLO

try:
    import psutil  # optional: resource telemetry (cpu/mem). Not required.
except ImportError:
    psutil = None


def check_nvidia_smi():
    """Check if nvidia-smi is available (NVIDIA GPU present)."""
    try:
        subprocess.run(['nvidia-smi'], capture_output=True, timeout=5)
        return True
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return False


def query_gpu():
    """Query NVIDIA GPU utilization via nvidia-smi."""
    try:
        r = subprocess.run(
            ['nvidia-smi', '--query-gpu=utilization.gpu,memory.used,memory.total',
             '--format=csv,noheader,nounits'],
            capture_output=True, text=True, timeout=5
        )
        if r.returncode != 0:
            return None
        parts = r.stdout.strip().split(',')
        if len(parts) >= 3:
            return {
                'gpu_percent': int(parts[0].strip()),
                'mem_used_mb': int(parts[1].strip()),
                'mem_total_mb': int(parts[2].strip())
            }
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError, ValueError):
        pass
    return None


def load_zones(zones_file, cam_id):
    """Load zones/lines for this camera from zones.json.

    Supports both per-camera format (keyed by cam_id) and legacy flat format.
    Returns (zones_list, lines_list).
    """
    if not zones_file or not os.path.isfile(zones_file):
        return [], []
    try:
        with open(zones_file, 'r') as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return [], []

    # Per-camera format: { "cam_id": { "zones": [...], "lines": [...] } }
    if cam_id and cam_id in data:
        cam_data = data[cam_id]
        zones = cam_data.get('zones', [])
        lines = cam_data.get('lines', [])
        return zones, lines

    # Legacy flat format: { "zones": [...], "lines": [...] }
    if 'zones' in data:
        return data.get('zones', []), data.get('lines', [])

    return [], []


def point_in_polygon(x, y, polygon):
    """Ray-casting algorithm for zone filtering.

    polygon: list of [x, y] normalized points.
    """
    n = len(polygon)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def check_line_crossing(prev_pos, curr_pos, line):
    """Check if track trajectory crossed a line segment.

    Uses cross product to determine crossing direction.
    Returns 'entry', 'exit', or None.
    """
    x1, y1 = line.get('x1', 0), line.get('y1', 0)
    x2, y2 = line.get('x2', 0), line.get('y2', 0)

    px, py = prev_pos
    cx, cy = curr_pos

    # Direction vectors
    dx = x2 - x1
    dy = y2 - y1

    # Cross products
    d1 = dx * (py - y1) - dy * (px - x1)
    d2 = dx * (cy - y1) - dy * (cx - x1)

    # Check if signs differ (crossing occurred)
    if d1 * d2 < 0:
        # Determine direction based on which side we came from
        if d1 > 0:
            return 'exit'
        else:
            return 'entry'
    return None


def main():
    parser = argparse.ArgumentParser(
        description='StreamHub Agent — edge detection worker')
    parser.add_argument('--rtsp', required=True, help='RTSP URL')
    parser.add_argument('--model', default='yolo11n', help='Model name (yolo11n/s/m/l/x)')
    parser.add_argument('--confidence', type=float, default=0.5, help='Confidence threshold')
    parser.add_argument('--targets', default='', help='Comma-separated target classes')
    parser.add_argument('--tracker', default='bytetrack.yaml', help='Tracker config')
    parser.add_argument('--fps', type=float, default=2, help='Inference FPS')
    parser.add_argument('--output-dir', required=True, help='Output directory')
    parser.add_argument('--zones-file', default='zones.json', help='Zones JSON file')
    parser.add_argument('--cam-id', default='', help='Camera ID')
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)

    # Resource monitoring (optional — only when psutil is installed)
    proc = psutil.Process() if psutil else None
    gpu_available = check_nvidia_smi()
    gpu_query_interval = 10  # query GPU every N frames
    gpu_frame_counter = 0
    last_gpu_data = None
    # Prime CPU percent measurement (first call always returns 0)
    if psutil:
        psutil.cpu_percent(interval=None)

    # Ensure tracker has .yaml extension for ultralytics
    tracker = args.tracker
    if tracker and not tracker.endswith('.yaml'):
        tracker = tracker + '.yaml'

    # Load model (auto-downloads on first run)
    model_name = args.model
    if not model_name.endswith('.pt'):
        model_name += '.pt'
    print(f'[detect] Loading model {model_name}...', flush=True)
    model = YOLO(model_name)

    # Map target names to class indices
    target_ids = None
    if args.targets:
        target_classes = [t.strip() for t in args.targets.split(',') if t.strip()]
        if target_classes:
            target_ids = [k for k, v in model.names.items() if v in target_classes]
            print(f'[detect] Filtering targets: {target_classes} -> class IDs: {target_ids}',
                  flush=True)

    zones, lines = load_zones(args.zones_file, args.cam_id)
    print(f'[detect] Loaded {len(zones)} zones, {len(lines)} lines', flush=True)

    track_history = {}  # track_id -> [(cx, cy), ...]
    line_counts = {l.get('name', f'line{i}'): {'entry': 0, 'exit': 0}
                   for i, l in enumerate(lines)}
    frame_interval = 1.0 / max(args.fps, 0.1)
    reconnect_delay = 3

    frame_path = os.path.join(args.output_dir, 'frame.jpg')
    frame_tmp = os.path.join(args.output_dir, 'frame.tmp.jpg')
    events_path = os.path.join(args.output_dir, 'detections.json')
    events_tmp = os.path.join(args.output_dir, 'detections.tmp.json')

    print(f'[detect] Connecting to {args.rtsp}...', flush=True)
    cap = cv2.VideoCapture(args.rtsp)

    consecutive_failures = 0
    max_failures = 30  # give up after 30 consecutive read failures

    while True:
        ret, frame = cap.read()
        if not ret:
            consecutive_failures += 1
            if consecutive_failures > max_failures:
                print(f'[detect] Too many failures, reconnecting...', flush=True)
                cap.release()
                time.sleep(reconnect_delay)
                cap = cv2.VideoCapture(args.rtsp)
                consecutive_failures = 0
            else:
                time.sleep(0.1)
            continue

        consecutive_failures = 0
        t0 = time.time()

        # Run YOLO with ByteTrack tracking
        try:
            results = model.track(
                frame,
                persist=True,
                tracker=tracker,
                conf=args.confidence,
                classes=target_ids,
                verbose=False
            )
        except Exception as e:
            print(f'[detect] Inference error: {e}', flush=True)
            time.sleep(frame_interval)
            continue

        # Process detections
        detections = []
        annotated = results[0].plot()  # annotated frame with boxes + track IDs
        h, w = frame.shape[:2]

        if results[0].boxes is not None and len(results[0].boxes) > 0:
            for box in results[0].boxes:
                cls_id = int(box.cls)
                cls_name = model.names[cls_id]
                conf = float(box.conf)
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                cx = (x1 + x2) / 2 / w  # normalized center
                cy = (y1 + y2) / 2 / h

                track_id = int(box.id) if box.id is not None else -1

                # Zone filtering
                in_zone = len(zones) == 0  # if no zones defined, accept all
                for z in zones:
                    if z.get('enabled', True) and point_in_polygon(cx, cy, z.get('points', [])):
                        in_zone = True
                        break
                if not in_zone:
                    continue

                # Line crossing detection (requires tracking ID)
                if track_id >= 0:
                    if track_id not in track_history:
                        track_history[track_id] = []
                    prev = track_history[track_id][-1] if track_history[track_id] else None
                    track_history[track_id].append((cx, cy))

                    # Keep history bounded
                    if len(track_history[track_id]) > 100:
                        track_history[track_id] = track_history[track_id][-50:]

                    if prev:
                        for ln in lines:
                            if not ln.get('enabled', True):
                                continue
                            crossing = check_line_crossing(prev, (cx, cy), ln)
                            if crossing:
                                ln_name = ln.get('name', 'unnamed')
                                if ln_name in line_counts:
                                    line_counts[ln_name][crossing] += 1

                detections.append({
                    'class': cls_name,
                    'confidence': round(conf, 2),
                    'bbox': [round(v, 1) for v in [x1, y1, x2, y2]],
                    'track_id': track_id
                })

        # Clean up stale tracks (not seen in 100 frames worth of time)
        if len(track_history) > 500:
            # Keep only recent tracks
            active_ids = set()
            if results[0].boxes is not None:
                for box in results[0].boxes:
                    if box.id is not None:
                        active_ids.add(int(box.id))
            stale = [tid for tid in track_history if tid not in active_ids]
            for tid in stale[:len(stale) - 200]:  # keep some buffer
                del track_history[tid]

        # Write annotated frame (atomic: write tmp then rename)
        try:
            cv2.imwrite(frame_tmp, annotated, [cv2.IMWRITE_JPEG_QUALITY, 80])
            os.replace(frame_tmp, frame_path)
        except OSError:
            pass

        # Collect resource stats (best-effort; empty when psutil is absent)
        resources = {}
        if psutil and proc:
            resources = {
                'cpu_percent': psutil.cpu_percent(interval=None),
                'mem_percent': round(psutil.virtual_memory().percent, 1),
                'proc_mem_mb': round(proc.memory_info().rss / 1048576, 1)
            }
        if gpu_available:
            gpu_frame_counter += 1
            if gpu_frame_counter >= gpu_query_interval or last_gpu_data is None:
                gpu_frame_counter = 0
                last_gpu_data = query_gpu()
            if last_gpu_data:
                resources['gpu'] = last_gpu_data

        # Write detections JSON (atomic)
        event = {
            'timestamp': time.time(),
            'count': len(detections),
            'detections': detections,
            'line_counts': line_counts,
            'resources': resources
        }
        try:
            with open(events_tmp, 'w') as f:
                json.dump(event, f)
            os.replace(events_tmp, events_path)
        except OSError:
            pass

        # Throttle to target FPS
        elapsed = time.time() - t0
        if elapsed < frame_interval:
            time.sleep(frame_interval - elapsed)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
    main()
