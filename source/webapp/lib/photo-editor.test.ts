import assert from "node:assert/strict";
import test from "node:test";
import {
  beginPhotoGesture, drawPhotoFilter, endPhotoGesture, exportPhoto, movePhotoGesture, newPhotoEdit,
  newPhotoGesture, panPhotoBy, photoGeometry, readPhotoEdit, zoomPhotoAt,
  type PhotoEdit, type PhotoViewport,
} from "./photo-editor";

const original = "http://old-frame:3000/api/uploads/12345678-1234-4567-89ab-123456789abc";
const view: PhotoViewport = { sourceWidth: 800, sourceHeight: 600, width: 400, height: 400 };
const crop = (patch: Partial<PhotoEdit> = {}): PhotoEdit => ({ ...newPhotoEdit(original), zoom: 2, ...patch });
const geometry = (edit: PhotoEdit) => photoGeometry(view.sourceWidth, view.sourceHeight, view.width, view.height, edit);
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test("legacy edit metadata keeps the original URL and normalizes invalid values", () => {
  assert.deepEqual(readPhotoEdit(undefined, original), newPhotoEdit(original));
  const edit = readPhotoEdit({ source_url: original, orientation: "portrait", rotation: -90, zoom: 20, offset_x: NaN, offset_y: -8, fit: "contain" }, "flattened.png");
  assert.deepEqual(edit, { source_url: original, orientation: "portrait", rotation: 270, zoom: 4, offset_x: 0, offset_y: -1, fit: "contain", color_profile: "einkwarm" });
  assert.equal(readPhotoEdit({ zoom: Infinity, rotation: Infinity }, original).zoom, 1);
});

test("rotated cover and contain geometry uses the rotated image dimensions", () => {
  const edit = crop({ rotation: 90, zoom: 1 });
  const filled = photoGeometry(800, 400, 400, 200, edit);
  assert.deepEqual(filled, { scale: 1, panX: 0, panY: 300, centerX: 200, centerY: 100 });
  const fitted = photoGeometry(800, 400, 400, 200, { ...edit, fit: "contain" });
  assert.deepEqual(fitted, { scale: 0.25, panX: 0, panY: 0, centerX: 200, centerY: 100 });
});

test("pan clamps to the image edges and cannot displace an axis without overflow", () => {
  const edit = crop({ zoom: 1 });
  const moved = panPhotoBy(edit, view, { x: 5000, y: -5000 });
  assert.equal(moved.offset_x, 1);
  assert.equal(moved.offset_y, 0);
  assert.equal(moved.source_url, original);
  assert.equal(panPhotoBy(edit, view, { x: NaN, y: 0 }), edit);
});

test("zoom retains the image point under the pointer and uses the clamped zoom ratio", () => {
  const edit = crop({ offset_x: 0.1, offset_y: -0.1 });
  const point = { x: 230, y: 170 };
  const before = geometry(edit);
  for (const requested of [3, 20]) {
    const next = zoomPhotoAt(edit, view, requested, point);
    const after = geometry(next);
    near((point.x - before.centerX) / before.scale, (point.x - after.centerX) / after.scale);
    near((point.y - before.centerY) / before.scale, (point.y - after.centerY) / after.scale);
    assert.equal(next.zoom, Math.min(requested, 4));
    assert.equal(next.source_url, original);
  }
  assert.equal(zoomPhotoAt(edit, view, -100, point).zoom, 1);
});

test("single-finger dragging uses logical canvas distance", () => {
  const edit = crop();
  const gesture = beginPhotoGesture(newPhotoGesture(), 8, { x: 120, y: 160 }, edit);
  const moved = movePhotoGesture(gesture, 8, { x: 150, y: 180 }, view).edit!;
  near(geometry(moved).centerX - geometry(edit).centerX, 30);
  near(geometry(moved).centerY - geometry(edit).centerY, 20);
});

test("adding a second finger rebases the current crop without a jump", () => {
  let gesture = beginPhotoGesture(newPhotoGesture(), 8, { x: 120, y: 160 }, crop());
  const moved = movePhotoGesture(gesture, 8, { x: 150, y: 180 }, view);
  gesture = beginPhotoGesture(moved.gesture, 3, { x: 280, y: 220 }, moved.edit!);
  assert.deepEqual(movePhotoGesture(gesture, 3, { x: 280, y: 220 }, view).edit, moved.edit);
});

