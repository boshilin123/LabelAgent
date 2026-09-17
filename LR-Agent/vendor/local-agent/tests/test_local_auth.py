"""local-agent 本地 token 鉴权测试。

覆盖：未配置 token 时失败关闭、错误/缺失 token 返回 401、正确 token 放行，
以及 /health 保持开放（Electron 主进程据此探活）。
"""

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.core.deps import get_expected_local_token, require_local_token


def _build_app() -> FastAPI:
    app = FastAPI()

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/protected", dependencies=[Depends(require_local_token)])
    async def protected() -> dict[str, bool]:
        return {"ok": True}

    return app


def test_health_stays_open_without_token(monkeypatch):
    monkeypatch.delenv("LR_AGENT_LOCAL_TOKEN", raising=False)
    client = TestClient(_build_app())
    assert client.get("/health").status_code == 200
    # 未配置 token 时失败关闭，禁止访问业务接口
    assert client.get("/protected").status_code == 401


def test_wrong_or_missing_token_rejected(monkeypatch):
    monkeypatch.setenv("LR_AGENT_LOCAL_TOKEN", "expected-token")
    client = TestClient(_build_app())
    assert client.get("/protected").status_code == 401
    assert (
        client.get(
            "/protected", headers={"Authorization": "Bearer nope"}
        ).status_code
        == 401
    )
    assert (
        client.get(
            "/protected", headers={"Authorization": "expected-token"}
        ).status_code
        == 401
    )


def test_correct_token_accepted(monkeypatch):
    monkeypatch.setenv("LR_AGENT_LOCAL_TOKEN", "expected-token")
    client = TestClient(_build_app())
    response = client.get(
        "/protected", headers={"Authorization": "Bearer expected-token"}
    )
    assert response.status_code == 200
    assert get_expected_local_token() == "expected-token"
