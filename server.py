# ============================================================
# server.py —— 效果器实验室后端（可打包为单文件 exe 分发）
# ------------------------------------------------------------
# 接口：
#   POST /api/analyze    Int16 PCM（?sample_rate=）→ JSON 分析结果
#   POST /api/heartbeat  页面心跳（每 2s 一次，前端自动发）
#   POST /api/bye        页面关闭告别（sendBeacon）
#   GET  /api/health     健康检查
#
# 自动退出（看门狗）：页面关闭或心跳中断后保留 10 分钟，
#   允许用户刷新、切换页面或重新打开地址；超时后退出。
#
# 分发打包（PyInstaller）：
#   pyinstaller --onefile --name GuitarLab ^
#     --add-data "index.html;." --add-data "css;css" --add-data "js;js" server.py
#   打包后 dist/GuitarLab.exe 双击即用（自动开浏览器，无需装 Python）。
# ============================================================
import math
import os
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path

# pythonw / 无控制台 exe 的标准输出可能是 None，先保留诊断日志。
if sys.stdout is None or sys.stderr is None:
    log_dir = Path(sys.executable).parent if getattr(sys, "frozen", False) else Path(__file__).parent
    log_stream = (log_dir / "guitarlab.log").open("a", encoding="utf-8", buffering=1)
    if sys.stdout is None:
        sys.stdout = log_stream
    if sys.stderr is None:
        sys.stderr = log_stream

import numpy as np
from fastapi import FastAPI, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

PORT = 8765

# ---------- 资源路径（PyInstaller onefile 解压到 sys._MEIPASS） ----------
BASE = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))

# ---------- 分析参数 ----------
FFT_SIZE = 4096
HOP = 1024
F_MIN, F_MAX = 20.0, 10000.0
SPEC_BINS = 96        # 频谱图对数频点数
MAX_COLS = 600        # 频谱图最多时间列

# ---------- 心跳 / 自动退出 ----------
START_TS = time.time()
LAST_BEAT = time.time()
BYE_AT = None
BEAT_TIMEOUT = 600.0  # 浏览器后台节流或暂时离开页面时仍可回来
BYE_GRACE = 600.0
NO_BROWSER = os.environ.get("GUITARLAB_NO_BROWSER") == "1"   # 自动化测试时跳过开浏览器


def _watchdog():
    """看门狗：页面关闭或心跳中断一段时间后退出，释放本地服务端口。"""
    while True:
        time.sleep(1.0)
        now = time.time()
        if BYE_AT is not None and now - BYE_AT > BYE_GRACE and LAST_BEAT <= BYE_AT:
            break                                     # 页面关闭且无新页面接上
        if now - LAST_BEAT > BEAT_TIMEOUT:
            break                                     # 心跳中断超时（兜底）
    time.sleep(0.2)
    os._exit(0)


app = FastAPI(title="效果器可视化实验室 · 后端")


@app.post("/api/heartbeat")
async def heartbeat():
    global LAST_BEAT
    LAST_BEAT = time.time()
    return {"ok": True}


@app.post("/api/bye")
async def bye():
    global BYE_AT
    BYE_AT = time.time()
    return {"ok": True}


@app.get("/api/health")
async def health():
    now = time.time()
    return {
        "ok": True,
        "uptime": round(now - START_TS, 1),
        "beatAgo": round(now - LAST_BEAT, 1),
        "byeAgo": round(now - BYE_AT, 1) if BYE_AT else None,
    }


# ---------- 分析工具 ----------
def dbfs(x):
    """线性幅度 → dBFS（满幅正弦 = 0 dBFS，与前端 dsp.js 归一化一致）"""
    return 20.0 * np.log10(np.maximum(x, 1e-9))


