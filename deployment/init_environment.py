"""Create fresh-install environment files without overwriting an existing key."""
import argparse
import base64
from pathlib import Path
import secrets

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--host", required=True, help="LAN IP address or hostname used by your phone")
args = parser.parse_args()
if any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-" for character in args.host) or not args.host:
    parser.error("Use a hostname or IPv4 address")
root = Path(__file__).resolve().parent.parent
environment = root / ".env"
private = root / "deployment/backend.env"
if not environment.exists():
    environment.write_text(f"INKSIGHT_HOST={args.host}\nINKSIGHT_WEB_PORT=3000\nINKSIGHT_BACKEND_PORT=8080\n", encoding="utf-8")
if not private.exists():
    private.write_text("ENCRYPTION_KEY=" + base64.urlsafe_b64encode(secrets.token_bytes(32)).decode() + "\nTZ=Asia/Shanghai\n", encoding="utf-8")
    private.chmod(0o600)
print("Environment files ready; existing values and encryption keys were preserved.")
