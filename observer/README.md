# Checkpoint Migration Observer

Read-only human-facing projection of the sealed Ignition v0.23 retained-checkpoint migration evidence.

From a checkout containing the v0.23 evidence, serve the repository locally and open the observer:

```bash
python3 -m http.server 8000
# open http://127.0.0.1:8000/observer/checkpoint-migration.html
```

The page reads `evidence/ignition-v0.23-retained-checkpoint-migration.json`, validates the expected schema, and renders the existing evidence as a step-through explanation of what was built, retained, and evicted. It does not execute Ignition, choose checkpoints, mutate evidence, or write canonical state.

Keyboard controls: Left/Right or PageUp/PageDown step through migrations; Home/End jump to the first/last migration. A local v0.23 JSON file can be inspected through the file picker; the file stays in the browser and is not uploaded.

If the evidence cannot be loaded or validated, the surface enters a visible `Held` state instead of inventing a fallback success.
