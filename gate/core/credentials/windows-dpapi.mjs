import { spawn } from 'node:child_process';

const CRYPTPROTECT_UI_FORBIDDEN = 0x1;

const HELPER = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class VersutusDpapi {
  [StructLayout(LayoutKind.Sequential)]
  public struct DATA_BLOB {
    public int cbData;
    public IntPtr pbData;
  }
  [DllImport("crypt32.dll", SetLastError=true)]
  static extern bool CryptProtectData(ref DATA_BLOB pDataIn, string szDataDescr, IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DATA_BLOB pDataOut);
  [DllImport("crypt32.dll", SetLastError=true)]
  static extern bool CryptUnprotectData(ref DATA_BLOB pDataIn, IntPtr ppszDataDescr, IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DATA_BLOB pDataOut);
  [DllImport("kernel32.dll")]
  static extern IntPtr LocalFree(IntPtr hMem);
  public static byte[] Protect(byte[] input) {
    return Transform(input, true);
  }
  public static byte[] Unprotect(byte[] input) {
    return Transform(input, false);
  }
  static byte[] Transform(byte[] input, bool protect) {
    var pin = new DATA_BLOB();
    var pout = new DATA_BLOB();
    pin.cbData = input.Length;
    pin.pbData = Marshal.AllocHGlobal(input.Length);
    try {
      Marshal.Copy(input, 0, pin.pbData, input.Length);
      bool ok = protect
        ? CryptProtectData(ref pin, "VersutusGate", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, ${CRYPTPROTECT_UI_FORBIDDEN}, ref pout)
        : CryptUnprotectData(ref pin, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, ${CRYPTPROTECT_UI_FORBIDDEN}, ref pout);
      if (!ok) throw new InvalidOperationException("DPAPI failed: " + Marshal.GetLastWin32Error());
      var output = new byte[pout.cbData];
      Marshal.Copy(pout.pbData, output, 0, pout.cbData);
      LocalFree(pout.pbData);
      return output;
    } finally {
      Marshal.FreeHGlobal(pin.pbData);
    }
  }
}
"@
$bytes = [Convert]::FromBase64String($input)
$output = if ($env:VERSUTUS_DPAPI_OP -eq 'protect') { [VersutusDpapi]::Protect($bytes) } else { [VersutusDpapi]::Unprotect($bytes) }
[Console]::Out.Write([Convert]::ToBase64String($output))
`;

function runHelper(op, payload, { timeoutMs, spawnImpl }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', HELPER], {
      env: { ...process.env, VERSUTUS_DPAPI_OP: op },
      windowsHide: true,
    });
    const chunks = [];
    const errors = [];
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => {
      child.kill();
      if (process.platform === 'win32' && child.pid) {
        spawnImpl('taskkill', ['/T', '/F', '/PID', String(child.pid)]).on('error', () => {});
      }
      fail(Object.assign(new Error(`DPAPI ${op} timed out after ${timeoutMs} ms`), { code: 'dpapi_timeout' }));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.on('error', fail);
    child.on('close', (code) => {
      if (code !== 0) {
        const message = `DPAPI ${op} failed: ${Buffer.concat(errors).toString('utf8') || code}`;
        const failureCode = op === 'unprotect' ? 'credential_unreadable' : 'credential_protect_failed';
        fail(Object.assign(new Error(message), { code: failureCode }));
        return;
      }
      succeed(Buffer.from(Buffer.concat(chunks).toString('utf8'), 'base64'));
    });
    child.stdin.end(Buffer.from(payload).toString('base64'));
  });
}

export function createWindowsDpapi({ timeoutMs = 20000, spawnImpl = spawn } = {}) {
  return {
    protect(plain) {
      return runHelper('protect', plain, { timeoutMs, spawnImpl });
    },
    unprotect(cipher) {
      return runHelper('unprotect', cipher, { timeoutMs, spawnImpl });
    },
  };
}
