-- Keep remote images usable in the generated document without making LaTeX
-- treat their URLs as local filenames.
function Image(image)
  if image.src:match("^https?://") then
    local label = pandoc.utils.stringify(image.caption)
    if label == "" then
      label = image.src
    end
    return pandoc.Link({ pandoc.Str(label) }, image.src)
  end
  return image
end
