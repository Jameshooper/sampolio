/**
 * Tests for run.sh (the add-on container entrypoint at the repo root).
 *
 * run.sh is the only thing standing between Home Assistant's options.json and
 * the app's environment: it decides whether the app starts at all, where the
 * Enable Banking private key lands, whether Tailscale joins the tailnet, and
 * on which interface Next.js listens. None of that is exercised by the app's
 * own tests, and a mistake in it is only discovered on a real Home Assistant
 * install — so it is tested here by running the real script with stubs on
 * PATH in place of node's long-running children, tailscale, and tailscaled.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

// Each case spawns a real shell plus a couple of short-lived node processes;
// the default 5s budget is tight on a cold machine.
vi.setConfig({ testTimeout: 20_000 });

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '../..');
const RUN_SH = path.join(REPO_ROOT, 'run.sh');

let stubDir: string;
const tmpDirs: string[] = [];

/**
 * A PATH shadow for the three commands run.sh shells out to.
 *
 * `node` has to stay real: run.sh uses it for get_option (parsing
 * options.json) and for the upstream-port wait. Only the two long-running
 * children are intercepted — otherwise the test would boot a real Next.js
 * server and never return. Each stub appends its argv to $STUB_LOG so a test
 * can assert on exactly how it was invoked.
 */
beforeAll(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sampolio-stubs-'));
  tmpDirs.push(stubDir);

  fs.writeFileSync(
    path.join(stubDir, 'node'),
    `#!/bin/sh
case "$*" in
  *ha-ingress-proxy*)
    echo "node $*" >> "$STUB_LOG"
    exit 0
    ;;
  *next*start*)
    echo "node $*" >> "$STUB_LOG"
    # run.sh waits for the upstream port before exec'ing the proxy, so the
    # stub has to actually hold that port open or the wait burns 30s and the
    # script exits non-zero. Self-terminates so nothing outlives the test.
    port=""; prev=""
    for a in "$@"; do
      [ "$prev" = "-p" ] && port="$a"
      prev="$a"
    done
    # stdio must be detached: a backgrounded grandchild holding the inherited
    # pipes open keeps the parent execFile() from ever resolving.
    ${process.execPath} -e 'const s=require("net").createServer();s.listen(+process.argv[1],"127.0.0.1");setTimeout(()=>process.exit(0),10000)' "$port" >/dev/null 2>&1 </dev/null &
    exit 0
    ;;
esac
exec ${process.execPath} "$@"
`,
    { mode: 0o755 }
  );

  fs.writeFileSync(
    path.join(stubDir, 'tailscaled'),
    `#!/bin/sh
echo "tailscaled $*" >> "$STUB_LOG"
# run.sh waits for a real unix SOCKET ([ -S ]), so touching a regular file
# here would not satisfy it — bind an actual socket at the requested path.
sock=""
for a in "$@"; do
  case "$a" in --socket=*) sock="\${a#--socket=}" ;; esac
done
${process.execPath} -e 'const s=require("net").createServer();s.listen(process.argv[1]);setTimeout(()=>process.exit(0),10000)' "$sock" >/dev/null 2>&1 </dev/null &
exit 0
`,
    { mode: 0o755 }
  );

  fs.writeFileSync(
    path.join(stubDir, 'tailscale'),
    `#!/bin/sh
echo "tailscale $*" >> "$STUB_LOG"
exit 0
`,
    { mode: 0o755 }
  );
});

afterEach(() => {
  // Keep stubDir; only per-test scratch dirs are disposable.
  while (tmpDirs.length > 1) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  stubLog: string;
  dataDir: string;
}

/** Run run.sh with a fixture options.json and/or env, and capture what it did. */
async function runEntrypoint(
  options: Record<string, unknown> | null,
  env: Record<string, string> = {}
): Promise<RunResult> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sampolio-run-'));
  tmpDirs.push(scratch);

  const optionsFile = path.join(scratch, 'options.json');
  if (options) fs.writeFileSync(optionsFile, JSON.stringify(options));
  const stubLog = path.join(scratch, 'stub.log');
  const dataDir = path.join(scratch, 'data');

  try {
    const { stdout, stderr } = await execFileAsync('sh', [RUN_SH], {
      cwd: REPO_ROOT,
      env: {
        // A deliberately minimal environment, not a copy of process.env: the
        // "missing required secret" cases only mean anything if the
        // developer's own AUTH_SECRET/ENCRYPTION_KEY cannot leak in.
        NODE_ENV: 'test',
        PATH: `${stubDir}:${process.env.PATH}`,
        OPTIONS_FILE: optionsFile,
        DATA_DIR: dataDir,
        STUB_LOG: stubLog,
        TAILSCALE_STATE_DIR: path.join(scratch, 'ts'),
        TAILSCALE_SOCKET: path.join(scratch, 'ts.sock'),
        ...env,
      },
    });
    return {
      code: 0,
      stdout,
      stderr,
      stubLog: fs.existsSync(stubLog) ? fs.readFileSync(stubLog, 'utf8') : '',
      dataDir,
    };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: e.code ?? 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      stubLog: fs.existsSync(stubLog) ? fs.readFileSync(stubLog, 'utf8') : '',
      dataDir,
    };
  }
}

