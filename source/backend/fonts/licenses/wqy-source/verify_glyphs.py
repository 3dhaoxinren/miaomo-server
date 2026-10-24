"""Verify every Unicode glyph/advance/bounding box against the bundled PCF; requires Pillow."""
from pathlib import Path
import hashlib, json, struct
from PIL import PcfFontFile

ROOT = Path(__file__).resolve().parent
PCF_ROOT = Path(__import__("sys").argv[1])
PAIRS = {"wenquanyi_10pt.bdf": "wqy-song-10.pcf", "wenquanyi_12pt.bdf": "wqy-song-12.pcf", "wenquanyi_13px.bdf": "wqy-zenhei-13.pcf"}

def bdf_glyphs(path):
    result = {}
    active = False
    for line in path.read_text(encoding="latin1").splitlines():
        words = line.split()
        if not words: continue
        key = words[0]
        if key == "STARTCHAR": active = False; rows = []
        elif key == "ENCODING": code = int(words[1])
        elif key == "DWIDTH": advance = tuple(map(int, words[1:3]))
        elif key == "BBX": box = tuple(map(int, words[1:5]))
        elif key == "BITMAP": active = True
        elif key == "ENDCHAR":
            w,h,x,y = box
            bitmap = tuple(tuple((int(row,16) >> (len(row)*4-1-bit)) & 1 for bit in range(w)) for row in rows)
            if code >= 0: result[code] = (advance, box, bitmap)
            active = False
        elif active: rows.append(line.strip())
    return result

def pcf_glyphs(path):
    with path.open("rb") as stream:
        data = path.read_bytes()
        obj = PcfFontFile.PcfFontFile.__new__(PcfFontFile.PcfFontFile)
        obj.fp = stream
        count = struct.unpack_from("<I", data, 4)[0]
        obj.toc = {t:(fmt,size,off) for t,fmt,size,off in (struct.unpack_from("<4I",data,8+i*16) for i in range(count))}
        metrics = obj._load_metrics()
        bitmaps = obj._load_bitmaps(metrics)
        stream,fmt,i16,i32 = obj._getformat(PcfFontFile.PCF_BDF_ENCODINGS)
        firstcol,lastcol,firstrow,lastrow,default = [i16(stream.read(2)) for _ in range(5)]
        result = {}
        for row in range(firstrow,lastrow+1):
            for col in range(firstcol,lastcol+1):
                index = i16(stream.read(2))
                if index == 0xffff: continue
                w,h,left,right,advance,ascent,descent,_ = metrics[index]
                bitmap = tuple(tuple(int(bool(bitmaps[index].getpixel((x,y)))) for x in range(w)) for y in range(h))
                result[row*256+col] = ((advance,0),(w,h,left,-descent),bitmap)
        return result

records = []
for bdf,pcf in PAIRS.items():
    source,compiled = bdf_glyphs(ROOT/bdf),pcf_glyphs(PCF_ROOT/pcf)
    missing = sorted(set(source)^set(compiled))
    different = [code for code in source.keys()&compiled.keys() if source[code] != compiled[code]]
    records.append({"source":bdf,"pcf":pcf,"source_glyphs":len(source),"pcf_glyphs":len(compiled),"source_only_codes":sorted(set(source)-set(compiled)),"pcf_only_codes":sorted(set(compiled)-set(source)),"missing_codes":missing,"different_glyphs":different,"pass":not (set(compiled)-set(source)) and not different})
(ROOT/"glyph-verification.json").write_text(json.dumps(records,indent=2)+"\n",encoding="utf-8")
print(json.dumps([{**r,"missing_codes":len(r["missing_codes"]),"different_glyphs":len(r["different_glyphs"]),"source_only_codes":len(r["source_only_codes"]),"pcf_only_codes":len(r["pcf_only_codes"])} for r in records],indent=2))
assert all(r["pass"] for r in records), "Font source does not reproduce every bundled PCF glyph"
