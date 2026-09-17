from __future__ import annotations

from typing import Any

from runners.keypoint import run_keypoint
from runners.sam2_runner import run_sam2_box
from runners.yolo import run_yolo_detect, run_yolo_obb


def dispatch_run(request: dict[str, Any]) -> dict[str, Any]:
    kind = request.get("kind")
    if kind == "yolo_detect":
        return run_yolo_detect(request)
    if kind == "yolo_obb":
        return run_yolo_obb(request)
    if kind == "sam2_box":
        return run_sam2_box(request)
    if kind in ("keypoint_full", "keypoint_roi"):
        return run_keypoint(request)
    raise ValueError(f"unsupported pre-annot kind: {kind}")