const REQUIRED = {
  auth_secret: 'test-auth-secret',
  encryption_key: 'test-encryption-key',
  auth_url: 'http://192.0.2.10:3999',
};

describe('run.sh required configuration', () => {
  it('refuses to start, with a pointer to the Configuration tab, when secrets are missing', async () => {
    // Starting without AUTH_SECRET/ENCRYPTION_KEY would either crash obscurely
    // later or come up with a default-derived key — the failure has to be
    // loud and at startup.
    const res = await runEntrypoint({ auth_secret: '', encryption_key: '', auth_url: '' });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('required');
    expect(res.stderr).toContain('Configuration tab');
    expect(res.stubLog).toBe('');
  });

  it.each(['auth_secret', 'encryption_key', 'auth_url'] as const)(
    'refuses to start when only %s is missing',
    async (missing) => {
      const opts: Record<string, string> = { ...REQUIRED };
      opts[missing] = '';
      const res = await runEntrypoint(opts);
      expect(res.code).toBe(1);
    }
  );

  it('starts when all three are present', async () => {
    const res = await runEntrypoint(REQUIRED);
    expect(res.code).toBe(0);
    expect(res.stubLog).toContain('next');
    expect(res.stubLog).toContain('ha-ingress-proxy.mjs');
  });

  it('accepts plain env vars when no options.json exists (bare docker run)', async () => {
    const res = await runEntrypoint(null, {
      AUTH_SECRET: 's',
      ENCRYPTION_KEY: 'k',
      AUTH_URL: 'http://192.0.2.10:3999',
    });
    expect(res.code).toBe(0);
  });

  it('lets an explicit env var win over the options.json value', async () => {
    const res = await runEntrypoint({ ...REQUIRED, auth_url: 'http://from-options' }, {
      AUTH_URL: 'http://from-env',
    });
    expect(res.code).toBe(0);
  });
});

describe('run.sh process topology', () => {
  it('binds Next.js to loopback on the internal port, never the published one', async () => {
    // If Next.js bound 0.0.0.0:3999 it would serve an unrewritten, unproxied
    // copy of the app to every other container on the add-on network,
    // bypassing Ingress entirely.
    const res = await runEntrypoint(REQUIRED);
    expect(res.stubLog).toMatch(/next start -p 3998 -H 127\.0\.0\.1/);
    expect(res.stubLog).not.toContain('-H 0.0.0.0');
  });

  it('hands the published port to the ingress proxy', async () => {
    const res = await runEntrypoint(REQUIRED);
    expect(res.stubLog).toContain('/ha-ingress-proxy.mjs');
  });
});

