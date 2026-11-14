#!/usr/bin/env python3
"""Train a character LoRA for the comic, on the box, from a prepared dataset.

    python train_lora.py --data <dir with metadata.jsonl> --out <dir> [--steps 1000]

Small on purpose: no accelerate config, no datasets dependency, nothing
installed into the service's venv. Every image's latents and every caption's
embeddings are computed once up front (18 images, so that is seconds), and
only the LoRA on the UNet's attention trains.

Writes `pytorch_lora_weights.safetensors` into `--out`, and a checkpoint at
each `--save-every` into `--out/step-N/`, so an over-trained final can be
swapped for an earlier one without training again.
"""

import argparse
import json
import os
import random
import time

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

from diffusers import AutoencoderKL, DDPMScheduler, StableDiffusionXLPipeline, UNet2DConditionModel
from diffusers.training_utils import cast_training_params
from diffusers.utils import convert_state_dict_to_diffusers
from peft import LoraConfig
from peft.utils import get_peft_model_state_dict
from transformers import CLIPTextModel, CLIPTextModelWithProjection, CLIPTokenizer

VAE_ID = "madebyollin/sdxl-vae-fp16-fix"


def args_():
    p = argparse.ArgumentParser()
    p.add_argument("--model", default="cagliostrolab/animagine-xl-4.0")
    p.add_argument("--data", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--steps", type=int, default=1000)
    p.add_argument("--save-every", type=int, default=250)
    p.add_argument("--rank", type=int, default=16)
    p.add_argument("--lr", type=float, default=1e-4)
    p.add_argument("--batch", type=int, default=2)
    p.add_argument("--seed", type=int, default=1234)
    return p.parse_args()


def save(unet, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    layers = convert_state_dict_to_diffusers(get_peft_model_state_dict(unet))
    StableDiffusionXLPipeline.save_lora_weights(out_dir, unet_lora_layers=layers, safe_serialization=True)


def main():
    a = args_()
    torch.manual_seed(a.seed)
    random.seed(a.seed)
    dev = "cuda"

    with open(os.path.join(a.data, "metadata.jsonl")) as fh:
        items = [json.loads(line) for line in fh if line.strip()]
    print(f"{len(items)} images, {a.steps} steps, batch {a.batch}, rank {a.rank}, lr {a.lr}", flush=True)

    # ---- frozen encoders: run once, then freed
    tok1 = CLIPTokenizer.from_pretrained(a.model, subfolder="tokenizer")
    tok2 = CLIPTokenizer.from_pretrained(a.model, subfolder="tokenizer_2")
    te1 = CLIPTextModel.from_pretrained(a.model, subfolder="text_encoder", torch_dtype=torch.float16).to(dev)
    te2 = CLIPTextModelWithProjection.from_pretrained(a.model, subfolder="text_encoder_2", torch_dtype=torch.float16).to(dev)
    vae = AutoencoderKL.from_pretrained(VAE_ID, torch_dtype=torch.float16).to(dev)

    @torch.no_grad()
    def encode_text(text):
        hidden, pooled = [], None
        for tok, enc in ((tok1, te1), (tok2, te2)):
            ids = tok(text, padding="max_length", max_length=tok.model_max_length, truncation=True, return_tensors="pt").input_ids.to(dev)
            out = enc(ids, output_hidden_states=True)
            if enc is te2:
                pooled = out[0]
            hidden.append(out.hidden_states[-2])
        return torch.cat(hidden, dim=-1), pooled

    @torch.no_grad()
    def encode_image(path):
        img = Image.open(path).convert("RGB")
        x = torch.from_numpy(np.asarray(img)).permute(2, 0, 1).float().div(127.5).sub(1).unsqueeze(0)
        return vae.encode(x.to(dev, torch.float16)).latent_dist.sample() * vae.config.scaling_factor

    latents, embeds, pooled = [], [], []
    for it in items:
        latents.append(encode_image(os.path.join(a.data, it["file_name"])))
        e, p = encode_text(it["text"])
        embeds.append(e)
        pooled.append(p)
    latents = torch.cat(latents).to(torch.bfloat16)
    embeds = torch.cat(embeds).to(torch.bfloat16)
    pooled = torch.cat(pooled).to(torch.bfloat16)
    del te1, te2, vae
    torch.cuda.empty_cache()

    # ---- the UNet, with LoRA on attention
    unet = UNet2DConditionModel.from_pretrained(a.model, subfolder="unet", torch_dtype=torch.bfloat16).to(dev)
    unet.requires_grad_(False)
    unet.add_adapter(LoraConfig(r=a.rank, lora_alpha=a.rank, init_lora_weights="gaussian",
                                target_modules=["to_k", "to_q", "to_v", "to_out.0"]))
    cast_training_params(unet, dtype=torch.float32)
    unet.enable_gradient_checkpointing()
    unet.train()

    sched = DDPMScheduler.from_pretrained(a.model, subfolder="scheduler")
    params = [p for p in unet.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=a.lr, weight_decay=1e-2)
    time_ids = torch.tensor([[1024, 1024, 0, 0, 1024, 1024]], device=dev, dtype=torch.bfloat16)
    print(f"prediction type {sched.config.prediction_type}, {sum(p.numel() for p in params) / 1e6:.1f}M trainable", flush=True)

    t0 = time.time()
    running = 0.0
    for step in range(1, a.steps + 1):
        idx = torch.tensor([random.randrange(len(items)) for _ in range(a.batch)], device=dev)
        lat = latents[idx]
        noise = torch.randn_like(lat)
        t = torch.randint(0, sched.config.num_train_timesteps, (a.batch,), device=dev).long()
        noisy = sched.add_noise(lat, noise, t)
        target = noise if sched.config.prediction_type == "epsilon" else sched.get_velocity(lat, noise, t)

        with torch.autocast("cuda", dtype=torch.bfloat16):
            pred = unet(noisy, t, encoder_hidden_states=embeds[idx],
                        added_cond_kwargs={"text_embeds": pooled[idx], "time_ids": time_ids.repeat(a.batch, 1)}).sample
        loss = F.mse_loss(pred.float(), target.float())
        loss.backward()
        torch.nn.utils.clip_grad_norm_(params, 1.0)
        opt.step()
        opt.zero_grad(set_to_none=True)

        running += loss.item()
        if step % 50 == 0:
            print(f"step {step}/{a.steps}  loss {running / 50:.4f}  {time.time() - t0:.0f}s", flush=True)
            running = 0.0
        if step % a.save_every == 0 and step < a.steps:
            save(unet, os.path.join(a.out, f"step-{step}"))

    save(unet, a.out)
    print(f"saved {a.out} in {time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
