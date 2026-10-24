/* Local A1 experiment for the exact 52a4c30d... InkSight application.
 * Register sequence/window/CS contract: Moink 081af81 (epd_drv.c), cross-checked
 * against InkSight A1 adaptation 78ceea65. The existing HAL sends SPI bytes;
 * this is NOT a replacement with Moink's ESP-IDF network/power/OTA firmware.
 * Input is already in panel wire orientation. Moink page+writer both rotate
 * 180 degrees; applying its writer rotation alone to our RAW would be wrong.
 * No writable globals, no large allocation, no credentials/settings changes.
 */
typedef unsigned char u8;
typedef unsigned int u32;
typedef void FILE;
#define FN(t,a) ((t)(a))
#define OPEN FN(FILE *(*)(const char *,const char *),0x420b239e)
#define READ FN(u32 (*)(void *,u32,u32,FILE *),0x420b2506)
#define CLOSE FN(int (*)(FILE *),0x420b1cc2)
#define EQ FN(int (*)(const void *,const char *),0x4201ba84)
#define GPIO FN(void (*)(u8,u8),0x4201c91c)
#define LEVEL FN(int (*)(u8),0x4201c936)
#define DELAY FN(void (*)(u32),0x4201c972)
#define MILLIS FN(u32 (*)(void),0x4201c952)
#define BYTE FN(void (*)(u8),0x42000ff4)
#define LOG FN(int (*)(void *,const char *,...),0x4201a9a4)
#define INVALIDATE FN(void (*)(void),0x420c73a6)
#define DONE FN(int (*)(void *,const char *,u32),0x420c769c)
#define SERIAL ((void *)0x3fc9f51c)
#define RAW "/littlefs/tmp.raw"
#define FRAME_BYTES 105984u
#define ROW_BYTES 192u
#define CS 7
#define DC 1
#define RST 2
#define BUSY 10
extern void original_panel(void);

