import assert from "node:assert/strict";
import test from "node:test";
import { localPhotoSource } from "./local-photo-source";
const path = "/api/uploads/12345678-1234-4567-89ab-123456789abc";
test("saved InkSight uploads resolve on the current instance without changing original URL metadata", () => {
  const edit = { source_url: `http://192.168.1.50:3000${path}` };
  assert.equal(localPhotoSource(edit.source_url), path);
  assert.equal(localPhotoSource(`https://old-frame.home${path}?v=2`), `${path}?v=2`);
  assert.equal(edit.source_url, `http://192.168.1.50:3000${path}`);
  assert.equal(localPhotoSource(path), path);
});
test("ordinary external photos and non-upload resources are not rewritten", () => {
  for (const source of ["https://photos.example.com/photo.jpg", "https://photos.example.com/api/uploads/not-an-inksight-id", "blob:http://localhost/picture", "data:image/png;base64,abc", "https://photos.example.com/download?url=" + path]) assert.equal(localPhotoSource(source), source);
});
