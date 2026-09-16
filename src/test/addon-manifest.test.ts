/**
 * Tests for the Home Assistant add-on manifest (config.yaml at the repo root).
 *
 * Supervisor reads this file, not the app: a mistake here is only discovered
 * on a real install, and several of the fields are load-bearing for security
 * rather than convenience. There is no YAML parser in this project's
 * dependencies and the file is deliberately flat, so it is read as text.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const configYaml = fs.readFileSync(path.join(REPO_ROOT, 'config.yaml'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

/** Keys of a top-level block such as `options:` / `schema:` (2-space indent). */
function blockKeys(source: string, blockName: string): string[] {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.trimEnd() === `${blockName}:`);
  expect(start, `${blockName}: block is missing from config.yaml`).toBeGreaterThanOrEqual(0);

  const keys: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) && line.trim() !== '') break; // next top-level key
    const m = line.match(/^ {2}([A-Za-z0-9_]+):/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

describe('add-on manifest', () => {
  it('declares the same version as package.json', () => {
    // Supervisor decides whether an update is available purely from this
    // string; a stale one makes a rebuilt add-on look already up to date.
    const version = configYaml.match(/^version:\s*"?([^"\n]+)"?/m)?.[1];
    expect(version).toBe(pkg.version);
  });

  it('keeps options and schema in lockstep', () => {
    // A key in one but not the other either fails schema validation on save
    // or is silently ignored at startup.
    expect(blockKeys(configYaml, 'options').sort()).toEqual(blockKeys(configYaml, 'schema').sort());
  });

  it('exposes every option run.sh actually reads', () => {
    const runSh = fs.readFileSync(path.join(REPO_ROOT, 'run.sh'), 'utf8');
    const read = [...runSh.matchAll(/get_option ([a-z_]+)/g)].map((m) => m[1]);
    expect(read.length).toBeGreaterThan(0);
    for (const key of read) expect(blockKeys(configYaml, 'options')).toContain(key);
  });

  it('types the optional URL-ish options as str?, not url?', () => {
    // HA's url validator rejects "" even on an optional field, and these
    // default to "" — url? made every options save fail, including saving
    // the required secrets alongside them.
    expect(configYaml).toMatch(/enable_banking_redirect_url:\s*str\?/);
    expect(configYaml).toMatch(/ha_webhook_url:\s*str\?/);
  });

  it('marks every secret-bearing option as a password field', () => {
    for (const key of ['auth_secret', 'encryption_key']) {
      expect(configYaml).toMatch(new RegExp(`${key}:\\s*password\\b`));
    }
    for (const key of ['enable_banking_private_key', 'tailscale_auth_key']) {
      expect(configYaml).toMatch(new RegExp(`${key}:\\s*password\\?`));
    }
  });
});

describe('add-on manifest security posture', () => {
  it('serves through Ingress and publishes no direct port', () => {
    // A direct port is reachable without a Home Assistant session, which
    // bypasses whatever login and 2FA protects HA itself — the entire reason
    // this add-on is Ingress-only.
    expect(configYaml).toMatch(/^ingress:\s*true/m);
    expect(configYaml).not.toMatch(/^ports:/m);
    expect(configYaml).not.toMatch(/^webui:/m);
  });

  it('requests no container privileges or device access', () => {
    // tailscaled runs with --tun=userspace-networking precisely so that
    // NET_ADMIN/NET_RAW and /dev/net/tun are never needed. Granting them
    // would give an app-level compromise raw sockets and interface control
    // on Home Assistant's internal bridge.
    expect(configYaml).not.toMatch(/^privileged:/m);
    expect(configYaml).not.toMatch(/^devices:/m);
    expect(configYaml).not.toMatch(/^host_network:\s*true/m);
  });

  it('keeps the ingress port matching the port run.sh gives the proxy', () => {
    const ingressPort = configYaml.match(/^ingress_port:\s*(\d+)/m)?.[1];
    const runSh = fs.readFileSync(path.join(REPO_ROOT, 'run.sh'), 'utf8');
    const defaultPort = runSh.match(/^PORT="\$\{PORT:-(\d+)\}"/m)?.[1];
    expect(ingressPort).toBe(defaultPort);
  });
});

describe('add-on image', () => {
  const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8');

  it('sets the header gates the containerised deployment needs', () => {
    // DISABLE_TLS_HEADERS: next start serves plain http here, and HSTS +
    // upgrade-insecure-requests made the browser rewrite every asset request
    // to a nonexistent https listener — a white screen with a clean server log.
    // ALLOW_IFRAME_EMBED: Ingress renders the add-on in an iframe.
    expect(dockerfile).toMatch(/ENV DISABLE_TLS_HEADERS=true/);
    expect(dockerfile).toMatch(/ENV ALLOW_IFRAME_EMBED=true/);
  });

  it('ships the ingress proxy at the path run.sh execs', () => {
    expect(dockerfile).toMatch(/COPY ha-ingress-proxy\.mjs \/ha-ingress-proxy\.mjs/);
    const runSh = fs.readFileSync(path.join(REPO_ROOT, 'run.sh'), 'utf8');
    expect(runSh).toMatch(/exec node \/ha-ingress-proxy\.mjs/);
  });
});
