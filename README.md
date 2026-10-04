# Runtime monorepo

Local Apple Silicon runtime snapshot: Splash source, global OpenCode configuration,
and the model launcher. Initial annotated release: `v0.1.0`.

## Contents

- `splash/`: Splash source and development tools, including the current uncommitted benchmark work. This is ordinary source in this repository, with no nested Git repository or submodule.
- `opencode/`: active global configuration, CLI settings, instructions, prompts, commands, four plugins, dependency lockfile, and focused regression tests.
- `startllamacpp.sh`: launcher with its current model menu and option-14 settings.
- `scripts/`: watchdog, monitors, Markdown converter and its Lua filter, configuration installer, and validation tools.
- `provenance/`: original Splash commit, dirty-file inventory, source hashes, and hashes of the imported files after path normalization.

The Splash import preserves its Apache-2.0 license and third-party notices.
This repository records a working-tree snapshot; upstream Git history remains
in the original Splash checkout.

## Use

Requirements: Apple Silicon, macOS 26.4 or newer, Python 3.12-3.14, Node supporting
TypeScript stripping (Node 26.10.0 was used for verification), OpenCode 2.0.20,
and `bash`, `jq`, `curl`, `lsof`, and `pkill`. Native Splash builds also need
the Apple command-line and Metal toolchains described in `splash/DEVELOPMENT.md`.
Splash's launcher installs its Python dependencies and builds from source when needed.

```bash
cd /Users/mymac/runtime
python3 scripts/install-opencode.py
./startllamacpp.sh --direct 14
```

The installer expands config path placeholders and copies the configuration to
`~/.config/opencode`, backing up files it replaces. It does not install a project
OpenCode override, start a server, install packages, or copy authentication state.
Its optional `--destination DIRECTORY` supports an isolated configuration install.
Restart OpenCode after installation to use the copied configuration consistently.

Option 14 uses `splash/splash` from this repository by default. An explicit
`SPLASH_BIN` overrides that selection. Models, persistent KV cache, and logs stay
outside this repository. The model downloads on first use if it is unavailable.
Only run one OpenCode job at a time on the 16 GB profile.

| Option-14 setting | Captured default |
| --- | --- |
| Model | `prism-ml/Ternary-Bonsai-2-27B-gguf:PTQ1_0` |
| Served name | `bonsai-27b-splash` |
| Server / OpenCode context | 24,576 / 22,528 tokens |
| Output | 1,024 tokens |
| KV | INT8 |
| Prefill chunks | 512 tokens |
| Active native requests | 1 |
| Persistent disk cache | 8 GiB, retained across restarts |
| Resource wait | 60 seconds |

These are captured launcher settings, not a guarantee that every context fits
with other applications running. The imported OpenCode `AGENTS.md` retains its
earlier, more conservative 14K server / 12,288 client policy; use explicit lower
launcher overrides when following that policy. No serving settings were retuned
as part of this import.

For other menu entries, install their external runtimes and model files separately:
Homebrew llama.cpp, the Prism llama.cpp fork under `~/prism-llama.cpp`, and/or the
MLX environment under `~/mlx-project`. Existing model paths use `~/.lmstudio/models`.
The optional Hermes entry requires `~/.local/bin/hermeslocal`; Hermes is external
to this snapshot. `LLAMA_SERVER`, `PRISM_LLAMA_SERVER`, and `SPLASH_BIN` can override
runtime locations. The bundled Markdown converter additionally needs Pandoc and,
for PDF output, XeLaTeX.

## Verify

```bash
make check
make test-launcher
make test-opencode
make test-opencode-native
```

The native OpenCode regression uses a temporary configuration and deterministic
mock provider. It does not call the Splash inference endpoint. These checks do
not establish a new live-model benchmark or validate every optional model menu entry.
The Makefile uses `python3.14`; override it with `make PYTHON=python3.12 check`
or another installed supported Python when needed.

To build Splash independently, use `make -C splash all`; see its development guide
for engine and Metal tests. To verify the original imported snapshot hashes, run
`python3 scripts/verify-snapshot.py`. Changes to imported files intentionally make
that historical snapshot check fail; normal `make check` supports later development.

## Exclusions

Model weights, caches, logs, builds, virtual environments, `node_modules`, OpenCode
sessions, backups, disabled plugins, and credentials are excluded. In particular,
OpenCode's `service.json` contains a password and is not included; OpenCode can
create its own local service state. Existing live installations are left in place.
No remote is configured or pushed by creating this repository and tag.
