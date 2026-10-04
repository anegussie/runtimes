#include "model/RuntimeArenas.hpp"

#include "ops/DraftSelector.hpp"
#include "ops/Sampling.hpp"

namespace splash::model {
std::array<uint64_t, prefillTensorCount>
prefillTensorBytes(const RuntimeGeometry &geometry,
                   const ops::ExecutionPlans &operators) {
  const uint32_t prefillRows = geometry.prefillChunkTokens;
  const uint32_t packedAttentionRows = prefillRows + kLaneCount * (kTileRows - 1);
  std::array<uint64_t, prefillTensorCount> result{};
  auto put = [&](PrefillTensor tensor, uint64_t bytes) {
    auto &size = result[static_cast<uint32_t>(tensor)];
    size = std::max(size, bytes);
  };
  put(PrefillTensor::Hidden0,
      bytesFor<uint16_t>(uint64_t{prefillRows} * geometry.target.hiddenSize));
  put(PrefillTensor::Hidden1,
      bytesFor<uint16_t>(uint64_t{prefillRows} * geometry.target.hiddenSize));
  put(PrefillTensor::InputTokens, bytesFor<uint32_t>(prefillRows));
  put(PrefillTensor::Normalized,
      bytesFor<uint16_t>(uint64_t{prefillRows} * geometry.target.hiddenSize));
  put(PrefillTensor::Captured,
      bytesFor<uint16_t>(uint64_t{prefillRows} *
                         geometry.target.capturedHiddenSize()));
  put(PrefillTensor::GdnPacked,
      bytesFor<uint16_t>(uint64_t{prefillRows} *
                         geometry.target.packedGdnWidth));
  put(PrefillTensor::GdnQueries,
      bytesFor<uint16_t>(uint64_t{prefillRows} *
                         geometry.target.gdnKeyWidth()));
  put(PrefillTensor::GdnKeys,
      bytesFor<uint16_t>(uint64_t{prefillRows} *
                         geometry.target.gdnKeyWidth()));
  put(PrefillTensor::GdnValues,
      bytesFor<uint16_t>(uint64_t{prefillRows} *
                         geometry.target.attentionWidth));
  put(PrefillTensor::GdnDecay,
      bytesFor<float>(uint64_t{prefillRows} *
                      geometry.target.gdnValueHeads));
  put(PrefillTensor::GdnBeta,
      bytesFor<uint16_t>(uint64_t{prefillRows} *
                         geometry.target.gdnValueHeads));
  put(PrefillTensor::Recurrent,
      bytesFor<uint16_t>(uint64_t{prefillRows} *
                         geometry.target.attentionWidth));
  put(PrefillTensor::GdnHidden,
      bytesFor<uint16_t>(uint64_t{prefillRows} *
                         geometry.target.attentionWidth));
  put(PrefillTensor::GdnOutput,
      bytesFor<uint16_t>(uint64_t{prefillRows} * geometry.target.hiddenSize));
  put(PrefillTensor::GateIntermediate,
      bytesFor<uint16_t>(uint64_t{prefillRows} *
                         geometry.target.denseIntermediateSize));
  put(PrefillTensor::Intermediate,
      bytesFor<uint16_t>(uint64_t{prefillRows} *
                         geometry.target.denseIntermediateSize));
  put(PrefillTensor::FullPacked,
      bytesFor<uint16_t>(uint64_t{prefillRows} *
                         geometry.target.packedFullWidth));
  put(PrefillTensor::FullQueries,
      bytesFor<uint16_t>(uint64_t{geometry.target.attentionQueryHeads} *
                         packedAttentionRows *
                         geometry.target.attentionHeadDimension));
  put(PrefillTensor::FullAttention,
      bytesFor<uint16_t>(uint64_t{geometry.target.attentionQueryHeads} *
                         packedAttentionRows *
                         geometry.target.attentionHeadDimension));
  const ops::AttentionWorkspace attentionWorkspace =
      operators.prefillAttentionWorkspace(
          prefillRows, geometry.target.attentionQueryHeads,
          geometry.target.kvLayout);
  put(PrefillTensor::AttentionPartials, attentionWorkspace.partialsBytes);
  put(PrefillTensor::AttentionStatistics, attentionWorkspace.statisticsBytes);
  put(PrefillTensor::AttentionHidden,
      bytesFor<uint16_t>(uint64_t{prefillRows} *
                         geometry.target.attentionWidth));
  put(PrefillTensor::AttentionOutput,
      bytesFor<uint16_t>(uint64_t{prefillRows} * geometry.target.hiddenSize));
  put(PrefillTensor::ProjectionSums,
      bytesFor<float>(uint64_t{prefillRows} *
                      geometry.projectionSumsWidth()));
  put(PrefillTensor::DownProjectionSums,
      bytesFor<float>(uint64_t{prefillRows} *
                      geometry.projectionSumsWidth()));
  // Three rotary axes per row (Qwen3.5 M-RoPE); text rows repeat one value.
  put(PrefillTensor::TargetPositions,
      bytesFor<uint32_t>(uint64_t{prefillRows} * 3));
  put(PrefillTensor::DraftPositions, bytesFor<uint32_t>(prefillRows));
  put(PrefillTensor::TargetInverseFrequencies,
      bytesFor<float>(geometry.target.rotaryPairs));
  put(PrefillTensor::DraftInverseFrequencies,
      bytesFor<float>(geometry.draftRotaryPairs()));
  put(PrefillTensor::RopeCos,
      bytesFor<float>(uint64_t{prefillRows} * geometry.target.rotaryPairs));
  put(PrefillTensor::RopeSin,
      bytesFor<float>(uint64_t{prefillRows} * geometry.target.rotaryPairs));
  put(PrefillTensor::ContextProjected,
      bytesFor<uint16_t>(uint64_t{prefillRows} * geometry.draft.hiddenSize));
  put(PrefillTensor::ContextHidden,
      bytesFor<uint16_t>(uint64_t{prefillRows} * geometry.draft.hiddenSize));
  put(PrefillTensor::ContextKv,
      bytesFor<uint16_t>(uint64_t{prefillRows} *
                         geometry.draft.contextKvSize()));
  put(PrefillTensor::DraftRopeCos,
      bytesFor<float>(uint64_t{prefillRows} *
                      geometry.draftRotaryPairs()));
  put(PrefillTensor::DraftRopeSin,
      bytesFor<float>(uint64_t{prefillRows} *
                      geometry.draftRotaryPairs()));
  put(PrefillTensor::ChunkKeys,
      bytesFor<uint16_t>(uint64_t{geometry.target.attentionKvHeads} *
                         packedAttentionRows *
                         geometry.target.attentionHeadDimension));
  put(PrefillTensor::ChunkValues,
      bytesFor<uint16_t>(uint64_t{geometry.target.attentionKvHeads} *
                         packedAttentionRows *
                         geometry.target.attentionHeadDimension));
  // The split partials and counters and the rotated rows of the largest
  // prefill plan.
  for (const auto &projection : geometry.target.prefillProjections) {
    const ops::LinearScratchSize linear = operators.linear().prefillScratchSize(projection, prefillRows);
    put(PrefillTensor::LinearPartials, linear.partials);
    put(PrefillTensor::LinearCounters, linear.counters);
    put(PrefillTensor::LinearRotated, linear.rotated);
  }
  if (geometry.target.ffnKind == QwenFfnKind::SparseMoe) {
    const ops::MoeWorkspace workspace =
        operators.moePrefillWorkspace(geometry.target.moeShape(), prefillRows);
    for (size_t field = 0; field < ops::kMoeScratchFields.size(); ++field)
      put(moeScratchTensor<PrefillTensor>(field),
          workspace.*ops::kMoeScratchFields[field].bytes);
  }
  return result;
}

PrefillLifetime prefillLifetime(PrefillTensor tensor) noexcept {
  switch (tensor) {
  case PrefillTensor::GdnPacked:
  case PrefillTensor::GdnQueries:
  case PrefillTensor::GdnKeys:
  case PrefillTensor::GdnValues:
  case PrefillTensor::GdnDecay:
  case PrefillTensor::GdnBeta:
  case PrefillTensor::Recurrent:
  case PrefillTensor::GdnHidden:
    return PrefillLifetime::Gdn;
  case PrefillTensor::FullPacked:
  case PrefillTensor::FullQueries:
  case PrefillTensor::FullAttention:
  case PrefillTensor::AttentionPartials:
  case PrefillTensor::AttentionStatistics:
  case PrefillTensor::AttentionHidden:
  case PrefillTensor::ChunkKeys:
  case PrefillTensor::ChunkValues:
    return PrefillLifetime::Attention;
  case PrefillTensor::GateIntermediate:
  case PrefillTensor::Intermediate:
  case PrefillTensor::DownProjectionSums:
    return PrefillLifetime::Ffn;
  case PrefillTensor::ContextProjected:
  case PrefillTensor::ContextHidden:
  case PrefillTensor::ContextKv:
    return PrefillLifetime::DraftContext;
  case PrefillTensor::GdnOutput:
  case PrefillTensor::AttentionOutput:
    return PrefillLifetime::MixerResidual;
  default:
    if (tensor >= PrefillTensor::MoeScratch && tensor <= PrefillTensor::MoeScratchLast)
      return PrefillLifetime::Ffn;
    return PrefillLifetime::Persistent;
  }
}

PrefillArenaLayout planPrefillArena(const RuntimeGeometry &geometry,
                                  const ops::ExecutionPlans &operators) {
  PrefillArenaLayout layout;
  layout.sizes = prefillTensorBytes(geometry, operators);
  std::array<uint64_t, uint32_t(PrefillLifetime::Count)> spans{};
  for (uint32_t i = 0; i < prefillTensorCount; ++i) {
    const auto lifetime = prefillLifetime(PrefillTensor(i));
    auto &span = spans[uint32_t(lifetime)];
    if (lifetime == PrefillLifetime::MixerResidual) {
      // Only one mixer runs in a layer; its output remains live through FFN.
      layout.offsets[i] = 0;
      span = std::max(span, alignUp(layout.sizes[i]));
    } else {
      layout.offsets[i] = span;
      span = checkedAdd(span, alignUp(layout.sizes[i]), "prefill lifetime");
    }
  }
  const uint64_t persistent = spans[uint32_t(PrefillLifetime::Persistent)];
  const uint64_t residual = spans[uint32_t(PrefillLifetime::MixerResidual)];
  const uint64_t scratchBase = checkedAdd(persistent, residual, "prefill workspace offset");
  uint64_t scratch = 0;
  for (const auto lifetime : {PrefillLifetime::Gdn, PrefillLifetime::Attention,
                              PrefillLifetime::Ffn, PrefillLifetime::DraftContext})
    scratch = std::max(scratch, spans[uint32_t(lifetime)]);
  scratch = std::max(scratch, sharedDecodeWorkspaceBytes(geometry, operators));
  for (uint32_t i = 0; i < prefillTensorCount; ++i) {
    const auto lifetime = prefillLifetime(PrefillTensor(i));
    if (lifetime != PrefillLifetime::Persistent)
      layout.offsets[i] = checkedAdd(layout.offsets[i],
          lifetime == PrefillLifetime::MixerResidual ? persistent : scratchBase,
          "prefill tensor offset");
  }
  layout.bytes = checkedAdd(scratchBase, scratch, "prefill arena");
  layout.workspaceOffset = scratchBase;
  layout.workspaceBytes = scratch;
  return layout;
}

uint64_t plannedPrefillBytes(const RuntimeGeometry &geometry,
                            const ops::ExecutionPlans &operators) {
  return planPrefillArena(geometry, operators).bytes;
}

static uint64_t gdnPackedStride(const RuntimeGeometry &geometry) noexcept {
  return bytesFor<uint16_t>(uint64_t{kDecodeRows} *
                            geometry.target.packedGdnWidth);
}
static uint64_t gdnMixedStride(const RuntimeGeometry &geometry) noexcept {
  return bytesFor<uint16_t>(uint64_t{kDecodeRows} *
                            geometry.target.convolutionDimension);
}
static uint64_t gdnDecayStride(const RuntimeGeometry &geometry) noexcept {
  return bytesFor<float>(uint64_t{kDecodeRows} *
                         geometry.target.gdnValueHeads);
}
static uint64_t gdnBetaStride(const RuntimeGeometry &geometry) noexcept {
  return bytesFor<uint16_t>(uint64_t{kDecodeRows} *
                            geometry.target.gdnValueHeads);
}
static uint64_t decodeChunkLayerBytes(const RuntimeGeometry &geometry) noexcept {
  return bytesFor<uint16_t>(uint64_t{geometry.target.attentionKvHeads} *
                            kv::kVerifyChunkStride *
                            geometry.target.attentionHeadDimension);
}

std::array<uint64_t, decodeTensorCount>
decodeTensorBytes(const RuntimeGeometry &geometry,
                  const ops::ExecutionPlans &operators) {
  std::array<uint64_t, decodeTensorCount> result{};
  const auto draftWorkspace =
      operators.draftAttentionWorkspacePerLane(geometry.draft.attentionShape());
  const auto samplingWorkspace = ops::Sampling::workspace(kDecodeRows);
  const auto selectorWorkspace = ops::DraftSelector::workspace(kDraftProposalTokens);
  auto put = [&](DecodeTensor tensor, uint64_t bytes) {
    auto &size = result[static_cast<uint32_t>(tensor)];
    size = std::max(size, bytes);
  };
  const uint64_t r = kDecodeRows;
  put(DecodeTensor::Hidden0,
      bytesFor<uint16_t>(r * geometry.target.hiddenSize));
  put(DecodeTensor::Hidden1,
      bytesFor<uint16_t>(r * geometry.target.hiddenSize));
  put(DecodeTensor::InputTokens, bytesFor<uint32_t>(r));
  put(DecodeTensor::Normalized,
      bytesFor<uint16_t>(r * geometry.target.hiddenSize));
  put(DecodeTensor::GdnHidden,
      bytesFor<uint16_t>(r * geometry.target.attentionWidth));
  put(DecodeTensor::GdnOutput,
      bytesFor<uint16_t>(r * geometry.target.hiddenSize));
  put(DecodeTensor::Intermediate,
      bytesFor<uint16_t>(r * geometry.target.denseIntermediateSize));
  put(DecodeTensor::FullPacked,
      bytesFor<uint16_t>(r * geometry.target.packedFullWidth));
  put(DecodeTensor::FullQueries,
      bytesFor<uint16_t>(uint64_t{geometry.target.attentionQueryHeads} *
                         kv::kVerifyChunkStride *
                         geometry.target.attentionHeadDimension));
  const ops::AttentionWorkspace attentionWorkspace =
      operators.verifyAttentionWorkspacePerLane(
          geometry.target.attentionQueryHeads, geometry.target.kvLayout);
  put(DecodeTensor::AttentionPartials, attentionWorkspace.partialsBytes);
  put(DecodeTensor::AttentionStatistics, attentionWorkspace.statisticsBytes);
  put(DecodeTensor::FullAttention,
      bytesFor<uint16_t>(uint64_t{geometry.target.attentionQueryHeads} *
                         kv::kVerifyChunkStride *
                         geometry.target.attentionHeadDimension));
  put(DecodeTensor::AttentionHidden,
      bytesFor<uint16_t>(r * geometry.target.attentionWidth));
  put(DecodeTensor::AttentionOutput,
      bytesFor<uint16_t>(r * geometry.target.hiddenSize));
  put(DecodeTensor::Positions, bytesFor<uint32_t>(r * 3));
  put(DecodeTensor::DraftPositions, bytesFor<uint32_t>(r));
  put(DecodeTensor::RopeCos,
      bytesFor<float>(r * geometry.target.rotaryPairs));
  put(DecodeTensor::RopeSin,
      bytesFor<float>(r * geometry.target.rotaryPairs));
  put(DecodeTensor::ContextProjected,
      bytesFor<uint16_t>(r * geometry.draft.hiddenSize));
  put(DecodeTensor::ContextHidden,
      bytesFor<uint16_t>(r * geometry.draft.hiddenSize));
  put(DecodeTensor::ContextKv,
      bytesFor<uint16_t>(r * geometry.draft.contextKvSize()));
  put(DecodeTensor::CapturedTargetHidden,
      bytesFor<uint16_t>(r * geometry.draft.targetHiddenSize));
  put(DecodeTensor::DraftQueryKeys, draftWorkspace.queryKeysBytes);
  put(DecodeTensor::DraftQueryValues, draftWorkspace.queryValuesBytes);
  // Proposal attention and accepted target-hidden injection use the same
  // eight absolute positions, so one RoPE table per lane is sufficient.
  put(DecodeTensor::DraftRopeCos,
      bytesFor<float>(r * geometry.draftRotaryPairs()));
  put(DecodeTensor::DraftRopeSin,
      bytesFor<float>(r * geometry.draftRotaryPairs()));
  put(DecodeTensor::FinalHidden,
      bytesFor<uint16_t>(r * geometry.target.hiddenSize));
  put(DecodeTensor::Logits,
      bytesFor<float>(r * geometry.target.vocabularySize));
  put(DecodeTensor::ArgmaxValues, samplingWorkspace.argmaxValuesBytes);
  put(DecodeTensor::ArgmaxIndices, samplingWorkspace.argmaxIndicesBytes);
  put(DecodeTensor::TargetPartialMasses, samplingWorkspace.partialMassesBytes);
  put(DecodeTensor::TargetVocabularyRows, samplingWorkspace.vocabularyRowsBytes);
  put(DecodeTensor::TargetVocabularyRanges,
      samplingWorkspace.vocabularyRangesBytes);
  put(DecodeTensor::TargetVocabularyArrivals,
      samplingWorkspace.vocabularyArrivalsBytes);
  put(DecodeTensor::SamplingUniforms, bytesFor<float>(kSamplingUniformCount));
  put(DecodeTensor::ConstraintMasks,
      bytesFor<uint32_t>(uint64_t{ExecutionLimits::maximumStepTokens} *
                         geometry.maskWords()));
  put(DecodeTensor::OutputTokens, bytesFor<uint32_t>(r));
  put(DecodeTensor::RetainedCount, sizeof(uint32_t));
  put(DecodeTensor::AcceptedCount, sizeof(uint32_t));
  put(DecodeTensor::DraftInputTokens, bytesFor<uint32_t>(r));
  for (uint32_t index = 0; index < 2; ++index) {
    put(static_cast<DecodeTensor>(
            static_cast<uint32_t>(DecodeTensor::DraftHidden0) + index),
        bytesFor<uint16_t>(r * geometry.draft.hiddenSize));
  }
  put(DecodeTensor::DraftNormalized,
      bytesFor<uint16_t>(r * geometry.draft.hiddenSize));
  put(DecodeTensor::DraftDynamic,
      bytesFor<uint16_t>(r * geometry.draft.dynamicSize));
  put(DecodeTensor::DraftConvolved, draftWorkspace.convolutionBytes);
  put(DecodeTensor::DraftProposalQkv, draftWorkspace.qkvBytes);
  put(DecodeTensor::DraftAttention, draftWorkspace.groupedQueriesBytes);
  put(DecodeTensor::DraftProjected,
      bytesFor<uint16_t>(r * geometry.draft.hiddenSize));
  put(DecodeTensor::DraftResidual,
      bytesFor<uint16_t>(r * geometry.draft.hiddenSize));
  put(DecodeTensor::DraftIntermediate,
      bytesFor<uint16_t>(r * geometry.draft.intermediateSize));
  put(DecodeTensor::DraftFinalHidden,
      bytesFor<uint16_t>(r * geometry.draft.hiddenSize));
  put(DecodeTensor::SelectorHidden,
      bytesFor<uint16_t>(r * geometry.draft.selectorRank));
  put(DecodeTensor::Candidates, selectorWorkspace.candidatesBytes);
  put(DecodeTensor::Unary, selectorWorkspace.unaryBytes);
  put(DecodeTensor::TopPartialIds, selectorWorkspace.partialIdsBytes);
  put(DecodeTensor::TopPartialValues, selectorWorkspace.partialValuesBytes);
  put(DecodeTensor::ProposalProbs, selectorWorkspace.proposalProbabilitiesBytes);
  put(DecodeTensor::ProposedTokens, bytesFor<uint32_t>(kDraftProposalTokens));
  put(DecodeTensor::PageTable, bytesFor<SplashKvPage>(kMaximumPageTableEntries));
  put(DecodeTensor::PenaltyState,
      bytesFor<uint32_t>(geometry.target.vocabularySize));
  put(DecodeTensor::VerifyPackedBase,
      uint64_t{geometry.target.stateLayout.layers} *
          gdnPackedStride(geometry));
  put(DecodeTensor::VerifyMixedBase,
      uint64_t{geometry.target.stateLayout.layers} *
          gdnMixedStride(geometry));
  put(DecodeTensor::VerifyDecayBase,
      uint64_t{geometry.target.stateLayout.layers} *
          gdnDecayStride(geometry));
  put(DecodeTensor::VerifyBetaBase,
      uint64_t{geometry.target.stateLayout.layers} *
          gdnBetaStride(geometry));
  put(DecodeTensor::ChunkKeysBase,
      uint64_t{geometry.target.kvLayout.attentionLayers} *
          decodeChunkLayerBytes(geometry));
  put(DecodeTensor::ChunkValuesBase,
      uint64_t{geometry.target.kvLayout.attentionLayers} *
          decodeChunkLayerBytes(geometry));
  if (geometry.target.ffnKind == QwenFfnKind::SparseMoe) {
    const ops::MoeWorkspace workspace =
        operators.moeDecodeWorkspacePerLane(geometry.target.moeShape());
    for (size_t field = 0; field < ops::kMoeScratchFields.size(); ++field)
      put(moeScratchTensor<DecodeTensor>(field),
          workspace.*ops::kMoeScratchFields[field].bytes);
  }
  return result;
}

uint64_t decodeArenaBaseBytes(const RuntimeGeometry &geometry,
                             const ops::ExecutionPlans &operators) {
  uint64_t bytes = 0;
  const auto sizes = decodeTensorBytes(geometry, operators);
  for (uint32_t i = 0; i < decodeTensorCount; ++i) {
    if (isSharedDecodeTensor(DecodeTensor(i))) continue;
    const uint64_t value = sizes[i];
    bytes = checkedAdd(
        bytes, alignUp(checkedMultiply(value, kLaneCount, "decode tensor")),
        "decode arena");
  }
  return bytes;
}

uint64_t sharedDecodeWorkspaceBytes(const RuntimeGeometry &geometry,
                                  const ops::ExecutionPlans &operators) {
  uint64_t bytes = 0;
  const auto sizes = decodeTensorBytes(geometry, operators);
  for (uint32_t i = 0; i < decodeTensorCount; ++i)
    if (isSharedDecodeTensor(DecodeTensor(i)))
      bytes = checkedAdd(bytes, alignUp(checkedMultiply(sizes[i], kLaneCount, "shared decode tensor")),
                         "shared decode workspace");
  return bytes;
}

ops::LinearScratchSize DecodeArena::linearScratchSize(
    const RuntimeGeometry &geometry, const ops::ExecutionPlans &operators) {
  const auto &d = geometry.draft;
  ops::LinearScratchSize result;
  // Includes the vocabulary head shared with the draft, whose own
  // projections are affine.
  for (const auto &p : geometry.target.decodeProjections) result.include(operators.linear().decodeScratchSize(p));
  for (const ops::ProjectionShape shape : {ops::ProjectionShape{d.dynamicSize, d.hiddenSize},
       {d.qkvSize, d.hiddenSize}, {d.contextKvSize(), d.hiddenSize},
       {d.hiddenSize, d.attentionSize},
       {d.intermediateSize, d.hiddenSize}, {d.hiddenSize, d.intermediateSize},
       {d.selectorRank, d.hiddenSize}, {d.hiddenSize, d.targetHiddenSize}})
    result.include(operators.linear().decodeScratchSize(shape));
  return result;
}

uint64_t plannedDecodeBytes(const RuntimeGeometry &geometry,
                           const ops::ExecutionPlans &operators) {
  return checkedAdd(decodeArenaBaseBytes(geometry, operators),
                    checkedAdd(DecodeArena::gateScratchBytes(geometry, operators),
                               DecodeArena::linearScratchSize(geometry, operators).bytes(),
                               "Q4 decode scratch"),
                    "planned gate scratch");
}

} // namespace splash::model