def log_freq_axis(n_fft, sr, n_bins):
    freqs = np.geomspace(F_MIN, min(F_MAX, sr / 2), n_bins)
    bins = np.clip(np.round(freqs / (sr / n_fft)).astype(int), 1, n_fft // 2 - 1)
    return freqs, bins


def parabolic(db, k):
    """对数域抛物线插值：峰顶精确位置（bin 单位）"""
    if k <= 0 or k >= len(db) - 1:
        return float(k)
    a, b, c = db[k - 1], db[k], db[k + 1]
    denom = a - 2 * b + c
    if denom == 0:
        return float(k)
    off = 0.5 * (a - c) / denom
    return k + max(-1.0, min(1.0, off))


def estimate_f0_frame(db, bin_hz):
    """单帧基频：最强峰 + 八度纠错（与前端 dsp.js 同一算法）"""
    lo = max(1, int(60 / bin_hz))
    hi = min(len(db) - 2, int(1600 / bin_hz))
    if hi <= lo:
        return None
    k = lo + int(np.argmax(db[lo:hi + 1]))
    if db[k] < -75:
        return None
    f0 = parabolic(db, k) * bin_hz
    for _ in range(2):
        half = f0 / 2
        if half < 55:
            break
        bh = int(round(half / bin_hz))
        sub = db[max(bh - 1, 0):bh + 2].max()
        fh = int(round(f0 / bin_hz))
        cur = db[max(fh - 1, 0):fh + 2].max()
        if sub > cur - 6:
            f0 = half
        else:
            break
    return f0


def harmonic_thd(db, bin_hz, f0, max_h=8):
    amps = []
    for k in range(1, max_h + 1):
        b = int(round(f0 * k / bin_hz))
        seg = db[max(b - 1, 0):b + 2] if b > 0 else np.array([-180.0])
        amps.append(10 ** (float(seg.max()) / 20))
    a1 = amps[0]
    if a1 < 1e-6:
        return None
    return math.sqrt(sum(a * a for a in amps[1:])) / a1


def batch_stft(x, sr):
    """手写批量 STFT（纯 numpy，替代 scipy 以减小打包体积）。
    hann 窗 + hop 1024，归一化与前端 dsp.js 一致（满幅正弦 = 0 dBFS）。
    分批 rfft 控制内存（每批 256 帧）。返回 (freqs, mag_linear, bin_hz, n_frames)。"""
    win = np.hanning(FFT_SIZE)
    bin_hz = sr / FFT_SIZE
    n_frames = max(1, (len(x) - FFT_SIZE) // HOP + 1)
    half = FFT_SIZE // 2 + 1
    scale = 2.0 / (0.5 * FFT_SIZE)
    mag = np.empty((half, n_frames), dtype=np.float32)
    B = 256
    for start in range(0, n_frames, B):
        end = min(start + B, n_frames)
        idx = np.arange(FFT_SIZE)[None, :] + HOP * np.arange(start, end)[:, None]
        frames = x[idx] * win
        mag[:, start:end] = (np.abs(np.fft.rfft(frames, axis=1)) * scale).T
    return np.arange(half) * bin_hz, mag, bin_hz, n_frames


@app.post("/api/analyze")
async def analyze(request: Request, sample_rate: int = Query(..., gt=8000, le=96000)):
    global LAST_BEAT
    LAST_BEAT = time.time()
    body = await request.body()
    n = len(body) // 2
    if n < FFT_SIZE:
        return JSONResponse({"error": f"音频太短（至少需要 {FFT_SIZE} 个样本）"}, status_code=400)

    x = np.frombuffer(body[: n * 2], dtype="<i2").astype(np.float64) / 32768.0
    duration = n / sample_rate

    # ---------- 全曲 STFT（纯 numpy 批量） ----------
    f_bins, mag, bin_hz, n_frames = batch_stft(x, sample_rate)
    spec_db = dbfs(mag)                               # (bins, frames) float32

    # ---------- 频谱图：对数频点 + 时间列抽稀 ----------
    lf, lbin = log_freq_axis(FFT_SIZE, sample_rate, SPEC_BINS)
    cols = np.unique(np.linspace(0, n_frames - 1, min(MAX_COLS, n_frames)).astype(int))
    spec_small = np.empty((SPEC_BINS, len(cols)))
    for i, b in enumerate(lbin):
        band = spec_db[max(b - 1, 0):b + 2, :]
        spec_small[i, :] = band.max(axis=0)[cols]
    times = (cols * HOP / sample_rate).tolist()

    # ---------- 逐帧曲线 ----------
    rms_db, peak_db, f0s, thds = [], [], [], []
    for fi in range(n_frames):
        seg = x[fi * HOP: fi * HOP + FFT_SIZE]
        if len(seg) < FFT_SIZE:
            break
        rms_db.append(round(float(dbfs(math.sqrt(float(np.mean(seg ** 2))))), 1))
        peak_db.append(round(float(dbfs(float(np.max(np.abs(seg))))), 1))
        f0 = estimate_f0_frame(spec_db[:, fi], bin_hz)
        f0s.append(round(f0, 1) if f0 else None)
        thds.append(harmonic_thd(spec_db[:, fi], bin_hz, f0) if f0 else None)

    # ---------- 汇总统计 ----------
    valid_thd = [t for t in thds if t is not None]
    power = np.sum(mag.astype(np.float64) ** 2, axis=1)
    total = float(power.sum()) or 1.0
    lo = float(power[f_bins < 250].sum())
    mid = float(power[(f_bins >= 250) & (f_bins < 2000)].sum())
    hi = float(power[f_bins >= 2000].sum())
    summary = {
        "duration": round(duration, 3),
        "sampleRate": sample_rate,
        "frames": n_frames,
        "peakDbfs": round(float(dbfs(float(np.max(np.abs(x))))), 1),
        "rmsDbfs": round(float(dbfs(math.sqrt(float(np.mean(x ** 2))))), 1),
        "thdPercent": round(100 * sum(valid_thd) / len(valid_thd), 1) if valid_thd else None,
        "bandPercent": {
            "low": round(100 * lo / total, 1),
            "mid": round(100 * mid / total, 1),
            "high": round(100 * hi / total, 1),
        },
    }

    return JSONResponse({
        "spectrogram": {
            "freqs": [round(float(f), 1) for f in lf],
            "times": [round(float(t), 3) for t in times],
            "db": [[round(float(v), 1) for v in row] for row in spec_small],
            "dbMin": -90, "dbMax": 6,
        },
        "curves": {"rms": rms_db, "peak": peak_db, "f0": f0s},
        "summary": summary,
    })


# ---------- 静态页面（只开放前端资源，不把 .git 或 Python 源码当静态文件提供） ----------
@app.get("/")
@app.get("/index.html")
async def index():
    return FileResponse(BASE / "index.html")


app.mount("/css", StaticFiles(directory=str(BASE / "css")), name="css")
app.mount("/js", StaticFiles(directory=str(BASE / "js")), name="js")


def _port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def _open_browser_later():
    if NO_BROWSER:
        return
    def _open():
        time.sleep(1.2)                     # 等 uvicorn 就绪
        webbrowser.open(f"http://127.0.0.1:{PORT}/")
    threading.Thread(target=_open, daemon=True).start()


if __name__ == "__main__":
    if not _port_free(PORT):
        # 已有实例在跑：只开浏览器，不再起第二个后端
        print(f"端口 {PORT} 已有实例在运行，直接打开页面…")
        _open_browser_later()
        # 保持进程存活几秒等浏览器打开后退出（心跳由老实例接管）
        time.sleep(3)
        sys.exit(0)
    threading.Thread(target=_watchdog, daemon=True).start()
    _open_browser_later()
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning", use_colors=False)
