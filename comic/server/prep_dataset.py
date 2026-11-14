#!/usr/bin/env python3
"""Cut the lustyx training images out of their sources, square and captioned.

    python prep_dataset.py <dataset.json> <src dir> <out dir>

Each image is cropped to its `box`, scaled to fit 1024x1024 without
distortion, and centred on the paper colour of the pilot pages. Padding
rather than cropping to square, because most boxes are tall full-body
figures and a centre crop would cut off the boots, which are canon.

Writes `<out>/NN.png` and `<out>/metadata.jsonl` ({"file_name", "text"}),
and `<out>/contact.jpg`, every crop at thumbnail size, for checking the
boxes by eye before spending GPU time on them.
"""

import json
import os
import sys

from PIL import Image

SIZE = 1024
PAPER = (242, 234, 219)


def main():
    spec_path, src_dir, out_dir = sys.argv[1:4]
    with open(spec_path) as fh:
        spec = json.load(fh)

    os.makedirs(out_dir, exist_ok=True)
    thumbs = []
    with open(os.path.join(out_dir, "metadata.jsonl"), "w") as meta:
        for i, item in enumerate(spec["images"]):
            img = Image.open(os.path.join(src_dir, item["src"])).convert("RGB")
            if "box" in item:
                img = img.crop(tuple(item["box"]))

            scale = SIZE / max(img.size)
            img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
            square = Image.new("RGB", (SIZE, SIZE), PAPER)
            square.paste(img, ((SIZE - img.width) // 2, (SIZE - img.height) // 2))

            name = f"{i:02d}.png"
            square.save(os.path.join(out_dir, name))
            meta.write(json.dumps({"file_name": name, "text": item["caption"]}) + "\n")
            thumbs.append(square.resize((256, 256)))

    cols = 6
    rows = (len(thumbs) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * 256, rows * 256), (255, 255, 255))
    for i, t in enumerate(thumbs):
        sheet.paste(t, ((i % cols) * 256, (i // cols) * 256))
    sheet.save(os.path.join(out_dir, "contact.jpg"), quality=85)
    print(f"{len(thumbs)} images -> {out_dir}")


if __name__ == "__main__":
    main()
