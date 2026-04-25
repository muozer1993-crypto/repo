#!/usr/bin/env python3
"""Generate dummy placeholder PNG assets for v2 scenes.

For each unique item across the scene + bonus JSONs, writes a 256x256
PNG with a coloured background + the item's Turkish label centred on
top. Caregivers later swap each PNG with a real photo or illustration
without touching code — file paths line up with what scene_repository
already loads.
"""

import json
import hashlib
import os
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parent.parent
ASSETS = REPO / "assets"
SCENES_DIR = ASSETS / "scenes"
BONUS_DIR = SCENES_DIR / "bonus"
IMG_DIR = ASSETS / "images"


def palette(seed: str) -> tuple:
    """Stable warm pastel from the item id."""
    h = int(hashlib.md5(seed.encode()).hexdigest(), 16)
    base_hues = [
        (250, 220, 180),  # peach
        (220, 240, 210),  # mint
        (240, 220, 240),  # lilac
        (200, 220, 240),  # sky
        (245, 230, 195),  # sand
        (220, 215, 200),  # khaki
        (235, 210, 215),  # blush
    ]
    return base_hues[h % len(base_hues)]


def find_font():
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    ]
    for p in candidates:
        if os.path.exists(p):
            return p
    return None


FONT_PATH = find_font()


def make_item_png(label: str, asset_path: Path):
    if asset_path.exists() and asset_path.stat().st_size > 0:
        return  # don't overwrite real assets
    asset_path.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGBA", (256, 256), palette(label) + (255,))
    draw = ImageDraw.Draw(img)
    # Soft border so the placeholder reads as a tile.
    draw.rectangle([4, 4, 252, 252], outline=(120, 100, 80, 255), width=4)
    if FONT_PATH:
        # Auto-fit the label.
        size = 48
        font = ImageFont.truetype(FONT_PATH, size)
        while size > 14:
            bbox = draw.textbbox((0, 0), label, font=font)
            w = bbox[2] - bbox[0]
            h = bbox[3] - bbox[1]
            if w < 220 and h < 80:
                break
            size -= 4
            font = ImageFont.truetype(FONT_PATH, size)
        bbox = draw.textbbox((0, 0), label, font=font)
        w = bbox[2] - bbox[0]
        h = bbox[3] - bbox[1]
        draw.text(
            ((256 - w) / 2, (256 - h) / 2 - bbox[1]),
            label,
            fill=(60, 50, 40, 255),
            font=font,
        )
    img.save(asset_path, "PNG")
    print(f"  + {asset_path.relative_to(REPO)}")


def make_bg_png(scene_id: str, asset_path: Path):
    if asset_path.exists() and asset_path.stat().st_size > 0:
        return
    asset_path.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGBA", (1024, 768), (233, 217, 183, 255))  # warm wood
    draw = ImageDraw.Draw(img)
    # Faint wood grain stripes.
    for y in range(0, 768, 16):
        draw.line([(0, y), (1024, y)], fill=(220, 200, 165, 80), width=1)
    # Outer rounded edge tone.
    draw.rectangle([0, 0, 1023, 767], outline=(170, 140, 95, 200), width=8)
    if FONT_PATH:
        font = ImageFont.truetype(FONT_PATH, 48)
        text = f"({scene_id})"
        bbox = draw.textbbox((0, 0), text, font=font)
        w = bbox[2] - bbox[0]
        draw.text(
            ((1024 - w) / 2, 700),
            text,
            fill=(140, 120, 90, 180),
            font=font,
        )
    img.save(asset_path, "PNG")
    print(f"  + {asset_path.relative_to(REPO)}")


def collect_scene_files():
    files = list(SCENES_DIR.glob("*.json"))
    if BONUS_DIR.exists():
        files.extend(BONUS_DIR.glob("*.json"))
    return files


def gather_items():
    """Walk every scene/bonus JSON, yield (label, asset_path) tuples."""
    seen_paths = set()
    for jf in collect_scene_files():
        with open(jf, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        # Background asset (per-scene).
        bg = data.get("backgroundAsset")
        if bg and bg not in seen_paths:
            seen_paths.add(bg)
            yield ("__bg__", data.get("id", jf.stem), REPO / bg)
        # itemPool
        for entry in data.get("itemPool", []) or []:
            asset = entry.get("assetPath")
            label = entry.get("labelTr", "")
            if asset and (asset, label) not in seen_paths:
                seen_paths.add((asset, label))
                yield ("__item__", label, REPO / asset)
        # variants[].items[]
        for variant in data.get("variants", []) or []:
            for entry in variant.get("items", []):
                asset = entry.get("assetPath")
                label = entry.get("labelTr", "")
                if asset and (asset, label) not in seen_paths:
                    seen_paths.add((asset, label))
                    yield ("__item__", label, REPO / asset)


def main():
    scene_count = 0
    item_count = 0
    for kind, label, path in gather_items():
        if kind == "__bg__":
            make_bg_png(label, path)
            scene_count += 1
        else:
            make_item_png(label, path)
            item_count += 1
    print(f"\n✓ {scene_count} background + {item_count} item placeholders")


if __name__ == "__main__":
    main()
