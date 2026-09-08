---
name: experiment-bootstrap
description: Turn a selected dataset, model, and repository into a fast, reproducible smoke-tested environment.
---

# Experiment bootstrap

Use this skill after an experiment combination has been selected and must run on a local or remote machine.

## Inputs

- The chosen dataset, model or checkpoint, repository, revision, and metric.
- The target machine or server and its available compute.
- The expected data, image, cache, checkpoint, and artifact sizes.
- Existing project environment and storage conventions.

## Workflow

1. Read the repository's own instructions and existing lockfiles before choosing tools. Preserve the project's native environment manager when it is usable.
2. Run a read-only preflight for OS and architecture, writable filesystems, free space, memory, GPU and driver state, CUDA compatibility, network access, ports, and already-running workloads.
3. Estimate the footprint of datasets, package caches, model weights, container layers, checkpoints, and outputs. Detect a high-capacity writable volume that fits the estimate; do not assume `/data` exists and do not place heavy runtime state on a constrained system disk.
4. Keep source code separate from mutable runtime state. Point dataset roots, model caches, package caches, temporary directories, container storage, checkpoints, logs, and artifacts to the selected data volume while following existing project conventions.
5. Reuse the repository's environment definition. For a Python project without a working native choice, prefer `uv`; use Docker when the upstream project or evaluator requires isolation, system packages, or a fixed runtime boundary.
6. Record the code revision, dataset version or fingerprint, model identifier, relevant preprocessing, environment identity, launch parameters, and output root. Keep credentials in environment variables or an existing secret store and never echo them.
7. Take the shortest path to a real smoke test: use the smallest representative split or sample, minimal steps or turns, one worker or GPU where possible, and the actual evaluation path. Do not scale based only on imports or a synthetic no-op.
8. Diagnose failures at the first incompatible boundary: data loading, preprocessing, framework import, checkpoint loading, device placement, forward pass, metric execution, or artifact writing.
9. Once the smoke test passes, backfill the lockfile, checksums, provenance, exact command, and resource notes required to rerun it before launching the expensive experiment.

## Done

The bootstrap is complete when the smallest real sample reaches the real metric and writes an inspectable result artifact, with an exact rerun command and recorded identities. If it cannot, report the precise blocker, observed evidence, and cheapest next experiment instead of claiming the environment is ready.
