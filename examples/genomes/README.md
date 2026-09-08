# Community Genomes

One self-contained Genome per directory. Install one from a clone of this repo:

```bash
rsih genome install examples/genomes/<name>
rsih :<name>
```

| Genome | What it is |
| --- | --- |
| [`paperlab`](paperlab/) | run paper experiments — scout real datasets and checkpoints, bootstrap a reproducible environment, operate long runs from observed state |

`paperlab` also ships as the built-in seed in
[`config/genomes/paperlab`](../../config/genomes/paperlab/); the two copies are
kept byte-identical by a test, so a change to one must reach the other. It
carries the full contract set for that reason — a community Genome that ships
only built-ins needs only the contracts its manifest references.

To contribute your own, see the
[contribution guide](../../docs/genome-community-contribute.md): one
self-contained directory, a unique `genome_id`, `rsih genome validate` passing,
and no private residue.
