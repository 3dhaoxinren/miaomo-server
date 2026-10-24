"""Build the exact A1 binary shim from a user-supplied app image; never flash."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent
BASE_SHA256 = '52a4c30da2dc0aec87da317d5a0cd22895535c1dfdbad43c48a8f32584a01af0'
EXPECTED_SHA256 = 'befb5bd8e02547f2ab21f36272e75e9b613e1a6f1c60130c6756bf1529023c10'
TEXT_ADDRESS = 0x42000020
HOOK_ADDRESS = 0x420015cc
HOOK_BEFORE = bytes.fromhex('5971a2d4')
APP_LIMIT = 0x1e0000


def sha(data):
    return hashlib.sha256(data).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def mapped(address):
    return (0x3c000000 <= address < 0x3d000000 or
            0x42000000 <= address < 0x43000000)


def parse(image):
    """Validate ESP32-C3 app framing, XOR checksum, SHA and mapped offsets."""
    require(24 <= len(image) < APP_LIMIT, 'Invalid app image length')
    require(image[0] == 0xe9 and image[23] == 1, 'Expected ESP image with appended SHA256')
    require(struct.unpack_from('<H', image, 12)[0] == 5, 'Expected ESP32-C3 image')
    require(1 <= image[1] <= 16, 'Invalid segment count')
    position, checksum, segments = 24, 0xef, []
    for _ in range(image[1]):
        require(position + 8 <= len(image), 'Truncated segment header')
        address, size = struct.unpack_from('<II', image, position)
        position += 8
        require(size % 4 == 0 and position + size <= len(image), 'Invalid segment size')
        require(address + size <= 0x100000000, 'Segment address overflow')
        if mapped(address):
            require(position % 65536 == address % 65536, 'MMU mapping misaligned')
        if address:
            for previous, data in segments:
                require(not previous or address + size <= previous or
                        previous + len(data) <= address, 'Overlapping loaded segments')
        data = bytearray(image[position:position + size])
        segments.append((address, data))
        position += size
        for byte in data:
            checksum ^= byte
    end = position + 15 - position % 16
    require(end + 33 == len(image), 'Invalid image trailer or extra trailing bytes')
    require(not any(image[position:end]), 'Nonzero image padding')
    require(image[end] == checksum, 'ESP checksum mismatch')
    require(image[end + 1:] == hashlib.sha256(image[:end + 1]).digest(), 'ESP SHA256 mismatch')
    return segments


def validate_base(image):
    require(sha(image) == BASE_SHA256, 'Wrong baseline SHA256; this shim only supports the exact documented app')
    segments = parse(image)
    validate_patch_site(segments)
    return segments


def validate_patch_site(segments):
    require(len(segments) == 7 and segments[0][0] == 0x3c0d0020,
            'Unexpected baseline segment layout')
    require(sum(address == 0 for address, _ in segments) == 1, 'Expected one alignment segment')
    matches = [data for address, data in segments if address == TEXT_ADDRESS]
    require(len(matches) == 1, 'Expected one application text segment')
    offset = HOOK_ADDRESS - TEXT_ADDRESS
    require(matches[0][offset:offset + 4] == HOOK_BEFORE, 'Original four-byte hook does not match')


def jal(pc, target):
    delta = target - pc
    require(delta % 2 == 0 and -(1 << 20) <= delta < (1 << 20), 'Hook jump out of range or unaligned')
    value = delta & 0x1fffff
    return struct.pack('<I', ((value >> 20) & 1) << 31 | ((value >> 1) & 1023) << 21 |
                       ((value >> 11) & 1) << 20 | ((value >> 12) & 255) << 12 | 0x6f)


def validate_output(base, output):
    require(not output.is_symlink(), 'Output may not be a symbolic link')
    base, output = base.resolve(strict=True), output.resolve()
    require(not output.exists(), 'Output must be a new directory; existing output is never overwritten')
    require(output != base and output not in base.parents, 'Output may not contain or replace the input')
    require(output != ROOT and output not in ROOT.parents, 'Output may not replace source directories')
    require(output.parent.is_dir(), 'Output parent directory must already exist')
    return output


def resolve_tools(directory):
    result = {}
    for short in ('gcc', 'ld', 'objcopy', 'nm', 'objdump'):
        name = 'riscv32-esp-elf-' + short
        if directory:
            executable = Path(directory) / (name + ('.exe' if os.name == 'nt' else ''))
            require(executable.is_file(), 'Missing tool: ' + name)
            result[short] = str(executable.resolve())
        else:
            executable = shutil.which(name)
            require(executable is not None, 'Missing tool on PATH: ' + name)
            result[short] = executable
    return result


def execute(tools, directory, name, *arguments):
    process = subprocess.run([tools[name], *map(str, arguments)], cwd=directory,
                             capture_output=True, check=False)
    if process.returncode:
        raise RuntimeError(name + ' failed:\n' + (process.stdout + process.stderr).decode(errors='replace'))
    return process.stdout


def pack(base, segments):
    image, checksum = bytearray(base[:24]), 0xef
    for address, data in segments:
        if address == 0:
            data = bytearray((0x20 - (len(image) + 16)) % 65536)
        if mapped(address):
            require((len(image) + 8) % 65536 == address % 65536, 'Output MMU mapping misaligned')
        image.extend(struct.pack('<II', address, len(data)))
        image.extend(data)
        for byte in data:
            checksum ^= byte
    while len(image) % 16 != 15:
        image.append(0)
    image.append(checksum)
    image.extend(hashlib.sha256(image).digest())
    parse(image)
    return image


def compile_payload(tools, directory, code_address, ro_address):
    script = f'''OUTPUT_ARCH(riscv)
ENTRY(a1_panel)
original_panel_resume = 0x420015d0;
SECTIONS {{
 . = 0x{code_address:x}; .payload : {{ *(.text*) }}
 . = 0x{ro_address:x}; .constants : {{ *(.rodata*) }}
 .bad_data : {{ *(.data*) *(.sdata*) *(.bss*) *(.sbss*) *(COMMON) }}
 /DISCARD/ : {{ *(.comment) *(.riscv.attributes) *(.eh_frame*) }}
}}
ASSERT(SIZEOF(.bad_data)==0,"No mutable globals permitted")
'''
    (directory / 'payload.ld').write_text(script, encoding='utf-8')
    flags = ['-march=rv32imc', '-mabi=ilp32', '-Os', '-ffreestanding', '-fno-builtin',
             '-fno-stack-protector', '-fno-pic', '-msmall-data-limit=0', '-mno-relax',
             '-ffunction-sections', '-fdata-sections', '-Wall', '-Wextra', '-Werror']
    for name in ('a1_adapter.c', 'trampoline.S'):
        execute(tools, directory, 'gcc', *flags, '-c', ROOT / name, '-o', name + '.o')
    execute(tools, directory, 'ld', '-m', 'elf32lriscv', '--no-relax', '-T', 'payload.ld',
            'a1_adapter.c.o', 'trampoline.S.o', '-o', 'payload.elf')
    for section, name in (('.payload', 'payload.bin'), ('.constants', 'constants.bin')):
        execute(tools, directory, 'objcopy', '-O', 'binary', '--only-section=' + section, 'payload.elf', name)
    symbols = {}
    for line in execute(tools, directory, 'nm', '-n', 'payload.elf').decode().splitlines():
        parts = line.split()
        if len(parts) == 3:
            require(parts[1] not in 'bBdDgGsScC', 'Mutable payload symbol found')
            symbols[parts[2]] = int(parts[0], 16)
    require('a1_panel' in symbols and 'original_panel' in symbols, 'Missing entry symbols')
    (directory / 'payload-disassembly.txt').write_bytes(
        execute(tools, directory, 'objdump', '-d', '-M', 'no-aliases', 'payload.elf'))
    return symbols


def build(base_path, toolchain, output):
    base_path = Path(base_path)
    output = validate_output(base_path, Path(output))
    base = base_path.read_bytes()
    segments = validate_base(base)
    tools = resolve_tools(toolchain)
    # The temporary directory is owned by this invocation; input is never copied or modified.
    with tempfile.TemporaryDirectory(prefix='.a1-build-', dir=output.parent) as temporary:
        directory = Path(temporary) / 'result'
        directory.mkdir()
        ro = segments[0]
        text = next(segment for segment in segments if segment[0] == TEXT_ADDRESS)
        code_address = (text[0] + len(text[1]) + 15) & ~15
        ro_address = ro[0] + len(ro[1])
        symbols = compile_payload(tools, directory, code_address, ro_address)
        patch = jal(HOOK_ADDRESS, symbols['a1_panel'])
        offset = HOOK_ADDRESS - TEXT_ADDRESS
        text[1][offset:offset + 4] = patch
        text[1].extend(bytes(code_address - text[0] - len(text[1])))
        text[1].extend((directory / 'payload.bin').read_bytes())
        text[1].extend(bytes(-len(text[1]) % 4))
        ro[1].extend((directory / 'constants.bin').read_bytes())
        ro[1].extend(bytes(-len(ro[1]) % 4))
        candidate = pack(base, segments)
        final = dict(parse(candidate))
        for address, data in parse(base):
            if address == 0:
                continue
            expected = bytearray(data)
            if address == TEXT_ADDRESS:
                expected[offset:offset + 4] = patch
            require(final[address][:len(data)] == expected, 'Existing mapped bytes changed')
            if address not in (ro[0], TEXT_ADDRESS):
                require(final[address] == expected, 'Existing segment length changed')
        require(sha(candidate) == EXPECTED_SHA256,
                'Candidate differs from accepted SHA256; use the documented toolchain and unmodified sources')
        manifest = {'base_sha256': BASE_SHA256, 'candidate_sha256': sha(candidate),
                    'app_length': len(candidate), 'symbols': symbols, 'code_address': code_address,
                    'rodata_address': ro_address, 'hook': {'address': HOOK_ADDRESS,
                    'before': HOOK_BEFORE.hex(), 'after': patch.hex()},
                    'original_mapped_bytes_preserved_except_four_byte_entry': True,
                    'files': {name: sha((ROOT / name).read_bytes())
                              for name in ('a1_adapter.c', 'trampoline.S')}}
        (directory / 'CANDIDATE.app.bin').write_bytes(candidate)
        (directory / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        require(base_path.read_bytes() == base, 'Input changed during build')
        require(not output.exists(), 'Output was created during build; refusing overwrite')
        directory.rename(output)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', required=True, type=Path, help='Exact baseline app image (not a full flash dump)')
    parser.add_argument('--toolchain', type=Path, help='Directory containing riscv32-esp-elf tools; default: PATH')
    parser.add_argument('--output', required=True, type=Path, help='New output directory; parent must exist')
    args = parser.parse_args()
    try:
        manifest = build(args.base, args.toolchain, args.output)
    except (OSError, ValueError, RuntimeError) as error:
        print('BUILD FAILED: ' + str(error), file=sys.stderr)
        return 1
    print(json.dumps({'candidate_sha256': manifest['candidate_sha256'], 'app_bytes': manifest['app_length']}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
