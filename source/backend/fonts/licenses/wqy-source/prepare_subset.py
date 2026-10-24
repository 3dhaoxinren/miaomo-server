"""Recreate editable BDF subsets for exactly the shipped PCF encodings; no glyph edits."""
from pathlib import Path
import re, struct, sys
ROOT=Path(__file__).resolve().parent
PCF_ROOT=Path(sys.argv[1]) if len(sys.argv)>1 else ROOT.parent.parent/"bitmap"
PAIRS={"wenquanyi_10pt.bdf":"wqy-song-10.pcf","wenquanyi_12pt.bdf":"wqy-song-12.pcf","wenquanyi_13px.bdf":"wqy-zenhei-13.pcf"}
out=ROOT/"subsets";out.mkdir(exist_ok=True)
for bdf,pcf in PAIRS.items():
 data=(PCF_ROOT/pcf).read_bytes()
 for i in range(struct.unpack_from("<I",data,4)[0]):
  typ,fmt,size,offset=struct.unpack_from("<4I",data,8+16*i)
  if typ==32:break
 else:raise ValueError("missing PCF encoding table")
 endian=">" if fmt&4 else "<"
 firstcol,lastcol,firstrow,lastrow,default=struct.unpack_from(endian+"5H",data,offset+4)
 cursor=offset+14;codes=set()
 for row in range(firstrow,lastrow+1):
  for col in range(firstcol,lastcol+1):
   index=struct.unpack_from(endian+"H",data,cursor)[0];cursor+=2
   if index!=0xffff:codes.add(row*256+col)
 text=(ROOT/bdf).read_bytes().decode("latin1")
 blocks=re.findall(r"^STARTCHAR .*?^ENDCHAR[^\n]*\n?",text,re.M|re.S)
 selected=[block for block in blocks if int(re.search(r"^ENCODING (-?\d+)",block,re.M).group(1)) in codes]
 assert len(selected)==len(codes), (bdf,len(selected),len(codes))
 header=text[:text.index("STARTCHAR ")]
 header=re.sub(r"^CHARS \d+",f"CHARS {len(selected)}",header,flags=re.M)
 (out/bdf).write_bytes((header+"".join(selected)+"ENDFONT\n").encode("latin1"))
 print(bdf,len(selected),"glyphs")
