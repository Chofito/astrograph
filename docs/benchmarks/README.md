# Benchmarks

Recorded by `bun run bench -- <repo>`.

v1.0 target ([docs/testing.md](../testing.md) §6): peak RSS **&lt; 1.5 GB** on a ~2k-file repo. The helper fails if peak exceeds **2×** that.

`latest.json` is overwritten each run; keep notable Magento / app-repo snapshots next to it if you want a history.
