---
name: research-experiment-scout
description: Find and compare real datasets, model checkpoints, repositories, and metrics for a paper experiment.
---

# Research experiment scouting

Use this skill when a paper, research question, claim, benchmark idea, or existing repository needs to become a concrete experiment.

## Inputs

- The paper, claim, research question, or repository to investigate.
- The task type and the result the experiment should measure.
- Compute, storage, access, time, and licensing constraints.
- Any required baseline, metric, dataset family, or model family.

## Workflow

1. State the decision the experiment must support: the real pain point, the key unknown, the measurable claim, and what outcome would change the user's conclusion.
2. Inspect local papers, notes, repositories, and existing evaluation code before searching externally.
3. Search primary literature, official dataset pages, first-party model cards, and canonical repositories. Use secondary summaries only to discover primary sources.
4. Build a candidate matrix. For every dataset, record its owner, primary URL, version or date, license and access conditions, size, format, splits, labels, task fit, metric compatibility, known leakage or contamination risk, and whether the asset is real, synthetic, mirrored, incomplete, or unverified.
5. For every model or implementation, record the paper, canonical repository and revision, checkpoint identifier, license, expected preprocessing, framework versions, hardware needs, and compatibility with each dataset and metric.
6. Reject pairings whose preprocessing, labels, split semantics, modality, metric, or license do not support the target claim. Do not treat popularity as compatibility.
7. Prefer real assets from official or primary sources. When rapid exploration requires a mirror, sample, synthetic proxy, or uncertain source, label that debt explicitly rather than presenting it as equivalent evidence.
8. Select one smallest viable experiment and one fallback. Provide acquisition commands, expected disk footprint, a minimal sample strategy, the baseline and metric, and the reasons for the selection.

## Done

Return an executable experiment brief containing the selected dataset, model or baseline, repository, metric, acquisition route, estimated resources, primary evidence links, unresolved assumptions, and a fallback. The brief is not done if data, model, environment, and evaluation compatibility are considered separately.
