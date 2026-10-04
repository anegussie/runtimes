# Upstream integration, 2026-10-03

The local `splashmain` branch includes `incoai/splash` through
`f43509a2f03d83b4442a0fab748e8b0fb49aa817`. The original local tip was
`ecb5d760cea3a50b848adc4e6ab0e5714efe2382`.

The initial merge retained whole local files at conflicts, leaving older
interfaces alongside newer callers. The follow-up repair restores upstream
interfaces and ports the local extensions onto them.

## What is integrated

| Area | Integration |
| --- | --- |
| Resource management | Upstream transactional allocation, reclaim and serving-memory accounting. |
| Prefix cache | Upstream persistent SSD cache, directory locking and recovery. `--persistent-cache` requires a nonzero `--max-cache-disk`. |
| Model loading | Upstream model-directory layout, prepared weights and loader interfaces. |
| Metal kernels | Upstream register and staged decode, prefill and embedding kernels, extended with PTQ1_0. |
| Frontend and launcher | Upstream shared CLI options, package invocation, offline mode and HTTP contracts. |

## Local behavior retained

- PTQ1_0 (GGUF type 143), including preparation, projection, ordinary and
  rotated embeddings, planner admission and reference coverage.
- An idle-system-sleep assertion for a loaded Metal backend, released on
  teardown and failed startup. Display sleep remains available.
- `--resource-wait-timeout SECONDS`, default 30, forwarded to the engine.
- `--max-active-requests`, default 0 for engine concurrency. Use 1 for FIFO
  submission with one active native request. Waiters keep their original
  deadlines and poll HTTP disconnects and streaming heartbeats.
- Request IDs, frontend/native queue timings and PP/decode console metrics.

The earlier sparse-unmap locking patch is obsolete because upstream removed
that sparse-buffer path. The earlier admission/reclaim implementation is
superseded by upstream resource accounting rather than layered onto it.

## Regressions repaired during validation

- Queued HTTP callbacks now run only for waiters and are cleared after
  submission, preventing early HTTP 200 responses on admission failure and
  preventing completed jobs from retaining request-body reservations.
- Launcher assembly records close when `execve` fails or returns in tests.
  Successful execution still inherits the lock descriptor.
- PTQ1_0 trit extraction uses constant divisors. General integer division in
  the Metal decoder produced intermittent incorrect prefill fragments on
  the local Apple10 GPU. Projection tests repeat PTQ1_0 dispatches and include
  a `--prefill` mode for focused reproduction.

## Validation

Validated locally on Apple M5, macOS 26.5.2:

- Production build and native CPU suite: passed.
- Complete native Metal suite with shader validation: passed.
- Python engine discovery: 812 tests, passed with 7 optional tests skipped.
- Server suite: 224 tests, passed.
- Installer/model/metadata/restart and launcher run: 155 tests, passed.
- Five repeated prefill runs, including repeated PTQ1_0 dispatches: passed.
- Architecture checks, Python compilation, lint/format and diff checks: passed.

Run the current gates from the checkout:

```sh
make -j4 all test-engine-cpu test-engine-metal
.venv/bin/python -m unittest discover -s dev/tests/engine -p 'test_*.py'
.venv/bin/python -m unittest dev.tests.test_server
.venv/bin/python -m unittest dev.tests.test_models dev.tests.test_upstream dev.tests.test_gguf_metadata dev.tests.test_installer_restarts
.venv/bin/python dev/tools/check_architecture.py
.venv/bin/ruff check --config dev/ruff.toml server install dev/tools dev/tests dev/benchmarks
.venv/bin/ruff format --check --config dev/ruff.toml server install dev/tools dev/tests dev/benchmarks
git diff --check
```

The integration gates exercise real Metal kernels with shader validation and
HTTP contracts with controlled native backends. The model-specific smoke run
below additionally exercises the installed PTQ1_0 model. These checks do not
establish general throughput or every model's long-context capacity; see the
separate release gates in DEVELOPMENT.md.

## Option 14 startup repair

The zero-deficit memory plan in the reported log described the engine budget.
Startup separately refused the live host-memory admission for model arenas.
Native EOF followed that refusal. Reproducing through the user's launcher
confirmed the same failure with 14K context, INT8 KV and an 8G SSD cache.

Two changes allow this profile to start with the measured host headroom:

- Prefill mixer, FFN and draft-context scratch share storage across their
  disjoint lifetimes. Hidden, capture, rotary, linear scratch and the mixer
  residual remain separate. Decode attention partials and replay buffers
  borrow the phase workspace after prefill retires. The engine allows one
  pending batch, including its mask/commit tail, at a time. Sampling buffers,
  penalties and page tables retain separate storage.
- Resource assembly and warmup check essential allocations against the live
  macOS reserve and engine budget. They do not require the additional 1 GiB
  warning margin for optional idle cache growth. Arena admission also reserves
  the first lane's state requirement before allocation. Missing host telemetry
  and critical pressure refuse startup. Startup mode clears before serving;
  the existing cache-growth and request-serving policies resume.

For this installed Bonsai PTQ1_0 model, allocated scratch changed as follows.
Decode's borrowed workspace is charged once in the prefill category.

| Category | Before | After |
| --- | ---: | ---: |
| Prefill allocation | 801.19 MiB | 440.50 MiB |
| Separate decode allocation | 238.45 MiB | 54.53 MiB |
| Total scratch | 1,039.64 MiB | 495.03 MiB |