describe('run.sh Enable Banking key handling', () => {
  /** Write a real RSA PKCS#8 PEM to a scratch path, as /ssl would hold it. */
  function writeKey(): { path: string; pem: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sampolio-ssl-'));
    tmpDirs.push(dir);
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const keyPath = path.join(dir, 'sampolio-enable-banking.pem');
    fs.writeFileSync(keyPath, pem, { mode: 0o600 });
    return { path: keyPath, pem };
  }

  it('points the app at the key in place, without copying it', async () => {
    // Copying it into the data directory would put a bank credential into
    // every Home Assistant backup.
    const key = writeKey();
    const res = await runEntrypoint({
      ...REQUIRED,
      enable_banking_app_id: 'app-id',
      enable_banking_redirect_url: 'https://example.com/api/bank/callback',
      enable_banking_private_key_file: key.path,
    });
    expect(res.code).toBe(0);
    expect(fs.existsSync(path.join(res.dataDir, 'enable_banking_private_key.pem'))).toBe(false);
    // Still loadable where it is, which is all the app needs.
    expect(createPrivateKey(fs.readFileSync(key.path, 'utf8')).asymmetricKeyType).toBe('rsa');
  });

  it('starts anyway, loudly, when the key path does not exist', async () => {
    // Bank sync hard-disables itself without a key; the rest of the app
    // should not be held hostage to a typo in a path.
    const res = await runEntrypoint({
      ...REQUIRED,
      enable_banking_app_id: 'app-id',
      enable_banking_redirect_url: 'https://example.com/api/bank/callback',
      enable_banking_private_key_file: '/ssl/not-here.pem',
    });
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('no such file');
    expect(res.stubLog).toContain('ha-ingress-proxy.mjs');
  });

  it('never writes a key file of its own', async () => {
    const res = await runEntrypoint(REQUIRED);
    expect(fs.existsSync(path.join(res.dataDir, 'enable_banking_private_key.pem'))).toBe(false);
  });

  it('tells the user to rotate a key left in the old inline option', async () => {
    // It sat in options.json in plain text, so removing it is not enough.
    const res = await runEntrypoint({ ...REQUIRED }, { ENABLE_BANKING_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----' });
    expect(res.stderr).toContain('no longer used');
    expect(res.stderr).toContain('treat it as exposed');
  });

  it('deletes a key an earlier version had copied into the data directory', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sampolio-oldkey-'));
    tmpDirs.push(scratch);
    const dataDir = path.join(scratch, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const stale = path.join(dataDir, 'enable_banking_private_key.pem');
    fs.writeFileSync(stale, '-----BEGIN PRIVATE KEY-----\nstale\n-----END PRIVATE KEY-----\n');

    const res = await runEntrypoint(REQUIRED, { DATA_DIR: dataDir });
    expect(res.code).toBe(0);
    expect(fs.existsSync(stale)).toBe(false);
    expect(res.stderr).toContain('removed the private key');
  });
});

describe('run.sh recovery switches', () => {
  it('does nothing to the data directory by default', async () => {
    const res = await runEntrypoint(REQUIRED);
    expect(res.code).toBe(0);
    expect(res.stderr).not.toContain('DELETING');
  });

  it('wipes the data directory once when wipe_data is on', async () => {
    const res = await runEntrypoint({ ...REQUIRED, wipe_data: true });
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('DELETING ALL APP DATA');
    // The marker lives beside the data dir, not inside it — the wipe removes
    // the tree, so a marker kept within it could never survive to stop a
    // second wipe.
    expect(fs.existsSync(path.join(path.dirname(res.dataDir), '.sampolio-wipe-done'))).toBe(true);
  });

  it('actually removes existing data, and leaves the directory usable', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sampolio-wipe-'));
    tmpDirs.push(scratch);
    const dataDir = path.join(scratch, 'data');
    fs.mkdirSync(path.join(dataDir, 'users', 'u1'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'users', 'u1', 'user.enc'), 'ciphertext');

    const res = await runEntrypoint({ ...REQUIRED, wipe_data: true }, { DATA_DIR: dataDir });
    expect(res.code).toBe(0);
    expect(fs.existsSync(path.join(dataDir, 'users'))).toBe(false);
    expect(fs.existsSync(dataDir)).toBe(true);
  });

  it('refuses to wipe twice while the switch is left on', async () => {
    // The whole point of the marker: a switch left on must not destroy the
    // data again on the next restart.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sampolio-wipe2-'));
    tmpDirs.push(scratch);
    const dataDir = path.join(scratch, 'data');

    const first = await runEntrypoint({ ...REQUIRED, wipe_data: true }, { DATA_DIR: dataDir });
    expect(first.stderr).toContain('DELETING ALL APP DATA');

    fs.mkdirSync(path.join(dataDir, 'users'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'users', 'keep.enc'), 'precious');

    const second = await runEntrypoint({ ...REQUIRED, wipe_data: true }, { DATA_DIR: dataDir });
    expect(second.stderr).not.toContain('DELETING ALL APP DATA');
    expect(second.stderr).toContain('already been performed');
    expect(fs.existsSync(path.join(dataDir, 'users', 'keep.enc'))).toBe(true);
  });

  it('re-arms the wipe once the switch is turned off', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sampolio-wipe3-'));
    tmpDirs.push(scratch);
    const dataDir = path.join(scratch, 'data');

    await runEntrypoint({ ...REQUIRED, wipe_data: true }, { DATA_DIR: dataDir });
    await runEntrypoint({ ...REQUIRED, wipe_data: false }, { DATA_DIR: dataDir });
    expect(fs.existsSync(path.join(scratch, '.sampolio-wipe-done'))).toBe(false);

    const again = await runEntrypoint({ ...REQUIRED, wipe_data: true }, { DATA_DIR: dataDir });
    expect(again.stderr).toContain('DELETING ALL APP DATA');
  });

  it('passes the password-reset request to the app, not the shell', async () => {
    // Hashing and encryption live in the app; run.sh only relays the request.
    const on = await runEntrypoint({ ...REQUIRED, reset_admin_password: true });
    expect(on.stubLog).toContain('ha-ingress-proxy.mjs');
    expect(on.code).toBe(0);
  });
});

