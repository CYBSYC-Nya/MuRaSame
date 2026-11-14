#!/usr/bin/env python3
"""Local image inspection / optimisation worker for dsh-creative-console.

Only Pillow is required. The host calls this file with simple CLI arguments and
reads one JSON object from stdout, so no Python package is installed globally.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys

from PIL import Image, ImageOps, ImageFilter, UnidentifiedImageError

Image.MAX_IMAGE_PIXELS = 220_000_000

FORMAT_ALIASES = {
    "jpg": "JPEG",
    "jpeg": "JPEG",
    "png": "PNG",
    "webp": "WEBP",
    "avif": "AVIF",
}

MIME = {
    "JPEG": "image/jpeg",
    "PNG": "image/png",
    "WEBP": "image/webp",
    "AVIF": "image/avif",
}


def fail(message: str) -> "None":
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    raise SystemExit(0)


def open_image(path: str) -> Image.Image:
    if not os.path.isfile(path):
        fail(f"文件不存在：{path}")
    try:
        image = Image.open(path)
        image.load()
    except UnidentifiedImageError:
        fail("无法识别这个图片格式（Pillow 不支持，或文件已损坏）")
    except OSError as exc:
        fail(f"读取图片失败：{exc}")
    return ImageOps.exif_transpose(image)


def preview_data_url(image: Image.Image, max_side: int = 720, quality: int = 78) -> str:
    copy = image.copy()
    copy.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    if copy.mode in ("RGBA", "LA"):
        background = Image.new("RGB", copy.size, (24, 25, 30))
        background.paste(copy, mask=copy.getchannel("A"))
        copy = background
    elif copy.mode != "RGB":
        copy = copy.convert("RGB")
    buffer = io.BytesIO()
    copy.save(buffer, format="JPEG", quality=quality, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def inspect(path: str) -> dict:
    image = open_image(path)
    return {
        "ok": True,
        "width": image.width,
        "height": image.height,
        "format": image.format or "UNKNOWN",
        "mode": image.mode,
        "bytes": os.path.getsize(path),
        "name": os.path.basename(path),
        "path": os.path.abspath(path),
        "preview": preview_data_url(image),
    }


def encode(image: Image.Image, fmt: str, quality: int, strip: bool) -> bytes:
    buffer = io.BytesIO()
    save_args: dict = {}
    if fmt == "JPEG":
        if image.mode in ("RGBA", "LA"):
            # JPEG has no alpha channel; flatten onto white rather than emitting
            # a black background.
            rgba = image.convert("RGBA")
            canvas = Image.new("RGB", rgba.size, (255, 255, 255))
            canvas.paste(rgba, mask=rgba.getchannel("A"))
            image = canvas
        elif image.mode != "RGB":
            image = image.convert("RGB")
        save_args.update(
            format="JPEG",
            quality=quality,
            optimize=True,
            progressive=True,
            subsampling=0,
        )
    elif fmt == "WEBP":
        save_args.update(format="WEBP", quality=quality, method=6)
    elif fmt == "PNG":
        if image.mode == "P":
            image = image.convert("RGBA" if "transparency" in image.info else "RGB")
        save_args.update(format="PNG", optimize=True, compress_level=9)
    elif fmt == "AVIF":
        save_args.update(format="AVIF", quality=quality)
    else:
        fail(f"不支持的输出格式：{fmt}")

    if strip:
        save_args["exif"] = b""
    elif fmt == "JPEG":
        exif = image.info.get("exif")
        if exif:
            save_args["exif"] = exif
    image.save(buffer, **save_args)
    return buffer.getvalue()


def resize(image: Image.Image, max_w: int, max_h: int, mode: str) -> Image.Image:
    max_w = max(16, int(max_w))
    max_h = max(16, int(max_h))
    if mode == "crop":
        return ImageOps.fit(
            image,
            (max_w, max_h),
            method=Image.Resampling.LANCZOS,
            centering=(0.5, 0.5),
        )
    # fit: never upscale, keep the whole frame.
    if image.width <= max_w and image.height <= max_h:
        return image.copy()
    copy = image.copy()
    copy.thumbnail((max_w, max_h), Image.Resampling.LANCZOS)
    return copy


def enhance(image: Image.Image) -> Image.Image:
    alpha = None
    if image.mode in ("RGBA", "LA"):
        alpha = image.getchannel("A")
    rgb = image.convert("RGB")
    rgb = ImageOps.autocontrast(rgb, cutoff=1)
    rgb = rgb.filter(ImageFilter.UnsharpMask(radius=1.15, percent=85, threshold=3))
    if alpha is not None:
        rgb = rgb.convert("RGBA")
        rgb.putalpha(alpha)
    return rgb


def optimise(args: argparse.Namespace) -> dict:
    image = open_image(args.input)
    before_width, before_height = image.width, image.height
    before_bytes = os.path.getsize(args.input)

    fmt = FORMAT_ALIASES.get(args.format.lower())
    if fmt is None:
        fail(f"不支持的输出格式：{args.format}")

    out = resize(image, args.max_width, args.max_height, args.mode)
    if args.enhance:
        out = enhance(out)
    data = encode(out, fmt, max(1, min(100, int(args.quality))), bool(args.strip))

    os.makedirs(os.path.dirname(os.path.abspath(args.output)) or ".", exist_ok=True)
    tmp = args.output + ".tmp"
    with open(tmp, "wb") as handle:
        handle.write(data)
    os.replace(tmp, args.output)

    # Re-open the encoded result so previews reflect the actual saved pixels.
    with Image.open(args.output) as saved:
        saved.load()
        preview = preview_data_url(saved)
        out_width, out_height = saved.width, saved.height
        out_format = saved.format or fmt

    return {
        "ok": True,
        "path": os.path.abspath(args.output),
        "name": os.path.basename(args.output),
        "format": out_format,
        "mime": MIME.get(out_format, "application/octet-stream"),
        "bytes": len(data),
        "beforeBytes": before_bytes,
        "savedBytes": before_bytes - len(data),
        "savedPercent": round((1 - len(data) / before_bytes) * 100, 1) if before_bytes else 0,
        "width": out_width,
        "height": out_height,
        "beforeWidth": before_width,
        "beforeHeight": before_height,
        "preview": preview,
        "enhanced": bool(args.enhance),
        "mode": args.mode,
        "quality": int(args.quality),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    p_inspect = sub.add_parser("inspect")
    p_inspect.add_argument("input")

    p_opt = sub.add_parser("optimize")
    p_opt.add_argument("--input", required=True)
    p_opt.add_argument("--output", required=True)
    p_opt.add_argument("--format", default="webp")
    p_opt.add_argument("--quality", default=82)
    p_opt.add_argument("--max-width", default=1920)
    p_opt.add_argument("--max-height", default=1920)
    p_opt.add_argument("--mode", choices=["fit", "crop"], default="fit")
    p_opt.add_argument("--enhance", action="store_true")
    p_opt.add_argument("--strip", action="store_true")

    args = parser.parse_args()
    try:
        if args.command == "inspect":
            result = inspect(args.input)
        else:
            result = optimise(args)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - one JSON error is the CLI contract
        fail(f"{type(exc).__name__}: {exc}")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
