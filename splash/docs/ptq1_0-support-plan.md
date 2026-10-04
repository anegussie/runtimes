# PTQ1_0 support for Ternary Bonsai 2 27B

Planning baseline: Splash `6c6002d`, inspected 2026-09-28. This document is an implementation plan; no runtime support or performance result is claimed.

## Recommendation

Extend Splash's existing Bonsai 2 PQ2_0 implementation with native PTQ1_0 loading, prepared weights, and Metal decoding. Reuse its Qwen3.8-27B geometry, Hadamard transforms, GDN execution, tokenizer adapter, and DFlash2 integration.

Keep prepared storage close to the source size. A lossless conversion to PQ2_0 is a useful development oracle or explicitly documented compatibility fallback, but does not deliver PTQ1_0's memory benefit.

## Verified starting point

The local file is `Ternary-Bonsai-2-27B-gguf/Ternary-Bonsai-2-27B-PTQ1_0.gguf`.

| Property | Observed value |
| --- | --- |
| File size | 5,946,648,928 bytes = 5.538 GiB |
| Architecture | `qwen35`, matching Splash's Qwen3.8-27B family signature |
| Layers | 64; full attention every fourth layer, otherwise GDN |
| Hidden / FFN / vocabulary | 5,120 / 17,408 / 248,320 |
| Declared maximum context | 262,144 tokens; this is not a tested memory capacity |
| Tensor inventory | 851: 402 type 143, 353 F32, 96 BF16 |
| PTQ1_0 elements | 26,869,760,000, in 209,920,000 blocks |
| Rotation | Version 1, normalized 1,024-wide Hadamard, explicit signs |
| Rotated tensors | 401 projections, plus inverse rotation for the token table |
| Rotation widths | 5,120, 6,144, 17,408 |
| GDN alpha/beta | BF16; they stay outside the rotated projection set |

Running `install.gguf.require_loadable()` on the actual header rejects all 402 type-143 tensors. `model_config()` already extracts the expected family configuration. The existing native parser also lacks type 143.

Existing support is documented in `DEVELOPMENT.md` under “GGUF targets.” The implementation already includes PQ2_0 Metal projections and both forward activation rotation and inverse embedding rotation. No new transformer architecture is needed.

## Format contract and storage decision

Use Prism's implementation as the independent format authority:

