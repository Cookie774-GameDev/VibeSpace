"""Windows CurrentUser DPAPI. Secrets travel only through bounded stdin/stdout pipes."""
import base64
import ctypes
from ctypes import wintypes
import sys

MAX_BYTES = 65536

class Blob(ctypes.Structure):
    _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_ubyte))]

def transform(value: bytes, decrypt: bool) -> bytes:
    if sys.platform != 'win32':
        raise ValueError('Windows required')
    if not value or len(value) > MAX_BYTES:
        raise ValueError('Invalid input')
    data = base64.b64decode(value, validate=True) if decrypt else value
    if not data:
        raise ValueError('Invalid input')
    source = ctypes.create_string_buffer(data)
    incoming = Blob(len(data), ctypes.cast(source, ctypes.POINTER(ctypes.c_ubyte)))
    outgoing = Blob()
    crypt32 = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    function = crypt32.CryptUnprotectData if decrypt else crypt32.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                         ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    try:
        # CRYPTPROTECT_UI_FORBIDDEN, with CurrentUser scope (never LOCAL_MACHINE).
        if not function(ctypes.byref(incoming), None, None, None, None, 1, ctypes.byref(outgoing)):
            raise OSError('DPAPI operation failed')
        if not 0 < outgoing.cbData <= MAX_BYTES:
            raise ValueError('Invalid protected result')
        result = ctypes.string_at(outgoing.pbData, outgoing.cbData)
        return result if decrypt else base64.b64encode(result)
    finally:
        ctypes.memset(source, 0, len(source))
        if outgoing.pbData:
            ctypes.memset(outgoing.pbData, 0, outgoing.cbData)
            kernel32.LocalFree(outgoing.pbData)

if __name__ == '__main__':
    try:
        if len(sys.argv) != 2 or sys.argv[1] not in ('protect', 'unprotect'):
            raise ValueError('Invalid mode')
        value = sys.stdin.buffer.read(MAX_BYTES + 1)
        sys.stdout.buffer.write(transform(value, sys.argv[1] == 'unprotect'))
        sys.stdout.buffer.flush()
    except Exception:
        # Never print the value, operating-system details, or an exception traceback.
        sys.stderr.write('CREDENTIAL_STORAGE_UNAVAILABLE\n')
        sys.exit(1)
