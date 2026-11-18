#!/usr/bin/env python3
"""Renders the raster Devboard icons from `public/favicon.svg`.

`public/favicon.ico` is the browser-tab fallback, `public/apple-touch-icon.png`
is an iOS home screen, and the binary embeds a copy of each under
`crates/devboard/assets/`. The mark is defined once, in the SVG, so this
generator reads that file: every rect's geometry, fill, and per-bar opacity
come from it, and nothing about the mark is restated here.

Run it from `.devboard` after an edit to the SVG:

    python3 scripts/generate-icons.py

`--check` renders in memory and exits nonzero when a checked-in raster, or the
embedded copy, differs from what the SVG now says. The workspace suite runs
that mode, so a divergence cannot land silently.
"""

from __future__ import annotations

import math
import struct
import sys
import xml.etree.ElementTree as ET
import zlib
from dataclasses import dataclass
from pathlib import Path

HARNESS = Path(__file__).resolve().parent.parent
SOURCE = HARNESS / "public" / "favicon.svg"
DESTINATIONS = (HARNESS / "public", HARNESS / "crates" / "devboard" / "assets")
ICO_SIZES = (16, 32, 48)
APPLE_TOUCH_SIZE = 180
# Sub-scanlines per pixel row: coverage is exact across a row and sampled down
# it, which is the axis a rounded rectangle's edge curves along.
SUB_SCANLINES = 16
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
SVG = "{http://www.w3.org/2000/svg}"
DRAWN = {f"{SVG}rect"}
IGNORED = {f"{SVG}svg", f"{SVG}title", f"{SVG}desc", f"{SVG}g"}


@dataclass(frozen=True)
class Rect:
    """One rounded rectangle in the SVG's own units."""

    x: float
    y: float
    width: float
    height: float
    radius: float
    rgb: tuple[float, float, float]
    opacity: float


def fail(message: str) -> None:
    print(f"generate-icons: {message}", file=sys.stderr)
    raise SystemExit(1)


def number(element: ET.Element, name: str, default: float | None = None) -> float:
    value = element.get(name)
    if value is None:
        if default is None:
            fail(f"<{element.tag.replace(SVG, '')}> has no {name}")
        return default
    try:
        return float(value)
    except ValueError:
        fail(f"<rect> {name}={value!r} is not a number")


def colour(element: ET.Element) -> tuple[float, float, float]:
    value = element.get("fill", "#000000").strip().lower()
    if len(value) != 7 or not value.startswith("#"):
        fail(f"<rect> fill={value!r} is not a #rrggbb colour")
    try:
        return (int(value[1:3], 16) / 255.0,
                int(value[3:5], 16) / 255.0,
                int(value[5:7], 16) / 255.0)
    except ValueError:
        fail(f"<rect> fill={value!r} is not a #rrggbb colour")


def load_mark() -> tuple[list[Rect], tuple[float, float, float, float]]:
    """The SVG's rects in paint order, and its view box as x, y, width, height."""
    try:
        root = ET.parse(SOURCE).getroot()
    except (OSError, ET.ParseError) as error:
        fail(f"{SOURCE}: {error}")
    box = root.get("viewBox", "").replace(",", " ").split()
    if len(box) != 4:
        fail(f"{SOURCE} has no four-number viewBox")
    try:
        min_x, min_y, width, height = (float(entry) for entry in box)
    except ValueError:
        fail(f"{SOURCE} has a viewBox that is not four numbers")
    if width <= 0.0 or height <= 0.0:
        fail(f"{SOURCE} has an empty viewBox")
    if abs(width - height) > 1e-9:
        fail(f"{SOURCE} has a non-square viewBox, which the generator does not model")
    rects: list[Rect] = []
    for element in root.iter():
        tag = element.tag.replace(SVG, "")
        if element.get("transform"):
            fail(f"<{tag}> carries transform, which the generator does not model")
        if element.tag not in DRAWN:
            if element.tag in IGNORED:
                continue
            fail(f"<{tag}> is not modelled; extend the generator or remove it from the SVG")
        if element.get("stroke", "none") != "none":
            fail("<rect> carries a stroke, which the generator does not model")
        opacity = number(element, "fill-opacity", 1.0) * number(element, "opacity", 1.0)
        if not 0.0 <= opacity <= 1.0:
            fail(f"<rect> opacity {opacity} is outside 0..1")
        radius = number(element, "rx", 0.0)
        ry = number(element, "ry", radius)
        if abs(ry - radius) > 1e-9:
            fail("<rect> has rx and ry that differ, which the generator does not model")
        rects.append(Rect(
            x=number(element, "x", 0.0),
            y=number(element, "y", 0.0),
            width=number(element, "width"),
            height=number(element, "height"),
            radius=radius,
            rgb=colour(element),
            opacity=opacity,
        ))
    if not rects:
        fail(f"{SOURCE} draws no rect")
    return rects, (min_x, min_y, width, height)


