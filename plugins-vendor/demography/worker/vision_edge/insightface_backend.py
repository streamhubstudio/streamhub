"""
InsightFace demography backend (LAZY imports; runtime only).

Ports Vision One's local demography backend
(vision_one/models/demography/insightface_backend.py): ``buffalo_l`` genderage +
RetinaFace detection, a softmax over the genderage head's female/male logits for
calibrated gender probabilities, HSEmotion (8→7 remap) for emotion. The
mapping/threshold/remap math lives in ``models.demography`` (pure, tested); this
module only does the heavy inference and hands raw scores to those pure
functions. Marked ``pragma: no cover`` — needs onnxruntime/insightface.
"""
from __future__ import annotations

import math
from typing import Any


class InsightFaceBackend:  # pragma: no cover - needs insightface/onnxruntime
    def __init__(self, device: str = "cpu") -> None:
        from insightface.app import FaceAnalysis  # lazy

        if device == "cuda":
            providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
            ctx_id = 0
        else:
            providers = ["CPUExecutionProvider"]
            ctx_id = -1
        self.app = FaceAnalysis(name="buffalo_l", providers=providers)
        self.app.prepare(ctx_id=ctx_id, det_size=(640, 640))
        self._emotion = None

    def _emotion_recognizer(self):
        if self._emotion is None:
            try:
                from hsemotion.facial_emotions import HSEmotionRecognizer

                self._emotion = HSEmotionRecognizer(model_name="enet_b0_8_best_vgaf")
            except Exception:  # noqa: BLE001 - emotion optional
                self._emotion = False
        return self._emotion or None

    @staticmethod
    def _softmax2(a: float, b: float) -> tuple[float, float]:
        m = max(a, b)
        ea, eb = math.exp(a - m), math.exp(b - m)
        s = ea + eb
        return ea / s, eb / s

    def analyze(self, frame: Any, dc) -> list[dict[str, Any]]:
        from .models import demography as dm

        faces = self.app.get(frame)
        h, w = frame.shape[0], frame.shape[1]
        out: list[dict[str, Any]] = []
        for face in faces:
            if float(getattr(face, "det_score", 0.0)) < dm.CONFIDENCE_THRESHOLD:
                continue
            pred = getattr(face, "genderage_pred", None)
            if pred is not None and len(pred) >= 2:
                p_female, p_male = self._softmax2(float(pred[0]), float(pred[1]))
            else:
                gender = int(getattr(face, "gender", 0))
                p_male, p_female = (1.0, 0.0) if gender == 1 else (0.0, 1.0)
            age = float(getattr(face, "age", 0))
            gender_label, gender_conf = dm.map_gender(p_male, p_female)

            emotion, emotion_conf = "neutral", 0.0
            recognizer = self._emotion_recognizer()
            if recognizer is not None:
                try:
                    import cv2

                    x1, y1, x2, y2 = (int(v) for v in face.bbox)
                    crop = frame[max(0, y1):y2, max(0, x1):x2]
                    rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
                    _name, scores = recognizer.predict_emotions(rgb, logits=False)
                    labels = ["Anger", "Contempt", "Disgust", "Fear", "Happiness", "Neutral", "Sadness", "Surprise"]
                    scores8 = {labels[i]: float(scores[i]) for i in range(min(len(labels), len(scores)))}
                    remapped = dm.remap_hsemotion(scores8)
                    emotion, emotion_conf = dm.dominant_emotion(remapped)
                except Exception:  # noqa: BLE001 - emotion best-effort
                    pass

            # Normalized face bbox so the caller can resolve which POI the face
            # fell in (whole-frame when no POIs are configured).
            fx1, fy1, fx2, fy2 = (float(v) for v in face.bbox[:4])
            record = {
                "age": int(round(age)),
                "ageRange": dm.age_range(age),
                "gender": gender_label,
                "genderConfidence": gender_conf,
                "emotion": emotion,
                "emotionConfidence": emotion_conf,
                "bbox": [fx1 / w, fy1 / h, fx2 / w, fy2 / h],
            }
            # RAW record (with bbox) — run_demography resolves POI + builds the
            # ``demography.face`` event.
            out.append(record)
        return out
