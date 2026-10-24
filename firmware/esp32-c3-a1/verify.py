"""Execute exact candidate RV32 paths with fault-injected external APIs.
Checks all command data/CS envelopes, payload bytes, error propagation and ABI.
GPIO voltages/timing and physical image quality are deliberately not simulated.
"""
from pathlib import Path
import argparse,hashlib,json,struct,sys
from unicorn import Uc,UC_ARCH_RISCV,UC_MODE_RISCV32,UC_HOOK_CODE
from unicorn.riscv_const import *
from build import parse, require, BASE_SHA256, EXPECTED_SHA256
M = {}
IMAGE = b""
FRAME=bytes((i*29+i//192*7+i//17)&255 for i in range(105984))
STOP=0x40001000
API={'open':0x420b239e,'read':0x420b2506,'close':0x420b1cc2,
 'equals':0x4201ba84,'gpio':0x4201c91c,'level':0x4201c936,'delay':0x4201c972,
 'millis':0x4201c952,'byte':0x42000ff4,'log':0x4201a9a4,
 'invalidate':0x420c73a6,'done':0x420c769c}
SREGS=[UC_RISCV_REG_S0,UC_RISCV_REG_S1,UC_RISCV_REG_S2,UC_RISCV_REG_S3,
       UC_RISCV_REG_S4,UC_RISCV_REG_S5,UC_RISCV_REG_S6,UC_RISCV_REG_S7,
       UC_RISCV_REG_S8,UC_RISCV_REG_S9,UC_RISCV_REG_S10,UC_RISCV_REG_S11]

def run(case):
 u=Uc(UC_ARCH_RISCV,UC_MODE_RISCV32)
 for a,n in [(0x42000000,0x200000),(0x3c000000,0x200000),(0x3fc80000,0x80000),
             (0x40380000,0x20000),(0x50000000,0x2000),(STOP,0x1000)]:u.mem_map(a,n)
 for a,d in parse(IMAGE):
  if a:u.mem_write(a,bytes(d))
 sp=0x3fcef000;u.reg_write(UC_RISCV_REG_SP,sp);u.reg_write(UC_RISCV_REG_GP,0x3fc92000)
 u.reg_write(UC_RISCV_REG_RA,STOP)
 for i,r in enumerate(SREGS):u.reg_write(r,0x789a0000+i*197)
 initial=[u.reg_read(r) for r in SREGS]
 s={'ms':0,'open_count':0,'offset':0,'close_count':0,'cs':1,'dc':0,'until':0,
    'refresh_start':None,'off_start':None,'seen_refresh':False,'off_while_busy':False,'done':0,'failed':0,
    'cs_envelopes':[],'commands':[],'payload':bytearray(),'resets':0,'logs':[]}
 def cstr(a):
  b=bytearray()
  while len(b)<500:
   v=u.mem_read(a+len(b),1)[0]
   if not v:break
   b.append(v)
  return b.decode('utf-8','replace')
 def level():
  t=s['ms'];start=s['refresh_start']
  if case=='initial_busy_stuck':return 0
  if s['off_start'] is not None:
   d=t-s['off_start']
   if case=='late_power_off':return int(not(200<=d<1200))
   if case=='power_off_never_busy':return 1
  if start is not None:
   d=t-start
   if case=='never_busy':return 1
   if case=='late_busy':return int(not(300<=d<20100))
   if case=='false_release':return int(not(0<=d<100 or 300<=d<20300))
   if case=='refresh_stuck':return 0
  return int(t>=s['until'])
 def finish_envelope():
  e=s.pop('envelope',None)
  if not e:return
  s['cs_envelopes'].append({'command':e['command'],'data_count':e['count']})
  c=e['command']
  if c==4:s['until']=s['ms']+(200000 if case=='power_on_stuck' else 100)
  if c==0x12:
   s['refresh_start']=s['ms'];s['seen_refresh']=True;s['until']=s['ms']+16000
  if c==2:
   if not level():s['off_while_busy']=True
   s['refresh_start']=None;s['off_start']=s['ms'];s['until']=s['ms']+(100000 if case=='power_off_stuck' else 30)
 def hook(u,pc,size,_):
  a=[u.reg_read(r) for r in [UC_RISCV_REG_A0,UC_RISCV_REG_A1,UC_RISCV_REG_A2,UC_RISCV_REG_A3]]
  result=0
  if pc==API['open']:
   assert cstr(a[0])=='/littlefs/tmp.raw' and cstr(a[1])=='rb'
   s['open_count']+=1;s['offset']=0;result=0 if case=='open_failure' else 0x3fcb0000
  elif pc==API['read']:
   assert a[1]==1 and a[3]==0x3fcb0000
   data=FRAME
   if case=='truncated':data=FRAME[:-1]
   if case=='oversize':data=FRAME+b'\0'
   n=a[2]
   if case=='transfer_short_read' and s['open_count']==2 and s['offset']==300*192:n=32
   part=data[s['offset']:s['offset']+n]
   if case=='transfer_changed' and s['open_count']==2 and s['offset']==300*192:
    part=bytes([part[0]^1])+part[1:]
   if part:u.mem_write(a[0],part)
   s['offset']+=len(part);result=len(part)
  elif pc==API['close']:
   s['close_count']+=1
   result=0xffffffff if case=='transfer_close_failure' and s['open_count']==2 else 0
  elif pc==API['equals']:result=int(cstr(a[1])=='A1')
  elif pc==API['gpio']:
   pin,val=a[:2]
   assert pin in [1,2,4,7] and val in [0,1]
   if pin==1:s['dc']=val
   if pin==2 and val==0:s['resets']+=1
   if pin==7:
    if s['cs']==1 and val==0:s['envelope']={'command':None,'count':0}
    if s['cs']==0 and val==1:finish_envelope()
    s['cs']=val
  elif pc==API['level']:
   assert a[0]==10;result=level()
  elif pc==API['millis']:result=s['ms']
  elif pc==API['delay']:s['ms']+=a[0]
  elif pc==API['byte']:
   assert s['cs']==0
   e=s['envelope'];v=a[0]&255
   if s['dc']==0:
    assert e['command'] is None and e['count']==0
    e['command']=v;s['commands'].append({'cmd':v,'data':[],'ms':s['ms']})
   elif e['command'] is None:
    assert s['commands'][-1]['cmd']==0x10
    s['payload'].append(v)
   else:s['commands'][-1]['data'].append(v)
   e['count']+=1
  elif pc==API['log']:s['logs'].append([cstr(a[1]),cstr(a[2]) if '%s' in cstr(a[1]) else a[2]])
  elif pc==API['invalidate']:s['failed']+=1
  elif pc==API['done']:s['done']+=1
  else:raise AssertionError(hex(pc))
  u.reg_write(UC_RISCV_REG_A0,result)
  u.reg_write(UC_RISCV_REG_PC,u.reg_read(UC_RISCV_REG_RA))
 for addr in API.values():u.hook_add(UC_HOOK_CODE,hook,begin=addr,end=addr)
 u.emu_start(0x420015cc,STOP,count=80000000)
 assert u.reg_read(UC_RISCV_REG_PC)==STOP,case+' did not return'
 assert u.reg_read(UC_RISCV_REG_SP)==sp and [u.reg_read(r) for r in SREGS]==initial
 assert s['cs']==1 and not s['off_while_busy']
 assert s['close_count']==s['open_count']-(case=='open_failure')
 success=case in ['normal','late_busy','false_release','late_power_off']
 assert s['done']==int(success) and bool(s['failed'])!=success
 if case in ['truncated','oversize','open_failure']:assert not s['commands'] and not s['resets']
 if case.startswith('transfer_'):assert not s['seen_refresh']
 if success:
  expected=[(0xaa,[0x49,0x55,0x20,0x08,0x09,0x18]),(1,[0x3f]),(0,[0x4b,0x69]),
     (5,[0x40,0x1f,0x1f,0x2c]),(8,[0x6f,0x1f,0x1f,0x22]),(6,[0x6f,0x1f,0x14,0x14]),
     (3,[0,0x54,0,0x44]),(0x60,[2,0]),(0x30,[8]),(0x50,[0x3f]),(0x61,[3,0,2,0x58]),
     (0x65,[0x10,0,0x20,0]),(0xe3,[0x2f]),(0x84,[1]),(0x83,[0,0,2,255,0,0,2,87,1]),
     (4,[]),(4,[]),(4,[]),(0x83,[0,0,2,255,0,0,2,39,1]),(0x10,[]),
     (0x83,[0,0,2,255,0,0,2,87,1]),(0x12,[0]),(2,[0]),(7,[0xa5])]
  assert [(c['cmd'],c['data']) for c in s['commands']]==expected
  assert s['resets']==2 and bytes(s['payload'])==FRAME
  envelopes=[e for e in s['cs_envelopes'] if e['command'] is None]
  assert envelopes==[{'command':None,'data_count':105984}]
 drf=next((c['ms'] for c in s['commands'] if c['cmd']==0x12),None)
 off=next((c['ms'] for c in s['commands'] if c['cmd']==2),None)
 sleep=next((c['ms'] for c in s['commands'] if c['cmd']==7),None)
 if case=='late_power_off':assert sleep-off==1300
 if case=='power_off_never_busy':assert sleep is None
 return {'case':case,'returned_with_callee_saved_registers':True,'success_commit':s['done'],
  'cache_invalidated':bool(s['failed']),'refresh_started':s['seen_refresh'],'commands':s['commands'],
  'payload_bytes':len(s['payload']),'payload_sha256':hashlib.sha256(s['payload']).hexdigest(),
  'continuous_data_envelopes':[e for e in s['cs_envelopes'] if e['command'] is None],
  'refresh_to_power_off_model_ms':None if off is None or drf is None else off-drf,
  'power_off_to_sleep_model_ms':None if off is None or sleep is None else sleep-off,
  'power_off_while_busy':s['off_while_busy'],'all_files_closed':True}

def trampoline():
 # Execute non-A1 dispatch from the patched entry through the original prologue.
 u=Uc(UC_ARCH_RISCV,UC_MODE_RISCV32)
 for a,n in [(0x42000000,0x200000),(0x3c000000,0x200000),(0x3fc80000,0x80000),
             (0x40380000,0x20000),(0x50000000,0x2000)]:u.mem_map(a,n)
 for a,d in parse(IMAGE):
  if a:u.mem_write(a,bytes(d))
 def non_a1(u,pc,size,data):
  u.reg_write(UC_RISCV_REG_A0,0)
  u.reg_write(UC_RISCV_REG_PC,u.reg_read(UC_RISCV_REG_RA))
 u.hook_add(UC_HOOK_CODE,non_a1,begin=API['equals'],end=API['equals'])
 sp=0x3fcef000
 u.reg_write(UC_RISCV_REG_SP,sp);u.reg_write(UC_RISCV_REG_RA,STOP)
 for i,r in enumerate(SREGS):u.reg_write(r,0x789a0000+i*197)
 initial=[u.reg_read(r) for r in SREGS]
 u.emu_start(0x420015cc,0x420015d0,count=1000)
 assert u.reg_read(UC_RISCV_REG_PC)==0x420015d0
 assert u.reg_read(UC_RISCV_REG_SP)==sp-112
 assert u.mem_read(sp-8,4)==struct.pack('<I',initial[0])
 assert u.reg_read(UC_RISCV_REG_RA)==STOP
 assert [u.reg_read(r) for r in SREGS]==initial
 return True


def main():
 global M, IMAGE
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--build-dir',required=True,type=Path,help='Output directory from build.py')
 args=parser.parse_args()
 require(not sys.flags.optimize,'Run verifier without -O; behavioral assertions must be enabled')
 directory=args.build_dir.resolve(strict=True)
 M=json.loads((directory/'manifest.json').read_text(encoding='utf-8'))
 IMAGE=(directory/'CANDIDATE.app.bin').read_bytes()
 require(M['base_sha256']==BASE_SHA256,'Unexpected baseline in manifest')
 require(hashlib.sha256(IMAGE).hexdigest()==M['candidate_sha256']==EXPECTED_SHA256,
         'Candidate SHA256 mismatch')
 parse(IMAGE)
 results=[]
 for case in ['normal','late_busy','false_release','never_busy','refresh_stuck','initial_busy_stuck',
              'power_on_stuck','power_off_stuck','late_power_off','power_off_never_busy','truncated','oversize','open_failure',
              'transfer_short_read','transfer_changed','transfer_close_failure']:
  results.append(run(case));print('PASS '+case,flush=True)
 assert trampoline()
 report={'candidate_sha256':M['candidate_sha256'],'case_count':len(results),'cases':results,
  'a0_dispatch_and_trampoline_prologue_verified':True,
  'executed':'Actual built candidate RV32 machine code, including patched entry and original external ABI calls',
  'limits':'File/GPIO/byte HAL/time mocked; timings are models, not measured pins or physical refresh quality'}
 (directory/'VERIFICATION.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
 print('ALL_PASS='+str(len(results))+'; A0_DISPATCH_PASS',flush=True)
 return 0


if __name__=='__main__':
 try:
  sys.exit(main())
 except (AssertionError,OSError,ValueError,KeyError) as error:
  print('VERIFICATION FAILED: '+str(error),file=sys.stderr)
  sys.exit(1)
