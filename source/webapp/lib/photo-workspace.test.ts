import assert from "node:assert/strict";
import test from "node:test";
import { exportedPhotoEdit, newPhotoEdit, readPhotoEdit, samePhotoEdit } from "./photo-editor";
import { mergePhotoDraft, photoPreviewIdentity, singlePhotoOverride } from "./photo-workspace";

test("photo drafts replace every image field while preserving other modes and frame settings", () => {
  const calendar = { style: "month" };
  const base = { MY_ADAPTIVE: { image_urls: ["old"], image_url: "old", photo_edits: [], dithering: "ordered" }, CALENDAR: calendar };
  for (const images of [["edited"], ["old", "added"], ["second"], ["second", "first"], []]) {
    const edits = images.map((url) => ({ ...newPhotoEdit(`original:${url}`), rotation: 90 }));
    const result = mergePhotoDraft(base, images, edits);
    assert.deepEqual(result.MY_ADAPTIVE.image_urls, images);
    assert.equal(result.MY_ADAPTIVE.image_url, images[0] || "");
    assert.deepEqual(result.MY_ADAPTIVE.photo_edits, edits);
    assert.equal(result.MY_ADAPTIVE.dithering, "ordered");
    assert.equal(result.CALENDAR, calendar);
  }
  assert.deepEqual(base.MY_ADAPTIVE.image_urls, ["old"]);
});

test("saving and reloading a large album preserves every photo, order and edit", () => {
  const images = Array.from({ length: 40 }, (_, i) => `/api/uploads/photo-${i}.png`);
  const edits = images.map((url, i) => ({ ...newPhotoEdit(url), rotation: i % 4 * 90 }));
  const calendar = { reminders: { "2026-12-01": "Keep me" } };
  const saved = mergePhotoDraft({ CALENDAR: calendar, MY_ADAPTIVE: { dithering: "ordered" } }, images, edits);
  const reloaded = JSON.parse(JSON.stringify(saved));
  assert.deepEqual(reloaded.MY_ADAPTIVE.image_urls, images);
  assert.deepEqual(reloaded.MY_ADAPTIVE.photo_edits, edits);
  assert.deepEqual(reloaded.CALENDAR, calendar);
  assert.equal(reloaded.MY_ADAPTIVE.dithering, "ordered");
  const nextImages = [...images, "/api/uploads/new-photo.png"];
  const nextEdits = [...edits, newPhotoEdit(nextImages.at(-1)!)];
  const added = mergePhotoDraft(reloaded, nextImages, nextEdits);
  assert.deepEqual(added.MY_ADAPTIVE.image_urls, nextImages);
  assert.deepEqual(added.MY_ADAPTIVE.photo_edits, nextEdits);
});

test("preview identity changes for device, dimensions, color, URL and edit version", () => {
  const edit = newPhotoEdit("source-A");
  const key = photoPreviewIdentity("A", 768, 552, 4, "photo-A", edit);
  const variants = [
    photoPreviewIdentity("B", 768, 552, 4, "photo-A", edit),
    photoPreviewIdentity("A", 800, 552, 4, "photo-A", edit),
    photoPreviewIdentity("A", 768, 480, 4, "photo-A", edit),
    photoPreviewIdentity("A", 768, 552, 2, "photo-A", edit),
    photoPreviewIdentity("A", 768, 552, 4, "photo-B", edit),
    photoPreviewIdentity("A", 768, 552, 4, "photo-A", { ...edit, rotation: 90 }),
    photoPreviewIdentity("A", 768, 552, 4, "photo-A", { ...edit, source_url: "source-B" }),
  ];
  for (const variant of variants) assert.notEqual(variant, key);
});