test("pinch follows its moving center instead of zooming toward the frame center", () => {
  const edit = crop({ offset_x: 0.1, offset_y: -0.1 });
  let gesture = beginPhotoGesture(newPhotoGesture(), 1, { x: 120, y: 160 }, edit);
  gesture = beginPhotoGesture(gesture, 2, { x: 280, y: 160 }, edit);
  const first = movePhotoGesture(gesture, 1, { x: 100, y: 180 }, view);
  const second = movePhotoGesture(first.gesture, 2, { x: 340, y: 180 }, view);
  const before = geometry(edit);
  const after = geometry(second.edit!);
  near(second.edit!.zoom, 3);
  near((200 - before.centerX) / before.scale, (220 - after.centerX) / after.scale);
  near((160 - before.centerY) / before.scale, (180 - after.centerY) / after.scale);
});

test("lifting or cancelling the first finger lets the remaining finger continue smoothly", () => {
  const edit = crop();
  let gesture = beginPhotoGesture(newPhotoGesture(), 1, { x: 100, y: 200 }, edit);
  gesture = beginPhotoGesture(gesture, 2, { x: 300, y: 200 }, edit);
  const pinched = movePhotoGesture(gesture, 2, { x: 340, y: 200 }, view);
  gesture = endPhotoGesture(pinched.gesture, 1, pinched.edit!);
  const unchanged = movePhotoGesture(gesture, 2, { x: 340, y: 200 }, view);
  assert.deepEqual(unchanged.edit, pinched.edit);
  const dragged = movePhotoGesture(unchanged.gesture, 2, { x: 360, y: 200 }, view);
  near(geometry(dragged.edit!).centerX - geometry(pinched.edit!).centerX, 20);
  near(dragged.edit!.zoom, pinched.edit!.zoom);
  gesture = endPhotoGesture(dragged.gesture, 2, dragged.edit!);
  assert.deepEqual(gesture, newPhotoGesture());
  assert.equal(endPhotoGesture(gesture, 2, dragged.edit!), gesture); // duplicate lost capture
});

test("a third finger is ignored until it replaces a departing finger, then rebases", () => {
  const edit = crop();
  let gesture = beginPhotoGesture(newPhotoGesture(), 1, { x: 100, y: 200 }, edit);
  gesture = beginPhotoGesture(gesture, 2, { x: 300, y: 200 }, edit);
  gesture = beginPhotoGesture(gesture, 3, { x: 200, y: 250 }, edit);
  const third = movePhotoGesture(gesture, 3, { x: 230, y: 270 }, view);
  assert.deepEqual(third.edit, edit);
  gesture = endPhotoGesture(third.gesture, 1, edit);
  assert.deepEqual(movePhotoGesture(gesture, 3, { x: 230, y: 270 }, view).edit, edit);
});

test("coincident fingers, unregistered pointers and zoom limits remain finite", () => {
  const edit = crop({ zoom: 4 });
  let gesture = beginPhotoGesture(newPhotoGesture(), 1, { x: 200, y: 200 }, edit);
  gesture = beginPhotoGesture(gesture, 2, { x: 200, y: 200 }, edit);
  const result = movePhotoGesture(gesture, 2, { x: 220, y: 220 }, view);
  assert.equal(result.edit!.zoom, 4);
  assert.ok(Number.isFinite(result.edit!.offset_x) && Number.isFinite(result.edit!.offset_y));
  assert.equal(movePhotoGesture(gesture, 99, { x: 0, y: 0 }, view).edit, null);
  assert.equal(movePhotoGesture(gesture, 1, { x: Infinity, y: 0 }, view).edit, null);
  gesture = beginPhotoGesture(newPhotoGesture(), 1, { x: 100, y: 200 }, crop());
  gesture = beginPhotoGesture(gesture, 2, { x: 300, y: 200 }, crop());
  assert.equal(movePhotoGesture(gesture, 2, { x: 110, y: 200 }, view).edit!.zoom, 1);
  assert.equal(movePhotoGesture(gesture, 2, { x: 700, y: 200 }, view).edit!.zoom, 4);
});

