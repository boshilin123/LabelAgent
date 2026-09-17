# LR-Agent Inference

本地预标注推理服务，供 Electron 客户端通过 stdin/stdout JSON 协议调用。

> 本服务内嵌于客户端仓库 `vendor/inference/`：开发模式由主进程从
> `app.getAppPath()/vendor/inference` 启动，打包后随客户端分发至
> `resources/inference`。

## 环境

仓库提供两个完整安装清单（均含 SAM2、MediaPipe、face-alignment，无需额外可选文件）：

- `requirements-gpu.txt` — GPU 完整安装（PyTorch 2.5.1 CUDA 12.1 wheel）
- `requirements-cpu.txt` — CPU 完整安装（PyTorch CPU wheel）

### GPU（推荐，需 NVIDIA 显卡）

**方式 A — Conda（Windows 上较稳）**

```bash
conda create -n lr-agent-inference python=3.12 -y
conda activate lr-agent-inference
pip install -r requirements-gpu.txt
```

**方式 B — venv**

```bash
python -m venv lr-agent-inference
# Windows: lr-agent-inference\Scripts\activate
source lr-agent-inference/bin/activate
pip install -r requirements-gpu.txt
```

若之前装过 CPU 版 PyTorch，请先卸载再装 GPU 版：

```bash
pip uninstall torch torchvision -y
pip install -r requirements-gpu.txt
```

验证 CUDA：

```bash
python -c "import torch; print(torch.__version__, torch.cuda.is_available())"
```

`requirements-gpu.txt` 通过文件首行的 `--extra-index-url https://download.pytorch.org/whl/cu121`
获取 PyTorch **CUDA 12.1** wheel（`cu121`），驱动需足够新；可用 `nvidia-smi` 查看。
其他 CUDA 版本请参考 [PyTorch 安装页](https://pytorch.org/get-started/locally/) 修改该行（如 `cu124`、`cu118`）。
文件中 SAM-2 以 `git+https` 安装，本机需安装 git。

### CPU（无独显 / 仅调试）

```bash
python -m venv lr-agent-inference
# Windows: lr-agent-inference\Scripts\activate
source lr-agent-inference/bin/activate
pip install -r requirements-cpu.txt
```

## 依赖文件说明

| 文件 | 说明 |
|------|------|
| `requirements-gpu.txt` | GPU 完整安装（CUDA 12.1 PyTorch + SAM2 / MediaPipe / face-alignment） |
| `requirements-cpu.txt` | CPU 完整安装（CPU PyTorch + 同上） |

## 手动测试

```bash
conda activate lr-agent-inference
python server.py
```

输入（单行 JSON）：

```json
{"cmd":"ping"}
```

应返回 `cudaAvailable: true`（GPU 环境）。

## Electron 配置

应用会自动查找 conda 环境 `lr-agent-inference` 下的 Python。也可设置环境变量：

- `LR_AGENT_INFERENCE_PYTHON` — Python 可执行文件完整路径
- `LR_AGENT_INFERENCE_CONDA_ENV` — conda 环境名（默认 `lr-agent-inference`）

## 支持的推理类型

| kind | 说明 |
|------|------|
| `yolo_detect` | 矩形框目标检测 |
| `yolo_obb` | 旋转框检测 |
| `sam2_box` | SAM2 框选分割 → 多边形 |
| `keypoint_full` | 整图关键点 / 骨架 |
| `keypoint_roi` | 框选区域关键点 |
