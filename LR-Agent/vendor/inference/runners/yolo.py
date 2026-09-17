from __future__ import annotations

import math
from typing import Any

import cv2
import numpy as np

from runners.runtime import resolve_device


def get_yolo_model(checkpoint: str, device: str):
    from ultralytics import YOLO

    cache_key = f"{checkpoint}:{device}"
    if not hasattr(get_yolo_model, "_cache"):
        get_yolo_model._cache = {}  # type: ignore[attr-defined]
    cache: dict[str, Any] = get_yolo_model._cache  # type: ignore[attr-defined]
    if cache_key not in cache:
        cache[cache_key] = YOLO(checkpoint)
    return cache[cache_key]


def _load_image(image_path: str) -> tuple[np.ndarray, int, int]:
    image = cv2.imread(image_path, cv2.IMREAD_COLOR)
    if image is None:
        raise FileNotFoundError(f"cannot read image: {image_path}")
    h, w = image.shape[:2]
    return image, w, h


def _crop_by_norm_box(
    image: np.ndarray,
    box: dict[str, float] | None,
) -> tuple[np.ndarray, int, int, float, float]:
    h, w = image.shape[:2]
    if not box:
        return image, 0, 0, w, h

    x1 = int(max(0, min(w - 1, float(box["x1"]) * w)))
    y1 = int(max(0, min(h - 1, float(box["y1"]) * h)))
    x2 = int(max(0, min(w, float(box["x2"]) * w)))
    y2 = int(max(0, min(h, float(box["y2"]) * h)))
    if x2 <= x1 or y2 <= y1:
        return image, 0, 0, w, h
    cropped = image[y1:y2, x1:x2]
    return cropped, x1, y1, x2 - x1, y2 - y1


def _class_names_from_model(model) -> list[str]:
    names = getattr(model, "names", None)
    if isinstance(names, dict):
        return [names[k] for k in sorted(names.keys(), key=lambda x: int(x))]
    if isinstance(names, list):
        return names
    return []


def _run_yolo_predict(
    request: dict[str, Any],
    task: str | None = None,
) -> dict[str, Any]:
    image_path = str(request["imagePath"])
    model_cfg = request.get("model") or {}
    checkpoint = str(model_cfg.get("checkpointPath") or "")
    if not checkpoint:
        raise ValueError("missing checkpointPath")

    params = model_cfg.get("params") or {}
    conf = float(params.get("confThreshold", 0.7))
    iou = float(params.get("iouThreshold", 0.5))
    device = resolve_device(params.get("device"))

    image, full_w, full_h = _load_image(image_path)
    roi = request.get("box")
    crop, off_x, off_y, crop_w, crop_h = _crop_by_norm_box(image, roi)

    model = get_yolo_model(checkpoint, device)
    predict_kwargs: dict[str, Any] = {"conf": conf, "iou": iou, "device": device, "verbose": False}
    if task:
        predict_kwargs["task"] = task

    results = model.predict(source=crop, **predict_kwargs)
    class_names = _class_names_from_model(model)
    if model_cfg.get("classNames"):
        class_names = list(model_cfg["classNames"])

    items: list[dict[str, Any]] = []
    for result in results:
        if task == "obb" and result.obb is not None:
            for det in result.obb:
                xywhr = det.xywhr[0].tolist()
                cx, cy, bw, bh, angle_rad = xywhr
                cx_n = (off_x + cx) / full_w
                cy_n = (off_y + cy) / full_h
                w_n = bw / full_w
                h_n = bh / full_h
                angle_deg = math.degrees(angle_rad)
                cls_id = int(det.cls.item()) if det.cls is not None else 0
                conf_v = float(det.conf.item()) if det.conf is not None else 0.0
                cls_name = class_names[cls_id] if cls_id < len(class_names) else str(cls_id)
                items.append(
                    {
                        "className": cls_name,
                        "classId": cls_id,
                        "confidence": conf_v,
                        "geometry": {
                            "cx": cx_n,
                            "cy": cy_n,
                            "width": w_n,
                            "height": h_n,
                            "angle": angle_deg,
                        },
                    }
                )
            continue

        boxes = result.boxes
        if boxes is None:
            continue
        for det in boxes:
            xywh = det.xywh[0].tolist()
            cx, cy, bw, bh = xywh
            x = (off_x + cx - bw / 2) / full_w
            y = (off_y + cy - bh / 2) / full_h
            w_n = bw / full_w
            h_n = bh / full_h
            cls_id = int(det.cls.item()) if det.cls is not None else 0
            conf_v = float(det.conf.item()) if det.conf is not None else 0.0
            cls_name = class_names[cls_id] if cls_id < len(class_names) else str(cls_id)
            items.append(
                {
                    "className": cls_name,
                    "classId": cls_id,
                    "confidence": conf_v,
                    "geometry": {
                        "x": max(0.0, min(1.0, x)),
                        "y": max(0.0, min(1.0, y)),
                        "width": max(0.0, min(1.0, w_n)),
                        "height": max(0.0, min(1.0, h_n)),
                    },
                }
            )

    return {"items": items, "classNames": class_names}


def run_yolo_detect(request: dict[str, Any]) -> dict[str, Any]:
    return _run_yolo_predict(request, task=None)


def run_yolo_obb(request: dict[str, Any]) -> dict[str, Any]:
    return _run_yolo_predict(request, task="obb")
