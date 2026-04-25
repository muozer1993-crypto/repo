#!/usr/bin/env python3
"""Reposition slots so they sit higher + larger on the table image.

Old rect set: y=0.55, h=0.25 — slots glued to the bottom edge of
the scene area, ~25% tall, so on a real table image they fell off
the edge of the wood. New rect set: y=0.28, h=0.50 — vertically
centered, 50% tall. Horizontally spread 0.04 → 0.98 with 4 evenly
sized slots (22% wide, 2% gaps).

Idempotent: re-running on already-migrated JSONs is a no-op.
"""

import json
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCENES = REPO / "assets" / "scenes"

# 4 slots × 22% width, 2% gap, starting at 4% left margin.
NEW_RECTS = [
    [0.04, 0.28, 0.22, 0.50],
    [0.28, 0.28, 0.22, 0.50],
    [0.52, 0.28, 0.22, 0.50],
    [0.76, 0.28, 0.22, 0.50],
]


def migrate(jp: Path):
    with open(jp, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    slots = data.get("slots", [])
    if not slots:
        return
    changed = False
    for i, slot in enumerate(slots):
        if i >= len(NEW_RECTS):
            break
        if slot.get("rect") != NEW_RECTS[i]:
            slot["rect"] = NEW_RECTS[i]
            changed = True
    if changed:
        with open(jp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        print(f"  ✓ {jp.relative_to(REPO)}")


def main():
    for jp in sorted(SCENES.glob("*.json")):
        migrate(jp)


if __name__ == "__main__":
    main()
