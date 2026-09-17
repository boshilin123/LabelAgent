from __future__ import annotations

from typing import Any

import cv2
import numpy as np

from runners.runtime import resolve_device


def _load_image_bgr(image_path: str) -> tuple[np.ndarray, int, int]:
    image = cv2.imread(image_path, cv2.IMREAD_COLOR)
    if image is None:
        raise FileNotFoundError(f"cannot read image: {image_path}")
    h, w = image.shape[:2]
    return image, w, h


def _mask_to_polygon(
    mask: np.ndarray,
    image_w: int,
    image_h: int,
    min_area: float,
    epsilon_ratio: float,
) -> list[dict[str, float]]:
    mask_u8 = (mask.astype(np.uint8) * 255) if mask.max() <= 1 else mask.astype(np.uint8)
    contours, _ = cv2.findContours(mask_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return []

    best = max(contours, key=cv2.contourArea)
    area = cv2.contourArea(best)
    if area < min_area:
        return []

    epsilon = epsilon_ratio * cv2.arcLength(best, True)
    approx = cv2.approxPolyDP(best, epsilon, True)
    points: list[dict[str, float]] = []
    for pt in approx.reshape(-1, 2):
        x, y = float(pt[0]), float(pt[1])
        points.append(
            {
                "x": max(0.0, min(1.0, x / image_w)),
                "y": max(0.0, min(1.0, y / image_h)),
            }
        )
    if len(points) < 3:
        return []
    return points


def run_sam2_box(request: dict[str, Any]) -> dict[str, Any]:
    try:
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor
    except ImportError as exc:
        raise ImportError(
            "SAM2 未安装，请执行: pip install -r requirements-sam2.txt"
        ) from exc

    image_path = str(request["imagePath"])
    model_cfg = request.get("model") or {}
    checkpoint = str(model_cfg.get("checkpointPath") or "")
    config_path = str(model_cfg.get("configPath") or "")
    if not checkpoint or not config_path:
        raise ValueError("SAM2 需要 checkpointPath 与 configPath")

    params = model_cfg.get("params") or {}
    min_area = float(params.get("minArea", 100))
    epsilon_ratio = float(params.get("epsilonRatio", 0.006))

    box = request.get("box") or {}
    x1 = float(box.get("x1", 0))
    y1 = float(box.get("y1", 0))
    x2 = float(box.get("x2", 1))
    y2 = float(box.get("y2", 1))

    image_bgr, img_w, img_h = _load_image_bgr(image_path)
    image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)

    cache_key = f"sam2:{checkpoint}:{config_path}"
    if not hasattr(run_sam2_box, "_cache"):
        run_sam2_box._cache = {}  # type: ignore[attr-defined]
    cache: dict[str, SAM2ImagePredictor] = run_sam2_box._cache  # type: ignore[attr-defined]

    if cache_key not in cache:
        sam = build_sam2(config_path, checkpoint)
        cache[cache_key] = SAM2ImagePredictor(sam)

    predictor = cache[cache_key]
    predictor.set_image(image_rgb)

    bx1 = int(max(0, min(img_w - 1, x1 * img_w)))
    by1 = int(max(0, min(img_h - 1, y1 * img_h)))
    bx2 = int(max(0, min(img_w, x2 * img_w)))
    by2 = int(max(0, min(img_h, y2 * img_h)))
    if bx2 <= bx1 or by2 <= by1:
        raise ValueError("invalid prompt box")

    box_np = np.array([bx1, by1, bx2, by2], dtype=np.float32)
    masks, scores, _ = predictor.predict(box=box_np, multimask_output=False)
    if masks is None or len(masks) == 0:
        return {"points": [], "score": 0.0}

    mask = masks[0]
    points = _mask_to_polygon(mask, img_w, img_h, min_area, epsilon_ratio)
    score = float(scores[0]) if scores is not None and len(scores) else 0.0
    return {"points": points, "score": score}
