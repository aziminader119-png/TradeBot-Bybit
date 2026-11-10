#!/usr/bin/env python3
"""Local, interactive owner recovery. Only updates data/auth.json; never connects to the bot or exchange."""
import getpass
import hashlib
import json
import os
from pathlib import Path
import secrets
import sys
import tempfile
import time


def _private_write(directory, prefix, data):
    fd, name = tempfile.mkstemp(dir=directory, prefix=prefix)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        return Path(name)
    except BaseException:
        try:
            os.close(fd)
        except OSError:
            pass
        Path(name).unlink(missing_ok=True)
        raise


def reset_password(auth_file, password):
    auth_file = Path(auth_file)
    if auth_file.is_symlink() or not auth_file.is_file():
        raise ValueError('Existing data/auth.json not found or is a symbolic link; nothing changed.')
    if len(password) < 10:
        raise ValueError('Use at least 10 characters. Nothing changed.')
    previous = auth_file.read_bytes()
    # Match AuthGate.writePassword: the hexadecimal salt STRING is passed to scrypt as UTF-8.
    salt = secrets.token_hex(16)
    record = {'salt': salt, 'hash': hashlib.scrypt(password.encode('utf-8'), salt=salt.encode('utf-8'), n=16384, r=8, p=1, dklen=64).hex(),
              'N': 16384, 'r': 8, 'p': 1, 'createdAt': int(time.time() * 1000)}
    backup = _private_write(auth_file.parent, 'auth.backup-', previous)
    replacement = _private_write(auth_file.parent, '.auth-reset-', json.dumps(record).encode('utf-8'))
    try:
        os.replace(replacement, auth_file)
    finally:
        replacement.unlink(missing_ok=True)
    return backup


def main():
    if not sys.stdin.isatty():
        print('Run this command directly in your SSH terminal. Passwords are not accepted via arguments or pipes.', file=sys.stderr)
        return 1
    auth_file = Path(__file__).resolve().parent.parent / 'data' / 'auth.json'
    if auth_file.is_symlink() or not auth_file.is_file():
        print('Existing data/auth.json was not found. Nothing changed.', file=sys.stderr)
        return 1
    try:
        password = getpass.getpass('New dashboard password (at least 10 characters): ')
        confirmation = getpass.getpass('Repeat new password: ')
        if password != confirmation:
            raise ValueError('Passwords do not match. Nothing changed.')
        backup = reset_password(auth_file, password)
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 1
    except (KeyboardInterrupt, EOFError):
        print('\nCancelled. No new password was installed.', file=sys.stderr)
        return 1
    print('Dashboard password updated. Sign in with your new password.')
    print('Private backup: ' + str(backup))
    print('Bot process, API credentials, security PIN and trading records were not changed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