describe('run.sh embedded Tailscale', () => {
  it('does not touch Tailscale when no auth key is set', async () => {
    const res = await runEntrypoint(REQUIRED);
    expect(res.stubLog).not.toContain('tailscaled');
    expect(res.stubLog).not.toMatch(/^tailscale /m);
  });

  it('runs tailscaled in userspace networking, never TUN mode', async () => {
    // TUN mode gives the container a tailnet IP and exposes EVERY bound port
    // to the whole tailnet with no Home Assistant login in front — it would
    // silently reopen the bypass `ingress: true` exists to close.
    const res = await runEntrypoint({ ...REQUIRED, tailscale_auth_key: 'tskey-auth-test' });
    expect(res.stubLog).toContain('--tun=userspace-networking');
    expect(res.stubLog).toContain('--hostname=sampolio-callback');
  });

  it('does not publish anything unless the funnel option is on', async () => {
    const res = await runEntrypoint({ ...REQUIRED, tailscale_auth_key: 'tskey-auth-test' });
    expect(res.stubLog).not.toContain('--set-path');
    expect(res.stubLog).not.toContain('443 on');
  });

  it('actively tears Funnel down when the option is off', async () => {
    // Skipping the enable is not enough: `serve --bg` and `funnel` persist in
    // tailscaled's state file, and that state deliberately survives restarts.
    // Without an explicit teardown, turning the option off would leave the
    // callback published to the public internet with no sign of it.
    const res = await runEntrypoint({ ...REQUIRED, tailscale_auth_key: 'tskey-auth-test' });
    expect(res.stubLog).toContain('funnel 443 off');
    expect(res.stubLog).toContain('serve reset');
  });

  it('makes only the bank callback path public', async () => {
    // Funnel publishes the whole port, so the only thing limiting exposure is
    // that this single path is the one with a backend mapped. A funnel line
    // without --set-path would put the login page on the public internet.
    const res = await runEntrypoint({
      ...REQUIRED,
      tailscale_auth_key: 'tskey-auth-test',
      tailscale_funnel: true,
    });
    const funnelLines = res.stubLog.split('\n').filter((l) => l.includes('funnel'));
    expect(funnelLines.length).toBeGreaterThan(0);
    for (const line of funnelLines) expect(line).toContain('--set-path=/api/bank/callback');
  });

  it('serves the whole app tailnet-only on a second port for the bank flow', async () => {
    // The callback needs a session cookie, and that cookie is host-only — so
    // the app has to be browsable on the SAME hostname the bank redirects to.
    // Different port is fine: cookies ignore the port (RFC 6265 5.1.3).
    const res = await runEntrypoint({
      ...REQUIRED,
      tailscale_auth_key: 'tskey-auth-test',
      tailscale_funnel: true,
    });
    expect(res.stubLog).toMatch(/serve --bg --https=8443/);
    // Whole-app mapping must never be the thing handed to funnel.
    expect(res.stubLog).not.toMatch(/funnel[^\n]*--https=8443/);
  });

  it('treats a non-true funnel value as off, and tears down', async () => {
    const res = await runEntrypoint({
      ...REQUIRED,
      tailscale_auth_key: 'tskey-auth-test',
      tailscale_funnel: false,
    });
    expect(res.stubLog).not.toContain('443 on');
    expect(res.stubLog).toContain('funnel 443 off');
  });
});
