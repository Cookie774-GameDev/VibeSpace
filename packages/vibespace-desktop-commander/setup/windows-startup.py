"""Read or change only this connector's existing per-user Windows Run value."""
import re
import sys
import winreg

KEY = r'Software\Microsoft\Windows\CurrentVersion\Run'

def value(name):
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, KEY, 0, winreg.KEY_QUERY_VALUE) as key:
            data, kind = winreg.QueryValueEx(key, name)
            if kind != winreg.REG_SZ:
                raise ValueError('Unexpected startup type')
            return data
    except FileNotFoundError:
        return None

if __name__ == '__main__':
    try:
        if len(sys.argv) != 4:
            raise ValueError('Arguments required')
        name, launch, mode = sys.argv[1:]
        if not re.fullmatch(r'VibeSpaceDesktopLink-[0-9a-f]{16}', name):
            raise ValueError('Invalid startup identity')
        if mode not in ('get', 'on', 'off') or not launch.startswith('wscript.exe //B //Nologo '):
            raise ValueError('Invalid startup action')
        if mode == 'on':
            with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, KEY, 0, winreg.KEY_SET_VALUE) as key:
                winreg.SetValueEx(key, name, 0, winreg.REG_SZ, launch)
        elif mode == 'off' and value(name) is not None:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, KEY, 0, winreg.KEY_SET_VALUE) as key:
                winreg.DeleteValue(key, name)
        saved = value(name)
        if (mode == 'off' and saved is not None) or (saved is not None and saved != launch):
            raise ValueError('Startup readback mismatch')
        sys.stdout.write('true' if saved == launch else 'false')
    except Exception:
        sys.stderr.write('STARTUP_REGISTRATION_UNAVAILABLE\n')
        sys.exit(1)
