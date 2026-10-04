#pragma once

#include "model/ModelFactory.hpp"
#include "model/QwenTargetLoader.hpp"

#include <type_traits>

namespace splash::test {

// Sized projections without weight buffers, for arena and operator planning.
template <class Weights>
model::ModelPackage runtimeGeometryPackage() {
  model::ModelPackage result;
  Weights target;
  model::DFlashDraftLayout draft;
  if constexpr (std::is_same_v<Weights, model::Qwen3_6MoeWeights>) {
    draft.layers = 6;
    draft.hiddenSize = 2048;
    draft.dynamicSize = 512;
    draft.intermediateSize = 6144;
    draft.targetHiddenSize = target.layout.capturedHiddenSize();
  }
  const auto projection = [](uint32_t n, uint32_t k) {
    return ops::Projection(n, k, ops::AffineWeights{});
  };
  const auto &layout = target.layout;
  target.logitsProjection = projection(layout.vocabularySize, layout.hiddenSize);
  target.layers.resize(layout.layers);
  for (uint32_t i = 0; i < layout.layers; ++i) {
    auto &layer = target.layers[i];
    if (layout.isFullAttentionLayer(i)) {
      model::QwenAttentionWeights attention;
      attention.inputProjection = projection(layout.packedFullWidth, layout.hiddenSize);
      attention.outputProjection = projection(layout.hiddenSize, layout.attentionWidth);
      layer.mixer = std::move(attention);
    } else {
      model::QwenGdnWeights gdn;
      gdn.inputProjection = projection(layout.packedGdnWidth, layout.hiddenSize);
      gdn.outputProjection = projection(layout.hiddenSize, layout.attentionWidth);
      layer.mixer = std::move(gdn);
    }
    if constexpr (std::is_same_v<Weights, model::Qwen3_8Weights>) {
      layer.gateProjection = projection(layout.intermediateSize, layout.hiddenSize);
      layer.upProjection = layer.gateProjection;
      layer.downProjection = projection(layout.hiddenSize, layout.intermediateSize);
    }
  }
  ops::VisionLayout vision;
  vision.outputHiddenSize = target.layout.hiddenSize;
  result.descriptor = model::makeModelDescriptor(
      "operator workspace test", target.layout, draft, vision);
  result.target = std::move(target);
  result.draft.layout = draft;
  return result;
}

} // namespace splash::test
