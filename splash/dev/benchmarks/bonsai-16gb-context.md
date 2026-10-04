# Bonsai option 14 on the 16GB M5 Mac

Measured on 2026-10-04, macOS 26.5.2, Apple M5 with 8 GPU cores and 16 GiB
unified memory. The target is
`prism-ml/Ternary-Bonsai-2-27B-gguf:PTQ1_0`, paired with
`incoai/Qwen3.8-27B-DFlash2` revision
`015e795645c74b1a0eeef3b570031fb62e769bc5`. Target revision:
`b072e1d3b35a0a630cece372c2127528e0994386`.

The revised `/Users/mymac/startllamacpp.sh` option 14 defaults to 24,576 server
tokens, 22,528 OpenCode tokens, a 1,024-token output reserve, INT8 KV, one active
request, 512-token prefill chunks, and an 8 GiB SSD prefix/state cache. Server
context increased from 14K to 24K; client context increased from 12K to 22K.
The launcher synchronizes the client limit when launched normally.
Its changes are preserved in [startllamacpp-option14.patch](startllamacpp-option14.patch)
because the installed launcher lives outside this repository.

## Runtime change

Verification attention used to reserve every lane's scratch for the protocol's
128-split maximum. It now reserves the largest history partition reachable at
the configured context, and each dispatch checks the storage its actual split
stride addresses. Partition counts, kernels, KV quantization and attention
arithmetic are preserved. The memory plan is capped at the context its scratch
supports; automatic context continues to use the full bound.

At 14K, shared prefill/workspace allocation fell from **247.16 to 174.59 MiB**,
saving **72.56 MiB**. At the new 24K default it is **187.45 MiB**, still
**59.70 MiB below the old 14K allocation**. KV grows separately with the prompt;
these savings refer to fixed runtime buffers, not total process memory.

## Live observations

All rows below are measured with greedy sampling, reasoning disabled, one
request at a time, and a 96-token output. The short record prompt is 4,892
tokens; the long one is 22,832 tokens. Every reply identified the correct final
code, ORCHID. Repeated prompts reused 4,864 or 22,816 cached tokens respectively.
PP and TG are native lifetime rates after the first request. Times include the
HTTP request and its output. Peak memory is Metal device allocation, rather
than whole-system use.

| Profile | Server context | Chunk | Prompt | PP tok/s | TG tok/s | Cold time | Cached time | Shared workspace MiB | Peak Metal GiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Original | 14K | 512 | 4,892 | 202.8 | 34.4 | 26.99s | 3.10s | 247.16 | 8.39 |
| Context-sized scratch | 14K | 512 | 4,892 | 202.0 | 32.5 | 27.22s | 3.30s | 174.59 | 8.32 |
| Larger chunks | 14K | 1,024 | 4,892 | 184.8 | 31.4 | 29.60s | 3.31s | 237.75 | 8.38 |
| Smaller chunks | 14K | 256 | 4,892 | 160.8 | 27.1 | 34.01s | 3.95s | 143.02 | 8.29 |
| Selected profile | 24K | 512 | 22,832 | 166.6 | 29.6 | 140.43s | 3.51s | 187.45 | 8.64 |
| Larger chunks | 24K | 1,024 | 22,832 | 146.6 | 25.6 | 159.60s | 4.12s | 250.61 | 8.70 |
| Smaller chunks | 24K | 256 | 22,832 | 138.6 | 24.2 | 168.91s | 4.26s | 155.88 | 8.63 |

These were sequential single-run observations on a fanless Mac, with no
randomized order or thermal control. They establish memory reduction and live
context capacity; they do not establish a compute-speed improvement. The 512
setting retains the best observed balance. The repetitive counting workload
had high draft acceptance, so its TG rates do not predict coding throughput.

Swap was already **953.06 MiB** before testing and stayed at that level across
these requests. The 24K/512 trial had no suspended requests or native failures.
macOS remained under warning pressure, so this result is conditional on the
other applications running during the measurements; it is not a no-swap
guarantee or proof of a larger context.

