"""JSON-line inference server for LR-Agent pre-annotation."""

from __future__ import annotations

import json
import sys
import traceback
from typing import Any

from runners.dispatch import dispatch_run
from runners.runtime import check_runtime


def _respond(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _handle_ping(_req: dict[str, Any]) -> dict[str, Any]:
    runtime = check_runtime()
    return {"ok": True, "runtime": runtime}


def _handle_run(req: dict[str, Any]) -> dict[str, Any]:
    try:
        result = dispatch_run(req.get("request") or {})
        return {"ok": True, "result": result}
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "error": str(exc),
            "trace": traceback.format_exc(),
        }


def main() -> None:
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            _respond({"ok": False, "error": f"invalid json: {exc}"})
            continue

        cmd = req.get("cmd")
        if cmd == "ping":
            _respond(_handle_ping(req))
        elif cmd == "run":
            _respond(_handle_run(req))
        elif cmd == "shutdown":
            _respond({"ok": True})
            break
        else:
            _respond({"ok": False, "error": f"unknown cmd: {cmd}"})


if __name__ == "__main__":
    main()