test("editor dirty comparison normalizes legacy metadata but detects real edits and undo", () => {
  const initial = { ...newPhotoEdit("original"), rotation: 360, zoom: Number.NaN };
  const normalized = readPhotoEdit(initial, "original");
  assert.equal(samePhotoEdit(initial, normalized), true);
  assert.equal(samePhotoEdit(normalized, { ...normalized, rotation: 90 }), false);
  assert.equal(samePhotoEdit(normalized, { ...normalized, orientation: "portrait" }), false);
  assert.equal(samePhotoEdit(normalized, { ...normalized, zoom: 2 }), false);
  assert.equal(samePhotoEdit(normalized, { ...normalized }), true);
});

test("legacy profiles default to warm, known choices and valid variant URLs survive normalization", () => {
  for (const value of [undefined, "invalid", "CLASSIC", null, 4]) assert.equal(readPhotoEdit({ color_profile: value }, "fallback").color_profile, "einkwarm");
  const variants = { classic: "classic.png", einkwarm: "warm.png", other: "ignore" };
  const edit = readPhotoEdit({ color_profile: "classic", color_variants: variants }, "fallback");
  assert.equal(edit.color_profile, "classic");
  assert.deepEqual(edit.color_variants, { classic: "classic.png", einkwarm: "warm.png" });
  variants.classic = "mutated";
  assert.equal(edit.color_variants?.classic, "classic.png");
  assert.equal(readPhotoEdit({ color_variants: { classic: 42, einkwarm: " " } }, "fallback").color_variants, undefined);
});

test("deep dirty comparison and preview identity cover profile and every variant URL", () => {
  const base = { ...newPhotoEdit("rgb"), color_variants: { classic: "c", einkwarm: "w" } };
  const reordered = { ...base, color_variants: { einkwarm: "w", classic: "c" } };
  assert.equal(samePhotoEdit(base, reordered), true);
  assert.equal(photoPreviewIdentity("A", 768, 552, 4, "w", base), photoPreviewIdentity("A", 768, 552, 4, "w", reordered));
  for (const changed of [{ ...base, color_profile: "classic" as const }, { ...base, color_variants: { ...base.color_variants, classic: "new-c" } }, { ...base, color_variants: { ...base.color_variants, einkwarm: "new-w" } }]) {
    assert.equal(samePhotoEdit(base, changed), false);
    assert.notEqual(photoPreviewIdentity("A", 768, 552, 4, "w", base), photoPreviewIdentity("A", 768, 552, 4, "w", changed));
  }
});

test("a second-photo preview sends only that photo and its selected profile, not the album metadata", () => {
  const images = ["first-warm", "second-classic"];
  const edits = [newPhotoEdit("first-source"), { ...newPhotoEdit("second-source"), color_profile: "classic" as const, color_variants: { classic: "second-classic", einkwarm: "second-warm" } }];
  const result = singlePhotoOverride({ image_urls: images, photo_edits: edits, dithering: "ordered" }, images, edits, 1);
  assert.deepEqual(result.image_urls, ["second-classic"]);
  assert.equal(result.image_url, "second-classic");
  assert.deepEqual(result.photo_edits, [edits[1]]);
  assert.equal(result.dithering, "ordered");
  const saved = mergePhotoDraft({}, images, edits).MY_ADAPTIVE;
  const reloaded = (saved.photo_edits as unknown[]).map((value, i) => readPhotoEdit(value, images[i]));
  assert.deepEqual(reloaded, edits);
});

test("geometry export clears stale variants while keeping the selected color and RGB original", () => {
  const before = { ...newPhotoEdit("full-rgb"), color_profile: "classic" as const, color_variants: { classic: "c", einkwarm: "w" } };
  const exported = exportedPhotoEdit({ ...before, zoom: 2, rotation: 90 });
  assert.equal(exported.color_variants, undefined);
  assert.equal(exported.color_profile, "classic");
  assert.equal(exported.source_url, "full-rgb");
  assert.equal(exported.zoom, 2);
  assert.equal(exported.rotation, 90);
  assert.deepEqual(before.color_variants, { classic: "c", einkwarm: "w" });
});
