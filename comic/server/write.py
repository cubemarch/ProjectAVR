#!/usr/bin/env python3
"""Write a strip's script on the box, with an open-weights model.

    python write.py job.json

The same strategy as the GIF service: an open model on the A100, billed as
GPU time, instead of a partner model bought through Vertex. Qwen2.5-14B-
Instruct, Apache-2.0, ~30GB in bf16, which fits on the 40GB card on its own;
`render.py` runs after this exits, never beside it.

The job file is {"model", "system", "user", "max_new_tokens", "temperature"}.
Prints the model's reply on stdout between two marker lines, so the caller
can find it among library warnings.
"""

import json
import sys

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer


def main():
    with open(sys.argv[1]) as fh:
        job = json.load(fh)

    tok = AutoTokenizer.from_pretrained(job["model"])
    model = AutoModelForCausalLM.from_pretrained(job["model"], torch_dtype=torch.bfloat16, device_map="cuda")

    messages = [{"role": "system", "content": job["system"]}, {"role": "user", "content": job["user"]}]
    prompt = tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = tok([prompt], return_tensors="pt").to(model.device)

    out = model.generate(
        **inputs,
        max_new_tokens=job.get("max_new_tokens", 3000),
        do_sample=True,
        temperature=job.get("temperature", 0.7),
        top_p=0.9,
    )
    reply = tok.decode(out[0][inputs.input_ids.shape[1]:], skip_special_tokens=True)

    print("-----BEGIN SCRIPT-----")
    print(reply)
    print("-----END SCRIPT-----", flush=True)


if __name__ == "__main__":
    main()
