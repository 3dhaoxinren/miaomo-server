"""Negative tests use synthetic images, never a bundled firmware image."""
from pathlib import Path
import hashlib
import struct
import tempfile
import unittest
from unittest.mock import patch

import build


def image(address=0x42000020):
    header = bytearray(24)
    header[0], header[1], header[12], header[23] = 0xe9, 1, 5, 1
    content = bytes.fromhex('01020304')
    body = header + struct.pack('<II', address, len(content)) + content
    while len(body) % 16 != 15:
        body.append(0)
    body.append(0xef ^ 1 ^ 2 ^ 3 ^ 4)
    return body + hashlib.sha256(body).digest()


class ImageValidationTests(unittest.TestCase):
    def test_valid_synthetic_image(self):
        self.assertEqual(build.parse(image()), [(0x42000020, bytearray([1, 2, 3, 4]))])

    def test_corrupt_checksum_rejected_even_with_valid_digest(self):
        data = image()
        data[-33] ^= 1
        data[-32:] = hashlib.sha256(data[:-32]).digest()
        with self.assertRaisesRegex(ValueError, 'checksum'):
            build.parse(data)

    def test_corrupt_sha_rejected(self):
        data = image()
        data[-1] ^= 1
        with self.assertRaisesRegex(ValueError, 'SHA256'):
            build.parse(data)

    def test_mmapped_file_offset_must_match_address(self):
        with self.assertRaisesRegex(ValueError, 'MMU'):
            build.parse(image(0x42000024))

    def test_truncated_and_extra_data_rejected(self):
        for data in (b'', image()[:26], image()[:-1], image() + b'\x00'):
            with self.subTest(length=len(data)), self.assertRaises(ValueError):
                build.parse(data)

    def test_wrong_chip_rejected(self):
        data = image()
        data[12] = 0
        with self.assertRaisesRegex(ValueError, 'ESP32-C3'):
            build.parse(data)

    def test_wrong_base_fails_before_compiler_or_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            baseline, output = root / 'base.bin', root / 'new-build'
            baseline.write_bytes(image())
            with patch('build.resolve_tools') as compiler:
                with self.assertRaisesRegex(ValueError, 'Wrong baseline'):
                    build.build(baseline, None, output)
                compiler.assert_not_called()
            self.assertFalse(output.exists())
            self.assertEqual(baseline.read_bytes(), image())

    def test_failed_compiler_does_not_publish_partial_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            baseline, output = root / 'base.bin', root / 'new-build'
            baseline.write_bytes(image())
            segments = [(0x3c0d0020, bytearray(4)), (build.TEXT_ADDRESS, bytearray(4))]
            with patch('build.validate_base', return_value=segments), \
                    patch('build.resolve_tools', return_value={}), \
                    patch('build.compile_payload', side_effect=RuntimeError('compiler failure')):
                with self.assertRaisesRegex(RuntimeError, 'compiler failure'):
                    build.build(baseline, None, output)
            self.assertFalse(output.exists())
            self.assertEqual(list(root.iterdir()), [baseline])
            self.assertEqual(baseline.read_bytes(), image())

    def test_existing_output_and_base_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            baseline = root / 'base.bin'
            baseline.write_bytes(image())
            for output in (baseline, root, root / 'sub' / '..'):
                with self.subTest(output=output), self.assertRaises(ValueError):
                    build.validate_output(baseline, output)
            self.assertEqual(baseline.read_bytes(), image())

    def test_source_directory_rejected(self):
        with self.assertRaises(ValueError):
            build.validate_output(Path(__file__), build.ROOT)

    def test_missing_parent_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            baseline = root / 'base.bin'
            baseline.write_bytes(image())
            with self.assertRaisesRegex(ValueError, 'parent'):
                build.validate_output(baseline, root / 'missing' / 'build')

    def test_wrong_hook_rejected(self):
        text = bytearray(build.HOOK_ADDRESS - build.TEXT_ADDRESS + 4)
        segments = [(0x3c0d0020, bytearray()), (0, bytearray()),
                    (build.TEXT_ADDRESS, text), (1, bytearray()), (2, bytearray()),
                    (3, bytearray()), (4, bytearray())]
        with self.assertRaisesRegex(ValueError, 'four-byte hook'):
            build.validate_patch_site(segments)

    def test_unreachable_and_unaligned_hook_rejected(self):
        for target in (0x100001, 0x100000, -0x100002, 1):
            with self.subTest(target=target), self.assertRaises(ValueError):
                build.jal(0, target)


if __name__ == '__main__':
    unittest.main()
