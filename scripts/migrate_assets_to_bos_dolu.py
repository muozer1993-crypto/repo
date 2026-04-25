#!/usr/bin/env python3
"""Migrate scene JSONs to v2 bos_/dolu_ naming convention.

For each main scene JSON:
  * backgroundAsset:  ".../<scene>_bg.png" → ".../bos_<area>.png"
                       (or .../masa_bg.png → bos_masa.png etc.)
  * slots[*]: adds emptyAssetPath = ".../<scene-folder>/bos_<itemId>.png"
              built from acceptedItemId.
  * items in itemPool + variants[*].items[*]:
      assetPath ".../folder/<id>.png" → ".../folder/dolu_<id>.png"
      (only when the file lives under the scene folder, not the
       distractors folder; distractors keep their flat id.png so
       the same file is reused across scenes.)

Idempotent: re-runs leave already-migrated files unchanged.
"""

import json
import os
import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCENES = REPO / "assets" / "scenes"

# Map scene folder → bos_<area> name. The "area" reflects the
# physical surface depicted, not the meal — sabah is breakfast on a
# masa, oglen is lunch on a sofra, ikindi tea on a masa, aksam
# bedside on a komodin.
AREA_BY_FOLDER = {
    "sabah": "masa",
    "oglen": "sofra",
    "ikindi": "masa",
    "aksam": "komodin",
}


def folder_of(asset: str) -> str | None:
    """Pull the scene-folder name out of an asset path like
    'assets/images/scenes/sabah/foo.png'."""
    m = re.match(r"assets/images/scenes/([^/]+)/", asset)
    if not m:
        return None
    return m.group(1)


def migrate_item_asset(asset: str) -> str:
    """Prepend dolu_ to the basename when the asset lives in a
    main-scene folder (sabah/oglen/ikindi/aksam). Distractors and
    bonus paths are returned untouched."""
    if asset is None:
        return asset
    folder = folder_of(asset)
    if folder not in AREA_BY_FOLDER:
        return asset  # distractors/, bonus/ — leave alone
    base = os.path.basename(asset)
    if base.startswith("dolu_"):
        return asset
    return f"assets/images/scenes/{folder}/dolu_{base}"


def migrate_bg(asset: str) -> str:
    """foo_bg.png → bos_<area>.png based on the folder."""
    folder = folder_of(asset)
    if folder not in AREA_BY_FOLDER:
        return asset
    area = AREA_BY_FOLDER[folder]
    return f"assets/images/scenes/{folder}/bos_{area}.png"


def empty_for(folder: str, item_id: str) -> str:
    return f"assets/images/scenes/{folder}/bos_{item_id}.png"


def migrate_main(jp: Path):
    with open(jp, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    folder = folder_of(data.get("backgroundAsset", ""))
    if folder not in AREA_BY_FOLDER:
        print(f"  skip {jp.name} (unknown folder)")
        return
    # background
    data["backgroundAsset"] = migrate_bg(data["backgroundAsset"])
    # slots — add emptyAssetPath
    for slot in data.get("slots", []):
        slot["emptyAssetPath"] = empty_for(folder, slot["acceptedItemId"])
    # itemPool
    for entry in data.get("itemPool", []) or []:
        if "assetPath" in entry:
            entry["assetPath"] = migrate_item_asset(entry["assetPath"])
    # variant items
    for variant in data.get("variants", []):
        for entry in variant.get("items", []):
            if "assetPath" in entry:
                entry["assetPath"] = migrate_item_asset(entry["assetPath"])
    with open(jp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    print(f"  ✓ {jp.relative_to(REPO)}")


def migrate_bonus(jp: Path):
    """Bonus scenes reference shared scene items by their dolu_ path."""
    with open(jp, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    changed = False
    for entry in data.get("itemPool", []) or []:
        asset = entry.get("assetPath")
        if not asset:
            continue
        new_asset = migrate_item_asset(asset)
        if new_asset != asset:
            entry["assetPath"] = new_asset
            changed = True
    if changed:
        with open(jp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        print(f"  ✓ {jp.relative_to(REPO)}")


def main():
    for jp in sorted(SCENES.glob("*.json")):
        migrate_main(jp)
    bonus_dir = SCENES / "bonus"
    if bonus_dir.exists():
        for jp in sorted(bonus_dir.glob("*.json")):
            migrate_bonus(jp)


if __name__ == "__main__":
    main()
