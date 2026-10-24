import assert from "node:assert/strict";
import test from "node:test";
import { newPhotoEdit } from "./photo-editor";
import { isPaletteRgba, PhotoColorError, previewPhotoFilter, type PhotoColorIO, type PhotoFilterIO } from "./photo-color-profile";

const frame = (id: string) => ({ id, naturalWidth: 768, naturalHeight: 552 } as unknown as HTMLImageElement);
function fixture(palette: string[] = []) {
  const calls: string[] = [];
  const io: PhotoColorIO = {
    async load(url) { calls.push(`load:${url}`); return frame(url); },
    isPalette(image) { const id = (image as unknown as { id: string }).id; calls.push(`pixels:${id}`); return palette.includes(id); },
    async compose(_image, edit) { calls.push(`compose:${edit.orientation}:${edit.rotation}:${edit.zoom}`); return { name: "composed.png" } as File; },
    async upload() { calls.push("upload"); return "regenerated-rgb"; },
  };
  const signal = new AbortController().signal;
  return { io, calls, signal };
}
const errorCode = (code: PhotoColorError["code"]) => (error: unknown) => error instanceof PhotoColorError && error.code === code;

test("complete palette union is exact after white alpha compositing; one outlier is a photograph", () => {
  const colors = [0, 0xffffff, 0xe8b000, 0xc80000, 0xffff00, 0xff0000];
  const data = colors.flatMap((rgb) => [rgb >> 16, (rgb >> 8) & 255, rgb & 255, 255]);
  assert.equal(isPaletteRgba(data), true);
  assert.equal(isPaletteRgba([...data, 12, 34, 56, 0]), true);
  assert.equal(isPaletteRgba([...data, 201, 0, 0, 255]), false);
  assert.equal(isPaletteRgba([...data, 200, 0, 0, 128]), false);
  assert.equal(isPaletteRgba([]), false);
});

function filterFixture(palette: string[] = []) {
  const base = fixture(palette);
  const profiles: string[] = [];
  const io: PhotoFilterIO = { ...base.io, async preview(url, edit) {
    base.calls.push(`preview:${url}:${edit.color_profile}`); profiles.push(edit.color_profile);
    assert.equal(edit.color_variants, undefined);
    return frame(`rendered-${edit.color_profile}`);
  } };
  return { ...base, io, profiles, cache: new Map<string, string>() };
}

test("editor previews existing prepared variants directly when geometry is unchanged", async () => {
  const { io, calls, signal, cache } = filterFixture();
  const initial = { ...newPhotoEdit("rgb"), color_variants: { classic: "c", einkwarm: "w" } };
  await previewPhotoFilter("w", initial, { ...initial, color_profile: "classic" }, null, io, cache, signal, () => true);
  assert.deepEqual(calls, ["load:c"]); assert.equal(cache.size, 0);
});

test("editor uploads one fullRGB crop for both server-rendered filters and can reuse it on Done", async () => {
  const { io, calls, signal, cache, profiles } = filterFixture();
  const initial = newPhotoEdit("rgb");
  const original = frame("rgb");
  await previewPhotoFilter("photo", initial, initial, original, io, cache, signal, () => true);
  await previewPhotoFilter("photo", initial, { ...initial, color_profile: "classic" }, original, io, cache, signal, () => true);
  assert.equal(calls.filter((call) => call === "upload").length, 1);
  assert.equal(calls.filter((call) => call.startsWith("compose:")).length, 1);
  assert.deepEqual(profiles, ["einkwarm", "classic"]);
  assert.deepEqual([...cache.values()], ["regenerated-rgb"]);
  assert.equal(initial.color_profile, "einkwarm");
});

test("changing geometry ignores stale variants and renders the current RGB crop/profile", async () => {
  const { io, calls, signal, cache } = filterFixture();
  const initial = { ...newPhotoEdit("rgb"), color_variants: { classic: "old-c", einkwarm: "old-w" } };
  const candidate = { ...initial, orientation: "portrait" as const, rotation: 90, zoom: 2, color_profile: "classic" as const };
  await previewPhotoFilter("old-w", initial, candidate, frame("rgb"), io, cache, signal, () => true);
  assert.equal(calls.some((call) => call === "load:old-c"), false);
  assert.ok(calls.includes("compose:portrait:90:2"));
  assert.ok(calls.includes("preview:regenerated-rgb:classic"));
  assert.deepEqual(initial.color_variants, { classic: "old-c", einkwarm: "old-w" });
});