@dataclass(frozen=True)
class Box:
    """One rect in pixel space."""

    left: float
    top: float
    right: float
    bottom: float
    radius: float


def box_of(rect: Rect, view: tuple[float, float, float, float], size: int) -> Box:
    min_x, min_y, units, _ = view
    scale = units / size
    left = (rect.x - min_x) / scale
    top = (rect.y - min_y) / scale
    # A renderer clamps a corner radius that reaches past the rect's middle.
    radius = min(rect.radius, rect.width / 2.0, rect.height / 2.0)
    return Box(
        left=left,
        top=top,
        right=left + rect.width / scale,
        bottom=top + rect.height / scale,
        radius=radius / scale,
    )


def span(box: Box, y: float) -> tuple[float, float] | None:
    """The box's covered x-interval at one y, or None above or below it."""
    if y < box.top or y > box.bottom:
        return None
    if box.radius <= 0.0:
        return box.left, box.right
    if y < box.top + box.radius:
        offset = box.top + box.radius - y
    elif y > box.bottom - box.radius:
        offset = y - (box.bottom - box.radius)
    else:
        return box.left, box.right
    inset = box.radius - math.sqrt(max(0.0, box.radius * box.radius - offset * offset))
    return box.left + inset, box.right - inset


def coverage(box: Box, size: int) -> list[float]:
    """Per-pixel coverage of one box, sampled down each row and exact across it."""
    values = [0.0] * (size * size)
    first_row = max(0, math.floor(box.top))
    last_row = min(size - 1, math.ceil(box.bottom) - 1)
    first_column = max(0, math.floor(box.left))
    last_column = min(size - 1, math.ceil(box.right) - 1)
    if first_row > last_row or first_column > last_column:
        return values
    weight = 1.0 / SUB_SCANLINES
    for row in range(first_row, last_row + 1):
        base = row * size
        for step in range(SUB_SCANLINES):
            interval = span(box, row + (step + 0.5) / SUB_SCANLINES)
            if interval is None:
                continue
            low, high = interval
            for column in range(max(first_column, math.floor(low)),
                                min(last_column, math.ceil(high) - 1) + 1):
                overlap = min(high, column + 1) - max(low, column)
                if overlap > 0.0:
                    values[base + column] += overlap * weight
    return values


