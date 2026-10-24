"""Extract app0 from your own four-MiB backup without overwriting files."""
import argparse
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backup', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if not args.backup.is_file() or args.backup.stat().st_size != 0x400000:
        raise ValueError('Expected a regular four-MiB backup file')
    if args.backup.resolve() == args.output.resolve():
        raise ValueError('Output must differ from input')
    data = args.backup.read_bytes()
    if len(data) != 0x400000:
        raise ValueError('Backup size changed while reading')
    with args.output.open('xb') as stream:
        stream.write(data[0x10000:0x1f0000])
    print('Extracted app0: 1966080 bytes. Use only with the original device/layout.')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError) as error:
        print('FAILED: ' + str(error), file=sys.stderr)
        sys.exit(1)