test("encoded-only editor source displays its current effect but rejects another profile", async () => {
  const { io, calls, signal, cache } = filterFixture(["encoded"]);
  const initial = newPhotoEdit("encoded");
  await previewPhotoFilter("encoded", initial, initial, frame("encoded"), io, cache, signal, () => true);
  assert.ok(calls.includes("load:encoded"));
  await assert.rejects(previewPhotoFilter("encoded", initial, { ...initial, color_profile: "classic" }, frame("encoded"), io, cache, signal, () => true), errorCode("source_required"));
  assert.equal(calls.includes("upload"), false);
});

test("editor legacy encoded image regenerates from retained RGB and cannot commit a stale preview", async () => {
  const { io, signal, cache, calls } = filterFixture(["encoded"]);
  const initial = newPhotoEdit("rgb");
  let current = true;
  io.preview = async () => { current = false; return frame("stale-effect"); };
  await assert.rejects(previewPhotoFilter("encoded", initial, { ...initial, color_profile: "classic" }, frame("rgb"), io, cache, signal, () => current), errorCode("stale"));
  assert.ok(calls.includes("compose:landscape:0:1"));
  assert.equal(initial.color_profile, "einkwarm");
});

test("failed filter preview preserves metadata and never replaces the cached fullRGB crop with effect pixels", async () => {
  const { io, signal, cache } = filterFixture();
  const initial = newPhotoEdit("rgb");
  io.preview = async () => { throw new Error("backend unavailable"); };
  await assert.rejects(previewPhotoFilter("photo", initial, { ...initial, color_profile: "classic" }, frame("rgb"), io, cache, signal, () => true), errorCode("image_unavailable"));
  assert.equal(initial.color_profile, "einkwarm");
  assert.deepEqual([...cache.values()], ["regenerated-rgb"]);
});


test("encoded-only legacy photos retain crop/export when their profile is unchanged", async () => {
  const { io, calls, signal, cache } = filterFixture(["encoded"]);
  const initial = newPhotoEdit("encoded");
  const candidate = { ...initial, zoom: 1.8, offset_x: .2 };
  await previewPhotoFilter("encoded", initial, candidate, frame("encoded"), io, cache, signal, () => true);
  assert.ok(calls.includes("compose:landscape:0:1.8"));
  assert.ok(calls.includes("preview:regenerated-rgb:einkwarm"));
  assert.deepEqual(initial, newPhotoEdit("encoded"));
  await assert.rejects(previewPhotoFilter("encoded", initial, { ...candidate, color_profile: "classic" }, frame("encoded"), io, cache, signal, () => true), errorCode("source_required"));
});

test("editor load, export and upload failures preserve choice and original metadata", async () => {
  for (const stage of ["load", "compose", "upload"] as const) {
    const { io, signal, cache } = filterFixture();
    const initial = { ...newPhotoEdit("rgb"), color_variants: { classic: "missing-c" } };
    const candidate = { ...initial, color_profile: "classic" as const, ...(stage === "load" ? {} : { zoom: 2 }) };
    io[stage] = async () => { throw new Error("unavailable"); };
    await assert.rejects(previewPhotoFilter("w", initial, candidate, frame("rgb"), io, cache, signal, () => true), errorCode("image_unavailable"));
    assert.equal(initial.color_profile, "einkwarm");
    assert.equal(initial.zoom, 1);
    assert.equal(cache.size, 0);
  }
});

test("actual editor preview guards abort and staleness after load, compose and upload", async () => {
  for (const stage of ["load", "compose", "upload"] as const) {
    const { io, signal, cache, calls } = filterFixture();
    let current = true;
    const initial = { ...newPhotoEdit("rgb"), ...(stage === "load" ? { color_variants: { classic: "c" } } : {}) };
    if (stage === "load") io.load = async (url) => { current = false; return frame(url); };
    if (stage === "compose") io.compose = async () => { current = false; return {} as File; };
    if (stage === "upload") io.upload = async () => { current = false; return "orphaned"; };
    await assert.rejects(previewPhotoFilter("w", initial, { ...initial, color_profile: "classic" }, frame("rgb"), io, cache, signal, () => current), errorCode("stale"));
    assert.equal(calls.some((call) => call.startsWith("preview:")), false);
    assert.equal(cache.size, 0);
  }
  const { io, cache, calls } = filterFixture();
  const controller = new AbortController(); controller.abort();
  const edit = newPhotoEdit("rgb");
  await assert.rejects(previewPhotoFilter("w", edit, edit, frame("rgb"), io, cache, controller.signal, () => true), errorCode("stale"));
  assert.deepEqual(calls, []);
});