The final original-launcher test exercised **23,433 prompt + 1,024 output =
24,457 total tokens**, 119 tokens below the 24K ceiling. Both cold and cached
requests completed correctly; a request exceeding the budget returned HTTP
400 with `context_length_exceeded`. The memory plan advertised the configured
24K capacity, and Metal remained healthy with zero failed native requests.
Cold total time was 197.61s, including 155.48s of prefill; the cached repeat
took 41.44s, including its full 1,024-token generation. Peak Metal allocation
was **8.64 GiB**. System swap grew from **953.06 to 1,195.56 MiB** during this
longer final run. That is **242.5 MiB of additional system swap**, whose process
owner was not measured. Therefore the full-window result proves successful
inference, not that the entire desktop fits without further swapping. Leave
more room for Splash by closing memory-heavy applications for long requests.

Final verified build:
`src-5f2e2f1b895de678a9766d5501f181351abe8f30e5c9c07d6fe086fb927edc4f`.
The temporary benchmark server was stopped after testing.

## Reproduction

The recorded measurements are in [bonsai-16gb-context.json](bonsai-16gb-context.json).
Each run includes its build identity, memory plan, cold/cached timing and usage,
native counters, Metal allocation and system swap reading. Source-file SHA256
values identify the original measurement captures; this dataset omits response
text and unrelated status fields. Native lifetime counters after the cached
request include both requests.

Launch option 14, then use a fresh server for each cold comparison:

```sh
bash /Users/mymac/startllamacpp.sh --direct 14
.venv/bin/python dev/benchmarks/bonsai_context.py \
  --records 1000 --results /private/tmp/bonsai-context-results.json
```

The JSON contains the complete before/after runtime status, request usage,
response, timing, and swap readings. Cached-token usage identifies whether the
first request was actually cold. `SPLASH_BONSAI_PREFILL_CHUNK_TOKENS` allows
aligned chunk overrides in [128, 2048]; the profile's tested default is 512.
For the final near-full-window workload, use `--records 1024 --output-tokens
1024 --count-to 1000`.

Validation: full native CPU suite, 262 server/launcher/options tests, INT8 and
BF16 Metal attention reference checks with shader validation (both supported
head geometries and B1-B4), runtime resource checks, and build identity check.

## Launcher follow-up: reuse prefixes after restart

Option 14 now keeps its SSD prefix cache across clean restarts by default,
under `~/Library/Caches/Splash/bonsai-option14`. The 8 GiB quota, 24K server
context, 512-token chunk, INT8 KV and single active request remain the defaults.
Set `SPLASH_BONSAI_PERSISTENT_CACHE=0` for a temporary cache, or
`SPLASH_BONSAI_MAX_CACHE_DISK=0` to disable the disk tier.

Client context defaults to `auto`, resolving to server context minus 2,048
tokens (22K at the default). For example, setting only
`SPLASH_BONSAI_MAX_CONTEXT=16K` selects a 14K client window. Smaller windows
also reduce the compaction history reserve. Explicit client overrides remain
supported within the tested 22K cap. Startup retries are bounded: two retries
after the first attempt, with 30 seconds between attempts, only for startup
memory admission failures. Numeric overrides reject overflow before launching
or changing client configuration. INT/TERM/HUP stop the owned server and
monitors and drain shutdown logs so cache persistence can finish.

On the same Mac, a fresh persistent-cache directory and a 4,892-token prompt
with 96 output tokens took **27.22s** cold. After a clean server restart, the
identical request reused **4,864 tokens** and took **3.16s**. Request prefill
fell from **24.62s to 0.48s**; decode remained **35.9 tok/s**. These times
exclude server startup. Both answers were correct, both native runtimes had
zero failed requests and healthy Metal, and both temporary servers stopped.
This single pair verifies restart reuse, not a general compute-speed gain.
Measurements are in [bonsai-option14-persistence.json](bonsai-option14-persistence.json).

Seven focused launcher tests passed, covering default flags/client limits,
smaller contexts, cache opt-out, invalid and overflowing settings, bounded
memory retries, runtime errors without retries, and signal/shutdown logging.
Run these with `python3 dev/benchmarks/test_bonsai_launcher.py` on macOS;
`OPTION14_LAUNCHER` can select another launcher path. The tests use a mock
server and temporary client settings.
