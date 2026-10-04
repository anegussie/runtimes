# Option 14 memory savings and performance tradeoffs

Analysis date: 2026-10-04. Configuration inspected in
`/Users/mymac/startllamacpp.sh`. This note records calculations and existing
measurements; no launcher or runtime settings were changed for this analysis.

## Current configuration

Option 14 runs `prism-ml/Ternary-Bonsai-2-27B-gguf:PTQ1_0` through Splash,
with its matching DFlash2 draft. Defaults inspected:

| Setting | Value |
| --- | --- |
| Server context | 24K = 24,576 tokens |
| OpenCode context | Auto: server minus 2,048 = 22,528 tokens |
| Output limit | 1,024 tokens |
| Target KV format | INT8 |
| Prefill chunk | 512 tokens |
| Active requests | 1 |
| Vision | Disabled with `--language-only` |
| SSD prefix/state cache quota | 8 GiB, persistent |
| Explicit Metal memory ceiling | Not passed by option 14; automatic budget |

K means 1,024 tokens in this launcher. Environment overrides can change these
defaults.

## Reducing server context from 24K to 20K

Calculated savings are approximately **136.05 MiB (0.133 GiB)** when comparing
full context windows, with other settings held constant.

| Component | 24K | 20K | Reduction |
| --- | ---: | ---: | ---: |
| Logical INT8 KV storage | 780 MiB | 650 MiB | 130 MiB |
| Shared runtime workspace | 187.45 MiB | 181.41 MiB | 6.05 MiB |
| Combined reduction | | | **136.05 MiB** |

The model memory plan reports 16 full attention layers, four KV heads,
256 elements per head, 32 tokens per page, and 1,064,960 bytes per model KV
page. INT8 data includes FP32 quantization scales:

```text
KV bytes/token = 16 layers x 2 (K and V) x 4 heads x (256 + 4) bytes
               = 33,280 bytes
Tokens removed = (24 - 20) x 1,024 = 4,096
KV reduction   = 4,096 x 33,280 = 136,314,880 bytes = 130 MiB
```

Verification scratch uses 49 history partitions at 24K and 41 at 20K. With
24 query heads, eight verification rows, and four compiled lanes, its change
is:

```text
Scratch reduction = (49 - 41) x 4 lanes x 8 rows x 24 heads
                    x (256 partial values + 2 statistics) x 4 bytes
                  = 6,340,608 bytes = 6.046875 MiB
Total reduction   = 142,655,488 bytes = 136.046875 MiB
```

KV backing grows on demand and is allocated in extents. Logical KV totals
exclude extra runway and allocation rounding. These calculations are not a
measurement of process RSS or system swap. For the same shorter prompt, KV
occupancy may remain unchanged, leaving approximately 6 MiB of fixed workspace
savings. Cached histories and pressure-driven reclaim also affect residency.

Target and draft weights do not shrink. Automatic OpenCode context would
change from 22K to 18K if the server limit changed to 20K.

## Saving memory while retaining the 24K server context

| Setting | Memory effect | Performance effect |
| --- | --- | --- |
| Prefill chunk 512 to 256 | Fixed shared workspace falls by **31.58 MiB** | Existing long-prompt trial showed about 17% lower prompt throughput and 20% longer cold request time |
| Lower `--max-memory` ceiling | Limits optional cache growth and retained state; savings depend on occupancy | More eviction, SSD transfers, or prompt replay can increase latency; too low a ceiling rejects 24K at startup |
| Smaller OpenCode context with server still at 24K | Earlier compaction can reduce filled history; 4K fewer filled tokens corresponds to about **130 MiB** of logical target KV | More compaction and less retained conversational detail; capacity remains 24K, but client use is lower |
| Keep one active request | Avoids additional simultaneous live request states | Other requests queue; already enabled |

`--max-memory` is a supported Splash flag, but option 14 currently does not
forward a configurable ceiling. Selecting a suitable cap would require
checking the memory plan and validating a full-window request. No exact cap or
memory saving was verified here.

### Measured prefill comparison

The existing local benchmark used the same 24K context, INT8 KV, 22,832-token
prompt, and 96-token output:

| Metric | 512-token chunks | 256-token chunks |
| --- | ---: | ---: |
| Shared runtime workspace | 187.45 MiB | 155.88 MiB |
| Prompt throughput | 166.6 tok/s | 138.6 tok/s |
| Decode throughput | 29.6 tok/s | 29.1 tok/s |
| Cold request time | 140.43 s | 168.91 s |
| Cached request time | 3.51 s | 4.26 s |

These were sequential individual trials on a fanless 16 GiB M5, without
randomized order or thermal control. The workspace saving is established by
allocation sizes. Timing differences are indicative, and the repetitive
workload's draft acceptance does not establish coding throughput. A 128-token
chunk is supported, but no 24K memory/performance result for it was established
in this analysis.

### Settings already minimized or without a direct RAM saving

- INT8 is already the smaller supported KV format. Splash supports INT8 and
  BF16, with no Q4 KV setting.
- Text-only mode already skips vision allocations.
- Native concurrency is already one.
- The 8 GiB SSD cache is a disk quota, not an 8 GiB RAM reservation. Reducing
  it does not directly release that amount of unified memory. Disabling it
  loses reusable prefixes and progress checkpoints and can increase replay.
- The current public configuration has no switch to disable the DFlash2
  draft. Its weights cannot be removed through an established option-14
  setting.
- A longer resource wait timeout changes waiting behavior, not the required
  memory footprint.

Recommendation: retain 512-token chunks for performance. Use 256 only when
approximately 32 MiB of fixed savings matters. Larger reductions while keeping
24K capacity would need constrained cache retention or less filled client
history, with workload-dependent latency and continuity tradeoffs.

## Evidence

- Installed launcher: `/Users/mymac/startllamacpp.sh`.
- [Local benchmark and limitations](bonsai-16gb-context.md).
- [Recorded context benchmark data](bonsai-16gb-context.json).
- [Recorded model memory profile](bonsai-option14-persistence.json).
- [Supported serving flags](../../server/serve_options.py).
- [Verification scratch calculation](../../runtime/ops/PagedAttention.cpp)
  and [partition calculation](../../runtime/ops/PagedAttention.hpp).
- [Shared runtime arena layout](../../runtime/model/RuntimeArenas.mm).
- [Memory budget and KV capacity planning](../../runtime/engine/MemoryPlan.cpp).
- [Startup capacity validation](../../runtime/engine/Bootstrap.mm).
