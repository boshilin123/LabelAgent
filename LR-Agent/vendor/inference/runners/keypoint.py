from __future__ import annotations

import math
from typing import Any

import cv2
import numpy as np

from runners.runtime import resolve_device
from runners.yolo import _crop_by_norm_box, _load_image, get_yolo_model


def _visibility_from_conf(conf: float, threshold: float) -> int:
    if conf < threshold * 0.5:
        return 0
    if conf < threshold:
        return 1
    return 2


def _tight_bbox_from_keypoints(
    keypoints: list[dict[str, Any]],
    img_w: int,
    img_h: int,
) -> tuple[float, float, float, float]:
    visible = [kp for kp in keypoints if kp.get("visibility", 2) > 0]
    if not visible:
        return 0.5, 0.5, 0.15, 0.22

    xs = [kp["x"] * img_w for kp in visible]
    ys = [kp["y"] * img_h for kp in visible]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    pad = max(img_h * 0.02, 10)
    cx = (min_x + max_x) / 2
    cy = (min_y + max_y) / 2
    width = max(max_x - min_x + pad * 2, img_w * 0.05)
    height = max(max_y - min_y + pad * 2, img_h * 0.05)
    return cx / img_w, cy / img_h, width / img_w, height / img_h


def _run_yolo_pose(
    request: dict[str, Any],
    template_id: str,
) -> dict[str, Any]:
    image_path = str(request["imagePath"])
    model_cfg = request.get("model") or {}
    checkpoint = str(model_cfg.get("checkpointPath") or "")
    if not checkpoint:
        raise ValueError("missing checkpointPath")

    params = model_cfg.get("params") or {}
    conf = float(params.get("confThreshold", 0.25))
    kpt_conf = float(params.get("kptConfThreshold", 0.5))
    max_instances = int(params.get("maxInstances", 20))
    device = resolve_device(params.get("device"))

    image, full_w, full_h = _load_image(image_path)
    roi = request.get("box")
    crop, off_x, off_y, _, _ = _crop_by_norm_box(image, roi)

    model = get_yolo_model(checkpoint, device)
    results = model.predict(source=crop, conf=conf, device=device, verbose=False)

    poses: list[dict[str, Any]] = []
    for result in results:
        if result.keypoints is None:
            continue
        kpts_xy = result.keypoints.xy
        kpts_conf = result.keypoints.conf
        boxes = result.boxes
        if kpts_xy is None:
            continue

        for idx in range(len(kpts_xy)):
            if len(poses) >= max_instances:
                break
            xy = kpts_xy[idx].cpu().numpy()
            confs = (
                kpts_conf[idx].cpu().numpy()
                if kpts_conf is not None
                else np.ones(len(xy))
            )
            keypoints: list[dict[str, Any]] = []
            for j in range(len(xy)):
                px = (off_x + float(xy[j][0])) / full_w
                py = (off_y + float(xy[j][1])) / full_h
                kc = float(confs[j]) if j < len(confs) else 1.0
                keypoints.append(
                    {
                        "x": max(0.0, min(1.0, px)),
                        "y": max(0.0, min(1.0, py)),
                        "confidence": kc,
                        "visibility": _visibility_from_conf(kc, kpt_conf),
                    }
                )

            cx, cy, width, height = _tight_bbox_from_keypoints(
                keypoints, full_w, full_h
            )
            det_conf = 1.0
            if boxes is not None and idx < len(boxes):
                det_conf = float(boxes.conf[idx].item())

            poses.append(
                {
                    "templateId": template_id,
                    "confidence": det_conf,
                    "cx": cx,
                    "cy": cy,
                    "width": width,
                    "height": height,
                    "angle": 0.0,
                    "keypoints": keypoints,
                }
            )

    return {"poses": poses}