def render(rects: list[Rect], view: tuple[float, float, float, float], size: int,
           flatten: tuple[float, float, float] | None = None) -> list[bytearray]:
    """Composite the rects over one another into RGBA rows, top row first.

    `flatten` composites the result onto one opaque colour, which is how an
    iOS home screen gets a square icon instead of transparent corners.
    """
    count = size * size
    red = [0.0] * count
    green = [0.0] * count
    blue = [0.0] * count
    alpha = [0.0] * count
    for rect in rects:
        mask = coverage(box_of(rect, view, size), size)
        for index in range(count):
            source = mask[index] * rect.opacity
            if source <= 0.0:
                continue
            keep = 1.0 - source
            red[index] = rect.rgb[0] * source + red[index] * keep
            green[index] = rect.rgb[1] * source + green[index] * keep
            blue[index] = rect.rgb[2] * source + blue[index] * keep
            alpha[index] = source + alpha[index] * keep
    rows: list[bytearray] = []
    for row in range(size):
        pixels = bytearray()
        for column in range(size):
            index = row * size + column
            opaque = alpha[index]
            if opaque > 0.0:
                channels = [red[index] / opaque, green[index] / opaque, blue[index] / opaque]
            else:
                channels = [0.0, 0.0, 0.0]
            if flatten is not None:
                channels = [channel * opaque + under * (1.0 - opaque)
                            for channel, under in zip(channels, flatten)]
                opaque = 1.0
            pixels.extend(byte(channel) for channel in channels)
            pixels.append(byte(opaque))
        rows.append(pixels)
    return rows


def byte(value: float) -> int:
    return max(0, min(255, int(value * 255.0 + 0.5)))


def png_chunk(tag: bytes, payload: bytes) -> bytes:
    return (struct.pack(">I", len(payload)) + tag + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))


def png_bytes(size: int, rows: list[bytearray]) -> bytes:
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    raw = b"".join(b"\x00" + bytes(row) for row in rows)
    return (PNG_SIGNATURE + png_chunk(b"IHDR", header)
            + png_chunk(b"IDAT", zlib.compress(raw, 9)) + png_chunk(b"IEND", b""))


def dib_bytes(size: int, rows: list[bytearray]) -> bytes:
    """One 32-bit bottom-up bitmap and its empty AND mask, as an ICO entry."""
    header = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0,
                         size * size * 4, 47244, 47244, 0, 0)
    pixels = bytearray()
    for row in reversed(rows):
        for column in range(size):
            red, green, blue, alpha = row[column * 4:column * 4 + 4]
            pixels.extend((blue, green, red, alpha))
    mask_row = (size + 31) // 32 * 4
    return header + bytes(pixels) + bytes(mask_row * size)


def ico_bytes(frames: list[tuple[int, list[bytearray]]]) -> bytes:
    entries = b""
    payload = b""
    offset = 6 + 16 * len(frames)
    for size, rows in frames:
        bitmap = dib_bytes(size, rows)
        entries += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32,
                               len(bitmap), offset)
        offset += len(bitmap)
        payload += bitmap
    return struct.pack("<HHH", 0, 1, len(frames)) + entries + payload


def artifacts() -> dict[str, bytes]:
    rects, view = load_mark()
    frames = [(size, render(rects, view, size)) for size in ICO_SIZES]
    return {
        "favicon.svg": SOURCE.read_bytes(),
        "favicon.ico": ico_bytes(frames),
        "apple-touch-icon.png": png_bytes(
            APPLE_TOUCH_SIZE,
            render(rects, view, APPLE_TOUCH_SIZE, flatten=rects[0].rgb),
        ),
    }


def main(argv: list[str]) -> int:
    arguments = argv[1:]
    unknown = [argument for argument in arguments if argument != "--check"]
    if unknown:
        fail(f"unknown argument {unknown[0]!r}; usage: generate-icons.py [--check]")
    check = "--check" in arguments
    stale: list[Path] = []
    for name, payload in artifacts().items():
        for directory in DESTINATIONS:
            path = directory / name
            if check:
                if not path.is_file() or path.read_bytes() != payload:
                    stale.append(path)
            else:
                path.write_bytes(payload)
                print(f"wrote {path.relative_to(HARNESS)}")
    if stale:
        for path in stale:
            print(f"stale: {path.relative_to(HARNESS)}", file=sys.stderr)
        print("run `python3 scripts/generate-icons.py` from .devboard and commit the result",
              file=sys.stderr)
        return 1
    if check:
        print("icons match favicon.svg")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