- [Native block definition](https://github.com/PrismML-Eng/llama.cpp/blob/prism/ggml/src/ggml-common.h): type 143, 128 weights, 28 bytes: `qs[24]`, `qh[2]`, then FP16 scale `d` at byte 26.
- [Reference dequantizer](https://github.com/PrismML-Eng/llama.cpp/blob/prism/ggml/src/ggml-quants.c): `dequantize_row_ptq1_0`. Pin an immutable Prism commit when creating fixtures; these branch links can move.
- [Publisher model card](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf): model lineage, rotation requirement, and packing variants.

PTQ1_0 is not interchangeable with stock TQ1_0 or PQ2_0. Its source codec has a 16-byte stage producing 80 values, an 8-byte stage producing 40 values, and two tail bytes producing the final eight values. Preserve the reference's byte overflow and trit order exactly; simple base-3 division on the stored byte is not the reference codec.

| Prepared representation | Bytes / 128 weights | Consequence |
| --- | ---: | --- |
| Native GGUF PTQ1_0 | 28 | 1.75 bits/weight |
| Prepared PTQ1_0 (implemented layout) | 30 with a shared scale | Adds about 0.391 GiB across these tensors |
| PQ2_0 expansion | 34 | Adds exactly 1,259,520,000 bytes, about 1.173 GiB, across these tensors |

The chosen prepared layout makes each 32-weight group independent: six bytes hold its first 30 trits, and one byte holds the last two; a shared two-byte metadata unit stores the FP16 scale for four groups. That is 30 bytes per 128 weights. A 28-byte prepared layout would require trits in the final groups to share metadata and would change the common kernel accessor contract.

## Implementation sequence

### 1. Establish the CPU oracle and fixtures

- Pin the Prism source revision and the model revision/hash. Generate independent dequantization goldens from that Prism build.
- Add PTQ1_0 fixture generation and CPU decoding to `dev/tests/engine/GgufFormatReference.hpp` and the weight-golden fixtures.
- Cover all trit positions, 80/120/128-value boundaries, zero and signed weights, zero/small/large finite scales, multiple blocks, and short/last rows. Exercise every possible source code byte where appropriate to the reference decoder.
- Verify source block sizes against actual tensor extents and offsets; use sampled real blocks alongside synthetic cases. Keep the multi-gigabyte GGUF out of fixtures and Git.

Exit: CPU reference output matches the independent Prism oracle; block sizing and source indexing are proven before Metal work.

### 2. Register the source format and plan compact preparation

Touch:

- `install/gguf.py`: type 143 name, projection and embedding allowlists.
- `runtime/model/GgufFile.hpp`: `kPTQ1_0`, native traits `{128, 28}` and table count.
- `runtime/metal/abi/QuantFormat.h`: append a format ID and layout definition without renumbering existing IDs.
- `runtime/metal/abi/Gguf.h`: embedding capability.
- `runtime/model/GgufImage.cpp`: accept PTQ1_0 rotated token tables while retaining exact rotation-name and shape validation.
- `runtime/model/GgufPreparation.cpp`, `GgufImageLayout.hpp`, and `runtime/metal/kernels/shared/gguf_repack.metal`: bounded preparation and the chosen layout.

Repack source trits losslessly; copy FP16 scale bits rather than requantizing weights. Preserve row permutation and grouped GDN ordering. One thread must own each scale metadata write to avoid races. Test column chunking, row padding, alignment and seven-byte payload accesses without over-reading.

The loader and kernels must land together: do not publish an installer that accepts a format the runtime cannot execute.

Exit: the full model's images can be planned, synthetic images match independent byte expectations, and preparation stays within its staging budget.

### 3. Implement compact Metal projection decoding

- Add the new format decoder in `runtime/metal/kernels/common/quant_formats.h` and its format dispatch registration.
- If the selected layout needs it, extend the common payload/code accessor narrowly to accept shared metadata and the subgroup index. Update both `gguf_staged.h` and `gguf_sgmatrix.h` callers; preserve other formats' generated code where possible.
- Cover staged prefill and decode (`shared/gguf_linear.metal`), register decode (`decode/linear_gguf_sgmatrix.metal`), and fused projections and epilogues.
- Validate single-row, DFlash verification, and concurrent batch shapes. Reuse generic kernel templates where possible rather than duplicating full GEMM kernels.
- Begin with correct dispatch in `runtime/ops/LinearGguf.cpp`; make Apple9/Apple10 policy changes only after measurements. Any generated MoE instantiations must still compile, even though this target is dense.

Exit: dequantization and projection results meet the existing format-specific numerical bounds, with shader validation and no out-of-bounds reads or writes.

### 4. Add native and rotated embeddings

- Add `GgufEmbedPTQ10` and ordinary gather registration in `runtime/metal/kernels/shared/embedding.metal`.
- Generalize the rotated gather in `shared/gguf_rotation.metal`, or add a PTQ1_0 specialization sharing the existing butterfly implementation.
- Update `runtime/ops/Embedding.cpp`, which currently hard-codes PQ2_0 for rotated tables.
- Preserve forward projection input transformation `H(Dx)` and inverse token transformation `D(Hr)`. Gather the rotated weights into FP32 and round only after the inverse transform, as the existing implementation does.
- Keep embeddings in native 28-byte blocks. Do not pre-expand the full vocabulary table.

Exit: token gathers match independent inverse-rotation references at the existing FP32/BF16 tolerances; this includes real-width rows, repeated token IDs and the final vocabulary row.

### 5. Validate full-model execution, DFlash and memory

- First compare target-only teacher-forced logits against the pinned Prism implementation on identical tokens, positions and cache precision. Use an operator/runtime harness if needed; do not assume Splash exposes a public “disable draft” flag.
- Compare PTQ1_0 with PQ2_0 from the same checkpoint after checking that their scales, decoded tensors and rotation metadata agree. This isolates packing defects from model differences.
- Reuse `incoai/Qwen3.8-27B-DFlash2`, selected by `install/families.py`, and measure acceptance and end-to-end latency. Family compatibility is not proof of identical acceptance or speed.
- Exercise existing speculative verify/commit, rollback, prefix reuse, GDN state and batching oracles. Check generation, reasoning modes, streaming and tools through the existing HTTP tests.
- Start real runs with text only, one request, short filled context and an explicit memory budget. Measure target images, prepared draft, KV, GDN states, activations, scratch, preparation peak and process memory separately. The 5.538-GiB source file alone does not establish a 16-GB deployment fit.
- Progress to 4K, 16K and 32K actually filled contexts when measured headroom permits; test larger contexts separately. Report cache format, prompt processing, decode, TTFT, draft acceptance and memory pressure. Do not advertise the metadata's 262K maximum as validated capacity.
- Run CPU tests with `make test`, `make check-native-cpu`; run Metal checks with `make check-native-metal` on supported hardware. Add the format to reference, file, planner, preparation, dequantization, projection and rotation tests. Exercise Apple9 and Apple10 before claiming both validated.
- Run `verify-models`, `test-real`, `test-http-real` and performance checks with this model selection where hardware permits. Unavailable hardware or insufficient memory remains an explicit validation gap.

Exit: source-oracle comparisons and runtime oracles pass, model responses are correct, and compact storage survives preparation. Performance figures are measured and reported separately from correctness.

### 6. Finish cache, installation and documentation integration

- Existing preparation identity hashing covers `QuantFormat.h` and `gguf_repack.metal`; verify invalidation, restart reuse and recovery from interrupted preparation. Add any new byte-defining helper to `dev/tools/weight_preparation_identity.py`.
- Expect these edits to invalidate existing GGUF preparation caches under the current scheme. Document the one-time preparation and disk cost; preserve old-format numerical goldens unless their bytes intentionally change.
- Add installer selection tests, catalogue/completion coverage where generated, and README/DEVELOPMENT support documentation.
- The intended existing public interface after implementation is:

  ```sh
  splash serve --model prism-ml/Ternary-Bonsai-2-27B-gguf:PTQ1_0 --language-only
  ```

  This command is not supported by the inspected checkout yet. The target CLI currently accepts Hub IDs, not arbitrary GGUF paths. Use the local file directly in the development harness; for normal installation, reuse it through a verified Hub cache entry or separately design local-target import if desired. Do not imply `--model /path/to/file.gguf` already works.
- Validate vision separately through Splash's existing supported projector selection. This checkout selects BF16/F32 projectors; the publisher's smaller Q8_0 projector is not automatically supported by adding PTQ1_0 language weights. No projector was present in the inspected local model directory.
- Retain upstream attribution in `THIRD_PARTY_NOTICES` for adapted code. If contributing upstream, follow `CONTRIBUTING.md`: this repository asks for an issue first because releases mirror a separate development branch.

## Delivery boundaries and risks

Suggested review units: (1) reference fixtures and format/layout specification, (2) preparation plus projection/embedding kernels and capability admission, (3) real-model validation and docs. All can be developed on one branch, with acceptance enabled only once execution works.

The largest correctness risks are source byte order, trit repacking, inverse embedding rotation and GDN head ordering. The main product risks are preparation-memory spikes, lower DFlash acceptance, and a prefill slowdown from trit unpacking.

There is no evidence yet for a PTQ1_0 speedup on Splash. The saved weight traffic makes it worth implementing, but a performance claim requires measurements on the target Mac. If kernels are too slow, compare the prepared PTQ1_0 layout with an explicitly disclosed PQ2_0 fallback.