static void note(const char *s){LOG(SERIAL,"[A1FULL] %s\n",s);}
static u32 crc16(u32 crc,const u8 *p,u32 n){
    while(n--){crc^=(u32)*p++<<8;for(u32 j=0;j<8;j++)crc=((crc<<1)^((crc&0x8000)?0x1021:0))&0xffff;}
    return crc;
}
static void cmd(u8 c,const u8 *p,u32 n){
    GPIO(DC,0);GPIO(CS,0);BYTE(c);
    if(n){GPIO(DC,1);while(n--)BYTE(*p++);}
    GPIO(CS,1);
}
static void one(u8 c,u8 d){cmd(c,&d,1);}
static void window(u32 end){
    u8 p[9]={0,0,2,255,0,0,(u8)(end>>8),(u8)end,1};
    cmd(0x83,p,9);
}
/* Stable ready detects delayed BUSY assertion as well as a busy pin low now. */
static int ready(u32 timeout,u32 stable){
    u32 start=MILLIS(),high=start;int was_high=0;
    for(;;){
        u32 now=MILLIS();
        if(LEVEL(BUSY)){
            if(!was_high){high=now;was_high=1;}
            if(now-high>=stable)return 1;
        }else was_high=0;
        if(now-start>=timeout)return 0;
        DELAY(10);
    }
}
static int reset(u32 timeout){
    GPIO(CS,1);GPIO(4,0);DELAY(20);GPIO(RST,0);DELAY(40);GPIO(RST,1);DELAY(50);
    if(!ready(timeout,50))return 0;
    DELAY(30);return 1;
}
/* command, length, bytes. Entire A1 register profile, not a row-only patch. */
static const u8 INIT[]={
    0xAA,6,0x49,0x55,0x20,0x08,0x09,0x18,
    0x01,1,0x3F, 0x00,2,0x4B,0x69,
    0x05,4,0x40,0x1F,0x1F,0x2C,
    0x08,4,0x6F,0x1F,0x1F,0x22,
    0x06,4,0x6F,0x1F,0x14,0x14,
    0x03,4,0x00,0x54,0x00,0x44,
    0x60,2,0x02,0x00, 0x30,1,0x08, 0x50,1,0x3F,
    0x61,4,0x03,0x00,0x02,0x58,
    0x65,4,0x10,0x00,0x20,0x00,
    0xE3,1,0x2F, 0x84,1,0x01
};
static int init(void){
    if(!reset(10000)||!reset(180000))return 0;
    for(u32 i=0;i<sizeof(INIT);){u8 c=INIT[i++],n=INIT[i++];cmd(c,INIT+i,n);i+=n;}
    window(599);cmd(4,(const u8*)0,0);
    if(!ready(180000,100))return 0;
    /* Keep all three reference power-on commands in this comparison. */
    cmd(4,(const u8*)0,0);if(!ready(45000,100))return 0;
    cmd(4,(const u8*)0,0);return ready(45000,100);
}
static int validate(u32 *checksum){
    FILE *f=OPEN(RAW,"rb");if(!f)return 0;
    u8 row[ROW_BYTES];u32 crc=0xffff;
    for(u32 y=0;y<552;y++){
        if(READ(row,1,ROW_BYTES,f)!=ROW_BYTES){CLOSE(f);return 0;}
        crc=crc16(crc,row,ROW_BYTES);DELAY(1);
    }
    u32 tail=READ(row,1,1,f);int closed=CLOSE(f);
    if(tail||closed)return 0;
    *checksum=crc;return 1;
}
static int transmit(u32 expected){
    FILE *f=OPEN(RAW,"rb");if(!f)return 0;
    u8 row[ROW_BYTES];u32 crc=0xffff;int ok=1;
    window(551);cmd(0x10,(const u8*)0,0);
    GPIO(DC,1);GPIO(CS,0);
    for(u32 y=0;y<552;y++){
        if(READ(row,1,ROW_BYTES,f)!=ROW_BYTES){ok=0;break;}
        crc=crc16(crc,row,ROW_BYTES);
        for(u32 x=0;x<ROW_BYTES;x++)BYTE(row[x]);
        DELAY(1); /* yield with CS held; existing byte HAL retains SCK low */
    }
    GPIO(CS,1);
    u32 tail=READ(row,1,1,f);int closed=CLOSE(f);
    return ok&&!tail&&!closed&&crc==expected;
}
static int refresh(void){
    window(599);one(0x12,0);
    u32 start=MILLIS(),high=start;int was_high=0,seen_busy=0;
    /* 14 seconds is a minimum guard, NOT a reason to ignore BUSY afterward.
     * At least one sampled LOW and 500 ms stable HIGH are required to commit.
     * This intentionally fixes the reference's late-BUSY/14s early-off hole. */
    for(;;){
        u32 now=MILLIS();
        if(LEVEL(BUSY)){
            if(!was_high){high=now;was_high=1;}
            if(now-start>=14000 && now-high>=500){
                LOG(SERIAL,"[A1FULL] refresh wait %ums, BUSY observed=%u\n",now-start,(u32)seen_busy);
                return seen_busy;
            }
        }else{seen_busy=1;was_high=0;}
        if(now-start>=180000){note("refresh BUSY timeout; no success committed");return 0;}
        DELAY(10);
    }
}
static int finish(void){
    one(2,0);
    u32 start=MILLIS(),high=start;int seen_busy=0,was_high=0;
    for(;;){
        u32 now=MILLIS();
        if(LEVEL(BUSY)){
            if(!was_high){high=now;was_high=1;}
            if(seen_busy&&now-high>=100)break;
        }else{seen_busy=1;was_high=0;}
        if((!seen_busy&&now-start>=1000)||now-start>=45000){
            note("power-off BUSY completion unconfirmed; no sleep or success commit");return 0;
        }
        DELAY(10);
    }
    LOG(SERIAL,"[A1FULL] power-off wait %ums, BUSY observed=1\n",MILLIS()-start);
    one(7,0xA5);DELAY(200);return 1;
}
__attribute__((used,noinline)) void a1_panel(void){
    if(!(EQ((void*)0x3fc9f324,"A1")||EQ((void*)0x3fc9f324,"a1"))){original_panel();return;}
    u32 start=MILLIS(),crc;
    note("v2 complete A1 profile; RST=2; raw=768x552; scan=768x600; existing byte HAL");
    if(!validate(&crc)){INVALIDATE();note("invalid/truncated raw; panel not touched");return;}
    int ok=init();
    if(ok){note("init complete; sending one continuous-CS 105984-byte frame");ok=transmit(crc);}
    if(ok){note("frame verified; starting refresh");ok=refresh();}
    if(ok){ok=finish();}
    if(!ok){
        GPIO(CS,1);INVALIDATE();note("FAILED; next request will retry");
        /* Never issue power-off while BUSY is asserted. */
        if(ready(1000,100))finish();
        return;
    }
    DONE(SERIAL,"[A1FULL] all done %ums\n",MILLIS()-start);
}
