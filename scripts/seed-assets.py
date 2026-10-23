"""Seed BabelDOC's asset cache from the ModelScope mirror.

`babeldoc --warmup` probes several asset upstreams and keeps whichever answers
its metadata request first, then downloads everything from that one. On
networks where that winner is unreachable for bulk downloads, warmup fails
with `ConnectTimeout` even though a Chinese mirror works fine. This script
pins every upstream to ModelScope, downloads the same files two at a time (180
concurrent connections stall on the same networks), verifies each with the
sha3-256 digest BabelDOC records, and leaves the cache byte-identical to a
successful warmup.

Run it with the plugin's own interpreter:

    C:\\Users\\<you>\\.dsh\\babeldoc\\venv\\Scripts\\python.exe seed-assets.py
"""
import hashlib
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

from babeldoc.assets.embedding_assets_metadata import (
    CMAP_METADATA,
    DOCLAYOUT_YOLO_DOCSTRUCTBENCH_IMGSZ1024ONNX_SHA3_256,
    EMBEDDING_FONT_METADATA,
)
from babeldoc.const import get_cache_file_path

MS = "https://www.modelscope.cn/datasets/awwaawwa/BabelDOCAssets/resolve/master"
ONNX_URL = (
    "https://www.modelscope.cn/models/AI-ModelScope/"
    "DocLayout-YOLO-DocStructBench-onnx/resolve/master/"
    "doclayout_yolo_docstructbench_imgsz1024.onnx"
)
HEADERS = {"User-Agent": "babeldoc-seed/1.0"}
LOG_PATH = Path(tempfile.gettempdir()) / "babeldoc-seed.log"
log_file = open(LOG_PATH, "w", encoding="utf-8")


def log(message: str) -> None:
    line = f"{time.strftime('%H:%M:%S')} {message}"
    print(line, flush=True)
    log_file.write(line + "\n")
    log_file.flush()


def digest_of(path: Path) -> str:
    hasher = hashlib.sha3_256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            hasher.update(block)
    return hasher.hexdigest()


def fetch(url: str, path: Path, expected: str) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and digest_of(path) == expected:
        return "cached"
    partial = path.with_name(path.name + ".part")
    timeout = httpx.Timeout(connect=15.0, read=60.0, write=60.0, pool=15.0)
    with httpx.Client(headers=HEADERS, timeout=timeout, follow_redirects=True) as client:
        with client.stream("GET", url) as response:
            response.raise_for_status()
            with open(partial, "wb") as handle:
                for chunk in response.iter_bytes(1 << 16):
                    handle.write(chunk)
    got = digest_of(partial)
    if got != expected:
        partial.unlink(missing_ok=True)
        raise ValueError(f"hash mismatch for {path.name}: {got}")
    partial.replace(path)
    return "downloaded"


def job(task) -> bool:
    name, url, path, expected = task
    for attempt in range(1, 4):
        try:
            result = fetch(url, path, expected)
            log(f"{result:10s} {name} ({path.stat().st_size // 1024} KB)")
            return True
        except Exception as error:  # noqa: BLE001
            if attempt == 3:
                log(f"FAILED     {name}: {type(error).__name__}: {error}")
                return False
            time.sleep(2 * attempt)
    return False


def main() -> int:
    tasks = [(
        "doclayout_yolo_docstructbench_imgsz1024.onnx",
        ONNX_URL,
        get_cache_file_path("doclayout_yolo_docstructbench_imgsz1024.onnx", "models"),
        DOCLAYOUT_YOLO_DOCSTRUCTBENCH_IMGSZ1024ONNX_SHA3_256,
    )]
    for font_name, meta in EMBEDDING_FONT_METADATA.items():
        tasks.append((font_name, f"{MS}/fonts/{font_name}", get_cache_file_path(font_name, "fonts"), meta["sha3_256"]))
    for cmap_name, meta in CMAP_METADATA.items():
        tasks.append((cmap_name, f"{MS}/cmap/{cmap_name}", get_cache_file_path(cmap_name, "cmap"), meta["sha3_256"]))

    log(f"{len(tasks)} assets to verify, log at {LOG_PATH}")
    started = time.time()
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(job, tasks))

    failures = results.count(False)
    log(f"done: {results.count(True)} ok, {failures} failed, {round(time.time() - started)}s")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
