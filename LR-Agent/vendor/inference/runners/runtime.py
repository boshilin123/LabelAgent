from __future__ import annotations

import importlib.util
import sys
from typing import Any


def _module_available(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def check_runtime() -> dict[str, Any]:
    cuda_available = False
    torch_version = None
    if _module_available("torch"):
        import torch

        torch_version = torch.__version__
        cuda_available = bool(torch.cuda.is_available())

    return {
        "pythonOk": True,
        "pythonVersion": sys.version.split()[0],
        "torchVersion": torch_version,
        "cudaAvailable": cuda_available,
        "ultralytics": _module_available("ultralytics"),
        "sam2": _module_available("sam2"),
        "mediapipe": _module_available("mediapipe"),
        "faceAlignment": _module_available("face_alignment"),
        "opencv": _module_available("cv2"),
    }


def resolve_device(device_pref: str | None) -> str:
    pref = (device_pref or "auto").lower()
    if pref == "cpu":
        return "cpu"
    if pref == "cuda":
        return "0"
    if _module_available("torch"):
        import torch

        return "0" if torch.cuda.is_available() else "cpu"
    return "cpu"
