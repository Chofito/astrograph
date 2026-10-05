# Benchmarks

Recorded by `bun run bench -- <repo>`.

`v0.1.0` preview gate ([docs/testing.md](../testing.md) §6): peak RSS **≤ 1.5 GiB** on the accepted representative ~2k-file corpus. The current helper fails only above **2×** its configured target, so a helper pass is diagnostic and does not by itself satisfy the release gate.

`latest.json` is overwritten each run; keep notable Magento / app-repo snapshots next to it if you want a history.
