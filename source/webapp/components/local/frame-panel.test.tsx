import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FramePanel } from "./frame-panel";
import { newPhotoEdit } from "../../lib/photo-editor";

function render(colors: number, classic = false) {
  const props: Parameters<typeof FramePanel>[0] = {
    images: ["photo"], edits: [{ ...newPhotoEdit("rgb"), color_profile: classic ? "classic" : "einkwarm" }],
    width: 768, height: 552, uploading: false, saving: false, preview: null, previewLoading: false,
    status: "在线", deviceName: "相框", interval: 60, mac: "AA", colors, previewIdentity: null,
    onPreviewInvalidated() {}, onAdd() {}, onEdit() {}, onMove() {}, onRemove() {},
    onSave() {}, onPreview() {}, tr: (zh) => zh,
  };
  return renderToStaticMarkup(<FramePanel {...props} />);
}

test("frame home keeps its original edit and preview controls; filters belong inside editing", () => {
  for (const colors of [2, 3, 4]) {
    const html = render(colors);
    assert.doesNotMatch(html, /frame-color-options|经典四色|自然暖调/);
    assert.match(html, /编辑照片/);
    assert.match(html, /墨水屏效果/);
  }
});
