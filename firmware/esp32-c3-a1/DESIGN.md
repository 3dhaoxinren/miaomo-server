# A1 shim build boundary

The trusted inputs are this module's reviewed source and the user's locally installed RISC-V compiler. The app image is accepted only when its SHA256 equals the documented baseline. Output must additionally equal the accepted candidate SHA256. Neither hash is a signature or a general firmware trust mechanism.

`a1_adapter.c` and `trampoline.S` preserve the physically accepted implementation byte-for-byte. Absolute ABI addresses, existing software SPI HAL, register sequence, CS envelopes, windows and timing belong to that baseline only. The trampoline replays the overwritten prologue for non-A1 panels. No mutable global storage is added. Existing loaded app bytes are retained except for the four-byte entry jump; the original unused alignment segment accommodates the appended constants.

`build.py` parses and validates before invoking external tools. It uses argument arrays without a shell, builds in an owned temporary directory, verifies all preservation and hash checks, then renames the result into a new output directory. It does not write the base image, connect to a network, touch a device, or perform repository operations. Output paths cannot replace existing files/directories; output parents must already exist. Callers should use a directory they control, without another process concurrently replacing its parent paths.

`verify.py` runs actual candidate RV32 code against modeled external APIs, checks success and failure paths, and rejects optimized Python mode so assertions stay enabled. `test_build.py` uses synthetic images and temporary files to verify fail-closed parsing and output handling without distributing a baseline. CRC16 guards the observed two-pass local file transfer; it is not collision-resistant security, atomic file locking, or network authentication.

The publication boundary is source files, this documentation and sanitized verification counts. Generated firmware, compiler outputs, private device state and full test logs are excluded. The user supplies the exact baseline. Image preservation does not establish that an external flashing procedure preserves other flash regions.
