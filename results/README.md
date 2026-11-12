# Evaluation results and demo

- [Comparison](evaluation.md): all ten incidents in both modes, including one failed execution.
- [Checkpoint](evaluation.json): configuration, source hashes, per-case scores and usage.
- `runs/`: twenty saved investigation artifacts.
- `traces/`: the twenty matching traces, including failures, retrieved evidence and tool histories.
- `source/`: exact engine, data, evaluation and package files hashed by the recorded comparison.
- [Demo video](demo/incidentlens-demo.mp4): a selected real passing dashboard run; [recording details](demo/README.md).

The saved comparison predates the final citation/reporting fixes. Its source fingerprint is preserved; the dashboard correctly marks it stale. Later focused checks completed 3/4 investigations, and the final checker fix is covered offline but awaits a live retry. See the root README for the remaining validation limits.

Raw artifacts retain paths recorded when they ran. For a historical `tracePath`, the trace with the same filename is now under `traces/`. Reports, scores, manifests and raw matching traces were preserved unchanged. Redundant development/debugging records are excluded from this repository.
