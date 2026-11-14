#!/usr/bin/env python3
"""The comic's renderer: Animagine XL 4.0, plus a character LoRA when given one.

    python render.py job.json

Its own script rather than the service's `txt2img.py`, which has no LoRA
support for SDXL and would mean changing the GIF service to get it. The job
file carries everything, so `make.js` decides the settings and this only
draws:

    {"model", "lora", "lora_scale", "prompts", "negative", "seed", "count",
     "width", "height", "steps", "guidance", "out"}

One JSON line per image on stdout, in order: {"prompt", "seed", "seconds",
"path"}. Image k of the run is seed + k, so a run is reproducible.
"""

import json
import os
import sys
import time

import torch
from diffusers import AutoencoderKL, EulerAncestralDiscreteScheduler, StableDiffusionXLPipeline

VAE_ID = "madebyollin/sdxl-vae-fp16-fix"


def main():
    with open(sys.argv[1]) as fh:
        job = json.load(fh)

    vae = AutoencoderKL.from_pretrained(VAE_ID, torch_dtype=torch.float16)
    pipe = StableDiffusionXLPipeline.from_pretrained(job["model"], vae=vae, torch_dtype=torch.float16, add_watermarker=False)
    pipe.scheduler = EulerAncestralDiscreteScheduler.from_config(pipe.scheduler.config)
    if job.get("lora"):
        pipe.load_lora_weights(job["lora"], adapter_name="character")
        pipe.set_adapters(["character"], adapter_weights=[job.get("lora_scale", 1.0)])
    pipe.to("cuda")
    pipe.set_progress_bar_config(disable=True)

    os.makedirs(job["out"], exist_ok=True)
    k = 0
    for prompt in job["prompts"]:
        for _ in range(job.get("count", 1)):
            seed = job["seed"] + k
            t = time.time()
            image = pipe(
                prompt=prompt,
                negative_prompt=job["negative"],
                num_inference_steps=job["steps"],
                guidance_scale=job["guidance"],
                width=job["width"],
                height=job["height"],
                generator=torch.Generator(device="cpu").manual_seed(seed),
            ).images[0]
            path = os.path.join(job["out"], f"{k:03d}.png")
            image.save(path)
            print(json.dumps({"prompt": prompt, "seed": seed, "seconds": round(time.time() - t, 1), "path": path}), flush=True)
            k += 1


if __name__ == "__main__":
    main()