// A tiny pixel canvas exercises exportPhoto's actual transform path without a
// browser dependency. Integer-aligned colored pixels make rotation unambiguous.
type Matrix = [number, number, number, number, number, number];
type PixelSource = { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number; pixels: string[] };
class PixelCanvas {
  private w = 0;
  private h = 0;
  pixels: string[] = [];
  context = new PixelContext(this);
  get width() { return this.w; }
  set width(value: number) { this.w = value; this.reset(); }
  get height() { return this.h; }
  set height(value: number) { this.h = value; this.reset(); }
  reset() { this.pixels = Array(this.w * this.h).fill("transparent"); this.context.matrix = [1, 0, 0, 1, 0, 0]; }
  getContext() { return this.context; }
  rows() { return Array.from({ length: this.height }, (_, y) => this.pixels.slice(y * this.width, (y + 1) * this.width)); }
}
class PixelContext {
  matrix: Matrix = [1, 0, 0, 1, 0, 0];
  stack: Matrix[] = [];
  fillStyle = "white";
  constructor(private canvas: PixelCanvas) {}
  save() { this.stack.push([...this.matrix]); }
  restore() { this.matrix = this.stack.pop()!; }
  multiply([g, h, i, j, k, l]: Matrix) {
    const [a, b, c, d, e, f] = this.matrix;
    this.matrix = [a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j, a * k + c * l + e, b * k + d * l + f];
  }
  translate(x: number, y: number) { this.multiply([1, 0, 0, 1, x, y]); }
  rotate(angle: number) { this.multiply([Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0]); }
  scale(x: number, y: number) { this.multiply([x, 0, 0, y, 0, 0]); }
  fillRect(x: number, y: number, width: number, height: number) {
    for (let row = y; row < y + height; row++) for (let column = x; column < x + width; column++) this.canvas.pixels[row * this.canvas.width + column] = this.fillStyle;
  }
  drawImage(source: PixelSource, x: number, y: number) {
    const width = source.naturalWidth ?? source.width!;
    const height = source.naturalHeight ?? source.height!;
    const [a, b, c, d, e, f] = this.matrix;
    const determinant = a * d - b * c;
    for (let row = 0; row < this.canvas.height; row++) for (let column = 0; column < this.canvas.width; column++) {
      const dx = column + 0.5 - e;
      const dy = row + 0.5 - f;
      const sx = Math.floor((d * dx - c * dy) / determinant - x + 1e-9);
      const sy = Math.floor((-b * dx + a * dy) / determinant - y + 1e-9);
      if (sx >= 0 && sx < width && sy >= 0 && sy < height) this.canvas.pixels[row * this.canvas.width + column] = source.pixels[sy * width + sx];
    }
  }
}

test("landscape and portrait export keep fixed physical dimensions and clockwise hardware pixel order", () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => new PixelCanvas() } });
  try {
    const image = { naturalWidth: 2, naturalHeight: 2, pixels: ["R", "G", "B", "Y"] } as unknown as HTMLImageElement;
    const base = crop({ zoom: 1, fit: "contain" });
    const landscape = exportPhoto(image, 4, 2, base) as unknown as PixelCanvas;
    assert.deepEqual([landscape.width, landscape.height], [4, 2]);
    assert.deepEqual(landscape.rows(), [["white", "R", "G", "white"], ["white", "B", "Y", "white"]]);
    const portrait = exportPhoto(image, 4, 2, { ...base, orientation: "portrait" }) as unknown as PixelCanvas;
    assert.deepEqual([portrait.width, portrait.height], [4, 2]);
    assert.deepEqual(portrait.rows(), [["white", "B", "R", "white"], ["white", "Y", "G", "white"]]);
    const displayed = new PixelCanvas();
    drawPhotoFilter(displayed as unknown as HTMLCanvasElement, portrait as unknown as HTMLImageElement, 4, 2, true);
    assert.deepEqual([displayed.width, displayed.height], [2, 4]);
    assert.deepEqual(displayed.rows(), [["white", "white"], ["R", "G"], ["B", "Y"], ["white", "white"]]);
    const rotated = exportPhoto(image, 4, 2, { ...base, orientation: "portrait", rotation: 90 }) as unknown as PixelCanvas;
    assert.deepEqual(rotated.rows(), [["white", "Y", "B", "white"], ["white", "G", "R", "white"]]);
    assert.equal(base.source_url, original);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