def _run_mediapipe_hand(request: dict[str, Any], template_id: str) -> dict[str, Any]:
    try:
        import mediapipe as mp
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision
    except ImportError as exc:
        raise ImportError(
            "MediaPipe 未安装，请执行: pip install -r requirements-keypoint.txt"
        ) from exc

    image_path = str(request["imagePath"])
    model_cfg = request.get("model") or {}
    checkpoint = str(model_cfg.get("checkpointPath") or "")
    if not checkpoint:
        raise ValueError("missing hand_landmarker.task path")

    params = model_cfg.get("params") or {}
    kpt_conf = float(params.get("kptConfThreshold", 0.5))
    max_instances = int(params.get("maxInstances", 2))

    image_bgr, img_w, img_h = _load_image(image_path)
    image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)

    cache_key = f"mp_hand:{checkpoint}"
    if not hasattr(_run_mediapipe_hand, "_cache"):
        _run_mediapipe_hand._cache = {}  # type: ignore[attr-defined]
    cache = _run_mediapipe_hand._cache  # type: ignore[attr-defined]

    if cache_key not in cache:
        base_options = mp_python.BaseOptions(model_asset_path=checkpoint)
        options = vision.HandLandmarkerOptions(
            base_options=base_options,
            num_hands=max_instances,
        )
        cache[cache_key] = vision.HandLandmarker.create_from_options(options)

    landmarker = cache[cache_key]
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=image_rgb)
    result = landmarker.detect(mp_image)

    poses: list[dict[str, Any]] = []
    if not result.hand_landmarks:
        return {"poses": poses}

    for hand in result.hand_landmarks[:max_instances]:
        keypoints: list[dict[str, Any]] = []
        for lm in hand:
            kc = 1.0 if lm.visibility is None or lm.visibility > 0.5 else 0.3
            keypoints.append(
                {
                    "x": max(0.0, min(1.0, lm.x)),
                    "y": max(0.0, min(1.0, lm.y)),
                    "confidence": kc,
                    "visibility": _visibility_from_conf(kc, kpt_conf),
                }
            )
        cx, cy, width, height = _tight_bbox_from_keypoints(keypoints, img_w, img_h)
        poses.append(
            {
                "templateId": template_id,
                "confidence": 1.0,
                "cx": cx,
                "cy": cy,
                "width": width,
                "height": height,
                "angle": 0.0,
                "keypoints": keypoints,
            }
        )

    return {"poses": poses}


def _run_face_alignment(request: dict[str, Any], template_id: str) -> dict[str, Any]:
    try:
        import face_alignment
        import torch
    except ImportError as exc:
        raise ImportError(
            "face-alignment 未安装，请执行: pip install -r requirements-keypoint.txt"
        ) from exc

    image_path = str(request["imagePath"])
    model_cfg = request.get("model") or {}
    params = model_cfg.get("params") or {}
    kpt_conf = float(params.get("kptConfThreshold", 0.5))
    max_instances = int(params.get("maxInstances", 10))
    device = resolve_device(params.get("device"))
    use_cuda = device != "cpu"

    image_bgr, img_w, img_h = _load_image(image_path)
    image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)

    cache_key = f"fa:{use_cuda}"
    if not hasattr(_run_face_alignment, "_cache"):
        _run_face_alignment._cache = {}  # type: ignore[attr-defined]
    cache = _run_face_alignment._cache  # type: ignore[attr-defined]

    if cache_key not in cache:
        cache[cache_key] = face_alignment.FaceAlignment(
            face_alignment.LandmarksType.TWO_D,
            flip_input=False,
            device="cuda" if use_cuda and torch.cuda.is_available() else "cpu",
        )

    fa = cache[cache_key]
    preds = fa.get_landmarks(image_rgb)
    if preds is None:
        return {"poses": []}

    poses: list[dict[str, Any]] = []
    for landmarks in preds[:max_instances]:
        keypoints: list[dict[str, Any]] = []
        for x, y in landmarks:
            px = max(0.0, min(1.0, float(x) / img_w))
            py = max(0.0, min(1.0, float(y) / img_h))
            keypoints.append(
                {
                    "x": px,
                    "y": py,
                    "confidence": 1.0,
                    "visibility": _visibility_from_conf(1.0, kpt_conf),
                }
            )
        cx, cy, width, height = _tight_bbox_from_keypoints(keypoints, img_w, img_h)
        poses.append(
            {
                "templateId": template_id,
                "confidence": 1.0,
                "cx": cx,
                "cy": cy,
                "width": width,
                "height": height,
                "angle": 0.0,
                "keypoints": keypoints,
            }
        )

    return {"poses": poses}


def run_keypoint(request: dict[str, Any]) -> dict[str, Any]:
    model_cfg = request.get("model") or {}
    backend = model_cfg.get("keypointBackend") or "yolo_pose"
    template_ids = model_cfg.get("keypointTemplateIds") or []
    template_id = str(request.get("templateId") or (template_ids[0] if template_ids else "person_coco"))

    if backend == "yolo_pose":
        return _run_yolo_pose(request, template_id)
    if backend == "mediapipe_hand":
        return _run_mediapipe_hand(request, template_id)
    if backend == "face_alignment":
        return _run_face_alignment(request, template_id)
    raise ValueError(f"unsupported keypoint backend: {backend}")
