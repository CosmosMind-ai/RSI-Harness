---
name: experiment-run-ops
description: Launch, monitor, diagnose, and safely resume long local or remote experiments from observed state.
---

# Experiment run operations

Use this skill when an experiment must be launched, monitored, diagnosed, repaired, or resumed without losing completed work.

## Inputs

- The local or SSH target, using existing host configuration rather than embedded credentials.
- The run identifier, launch command, code revision, and configuration.
- The run root and known checkpoint, log, result, and artifact locations.

## Launch

1. Inspect existing processes and run directories before starting anything. Never overwrite or duplicate an active run.
2. Confirm the code revision, dataset and model identity, environment, storage root, concurrency, output budget, and expected completion signal.
3. Assign a stable run ID and separate code, logs, checkpoints, results, and immutable inputs according to the project's conventions.
4. Launch so the process survives the interactive shell when a long run requires it. Capture the PID or service identity, stdout and stderr, start time, exact command, and checkpoint path.
5. Verify startup with observed evidence: the process remains alive, the model or service is reachable if applicable, the first real item advances, and logs contain no immediate fatal error.

## Status inspection

1. Read the live process or service state, not only a PID file.
2. Read the current checkpoint stage and timestamp, plus stage-specific counters.
3. Count completed result artifacts. Treat created directories, scheduled cases, queue entries, and in-flight requests as different from completed work.
4. Inspect recent stdout and stderr, disk and inode availability, memory, GPU utilization and memory, model-service queues, and provider or network errors.
5. Compare at least two observations before estimating throughput or ETA. State the basis and uncertainty instead of inventing precision.
6. Report observed facts first: run identity, revision, data/model/config identity, process state, checkpoint, completed/failed/in-flight counts, latest error, resources, and next action.

## Repair and resume

1. Classify the failure as code or model-output handling, data, environment, storage capacity, provider or network, resource exhaustion, or expected task failure.
2. Preserve logs, checkpoints, completed results, and the failing artifact before changing anything.
3. Fix the smallest reproducible cause and run the narrowest relevant test or smoke check. Do not rewrite unrelated infrastructure during a live experiment.
4. Synchronize the exact intended code revision or verify file hashes. Keep source changes distinct from runtime artifacts and do not expose credentials.
5. Resume the same run from its last valid checkpoint when supported. Do not create a fresh run or recompute completed work merely because the interactive connection was interrupted.
6. After resuming, verify that counters advance from the prior checkpoint and that completed artifacts were reused.
7. Stop and report an external blocker when access, quota, provider availability, hardware, or missing source data cannot be repaired locally.

## Done

Run operations are complete only when result artifacts prove the experiment reached its defined endpoint, or observed evidence proves an external blocker. A launch message, directory count, stale summary, or surviving process alone is not completion.
