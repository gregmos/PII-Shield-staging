PII Shield model cache
======================

This folder contains a cached PII detection model used by the PII Shield plugin.

Files:
  pii_shield_model__knowledgator_gliner-pii-base-v1.0__model_onnx__sha256-<hash>.onnx   (~665 MB)
  pii_shield_tokenizer__knowledgator_gliner-pii-base-v1.0/                                                (~10 MB)

Where it came from:
  HuggingFace repo: knowledgator/gliner-pii-base-v1.0

What it does:
  PII Shield uses this model locally to detect names, organizations, locations,
  and other PII in documents. The model never leaves your machine.

Is it safe to delete?
  Yes. PII Shield will re-download it on next use (~5 minutes).

Can I move it?
  Yes. Put it anywhere — PII Shield searches your workspace, parent directory,
  Downloads folder, and home directory on startup. The filename is the marker.
  For best results, keep it somewhere stable like ~/Downloads or a dedicated
  cache folder, so it survives across sessions.