After the repair, the complete native CPU suite and architecture checks pass.
Planner tests cover dense/sparse targets, Apple GPU families 9/10/11 and both
KV formats. The focused Metal test passes 279 GPU ordering and preservation
checks with shader validation. The complete Metal suite above passed during
integration, before this additional memory-layout change.

Live launcher smoke used the user's normal settings:

```sh
bash /Users/mymac/startllamacpp.sh --direct 14
```

The server reached Ready at `http://127.0.0.1:1235`. `/health`, `/v1/models`
and `/status` passed. The warmup memory audit was valid, Metal remained healthy,
and the test requests succeeded:

| Request | Result |
| --- | --- |
| Short arithmetic, 26 prompt tokens | Correct answer; 1.13 s. |
| Two-chunk prefill, 3,971 prompt tokens | Correct final-record answer; 19.79 s. |
| Repeat of that prompt | Correct answer; 3,936 cached tokens; 0.66 s. |
| Streaming decode | Correct count from 1 through 20 and complete SSE terminator. |
| Client-context prompt, 12,251 tokens | Correct final-record answer; 3,936 cached tokens; 46.80 s. |

The live profile limits native concurrency to one. Required 2,048-row prefill
and B1 decode warmups passed; optional B2/B3/B4 and composite-state-restore
warmups were memory-limited. Host pressure reached warning and optional cache
growth paused. The test establishes startup, single-request inference and
cache reuse on this host, without establishing swap-free operation or a
61K context capacity from the theoretical planner ceiling. The test server
was left running because other clients were using it.


## Configurable prefill chunks

Serving now defaults to 512 prompt tokens per native batch. The new
`--prefill-chunk-tokens` option accepts multiples of 128 from 128 through
2048; `--prefill-chunk-tokens 2048` restores the earlier batch size.
The launcher, Python frontend and native entry point share this setting.
Option 14 in `startllamacpp.sh` picks up the smaller default on its next launch.

The setting controls scheduler admission and dispatch, runtime geometry,
prefill tensor and linear scratch sizing, memory planning, and startup warmup.
`/status` reports `prefill_chunk_tokens` and names the actual warmup path,
such as `prefill_512`. Projection tiles still require padded storage for
short tails. Shared prefill workspace also retains enough room for decode
replay, so reducing chunks does not shrink every scratch allocation by 75%.

The compiled 2048-token ceiling, model manifests, draft context window and
checkpoint spacing retain their existing contracts. Long prompts run as
additional chunks. Smaller chunks can reduce prompt throughput and can
change floating-point results, as existing adaptive chunking already can.

Regression coverage includes all allowed scheduler chunk sizes, cached
suffix packing, final tails and the minimum contended slice; dense and MoE
arena sizing with INT8/BF16 KV on Apple GPU families 9/10/11; rotated
projection padding; configured warmup/status; and option parsing/forwarding.
Metal scratch ordering tests exercise both 512 and 2048 rows.


### Measured option 14 result

On the same M5 16GB Bonsai PTQ1_0 profile, with INT8 KV, 14K server context,
one active request and the existing 8G SSD quota:

| Allocation | 2048-token chunk | 512-token chunk |
| --- | ---: | ---: |
| Shared prefill arena | 461,897,728 bytes (440.50 MiB) | 259,162,112 bytes (247.16 MiB) |
| Separate decode arena | 57,180,224 bytes | 57,180,224 bytes |
| Idle core allocation after reclaim | 8,859,397,184 bytes (8.25 GiB) | 8,656,661,568 bytes (8.06 GiB) |

The prefill change saves 202,735,616 bytes (193.34 MiB). Target/draft weights
and KV representation are unchanged. The 512-row prefill and B1/B2 decode
warmups passed, as did composite-state restore. B3/B4 were memory-limited.
Startup peak was higher than the earlier run because additional optional
warmups now fit; the table compares the idle core allocation, not peaks or
combined process RSS. Host pressure still reached warning.

Five real requests passed with healthy Metal and zero failed requests:

| Request | Result |
| --- | --- |
| Short arithmetic, 26 prompt tokens | Correct answer; 0.47 s. |
| Cold 3971-token prompt | Correct final-record answer; 21.07 s. |
| Repeat of that prompt | Correct answer; 3936 cached tokens; 0.68 s. |
| Streaming generation | Correct count from 1 through 20; complete SSE terminator. |
| Cold 12,254-token prompt | Correct final-record answer; no cached tokens; 69.28 s. |

These are functional smoke timings, not a controlled throughput comparison.
The test server was stopped after checking that it was idle; port 1235,
its native engine and its monitor were confirmed closed.


Validation for this prefill change:

- Full native CPU suite: passed.
- Full native Metal suite with shader validation: passed.
- Final rebuilt Metal scratch-ordering check: 279 checks at each of 512
  and 2048 rows, passed.
- Python engine discovery: 813 tests, passed with 7 optional tests skipped.
- Server and launcher suites: 257 tests, passed.
- Shared-option parity and forwarding suite: passed, including every allowed
  chunk size and invalid values; native invalid-value CLI checks also passed.
- Architecture, full Python lint/format, compilation, build identity and
  diff checks: passed.
