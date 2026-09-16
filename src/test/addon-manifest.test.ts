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
  it('publishes the web UI on a port, since Ingress does not render', () => {
    // Ingress would put Home Assistant's own login and 2FA in front, but the
    // app cannot render under it without a build-time basePath (known-gaps #4).
    // Whoever flips this back must make the app actually render first.
    expect(configYaml).toMatch(/^ports:/m);
    expect(configYaml).not.toMatch(/^ingress:\s*true/m);
  });

  it('warns in ports_description that nothing authenticates in front', () => {
    // On this port Sampolio's own login is the only gate. That has to be
    // visible where the port is exposed, not only in the docs.
    const desc = configYaml.match(/^ports_description:\n\s+3999\/tcp:\s*(.+)$/m)?.[1] ?? '';
    expect(desc.toLowerCase()).toContain('no home assistant auth');
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

  it('publishes the same port run.sh gives the proxy', () => {
    // A mismatch publishes a port nothing listens on, and leaves the real one
    // reachable or not depending on Docker's defaults rather than on intent.
    const published = configYaml.match(/^ports:\n\s+(\d+)\/tcp:\s*(\d+)/m);
    const runSh = fs.readFileSync(path.join(REPO_ROOT, 'run.sh'), 'utf8');
    const defaultPort = runSh.match(/^PORT="\$\{PORT:-(\d+)\}"/m)?.[1];
    expect(published?.[1]).toBe(defaultPort);
    expect(published?.[2]).toBe(defaultPort);
  });
});

describe('add-on image', () => {
  const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8');

  it('drops the forced-https headers the container cannot satisfy', () => {
    // next start serves plain http here, and HSTS + upgrade-insecure-requests
    // made the browser rewrite every asset request to a nonexistent https
    // listener — a white screen with a clean server log.
    expect(dockerfile).toMatch(/ENV DISABLE_TLS_HEADERS=true/);
  });

  it('never re-enables iframe embedding', () => {
    // Only Ingress needed it. On a published port, dropping X-Frame-Options
    // and frame-ancestors would expose the app to clickjacking from any page.
    expect(dockerfile).not.toMatch(/ENV ALLOW_IFRAME_EMBED=true/);
  });

  it('ships the ingress proxy at the path run.sh execs', () => {
    expect(dockerfile).toMatch(/COPY ha-ingress-proxy\.mjs \/ha-ingress-proxy\.mjs/);
    const runSh = fs.readFileSync(path.join(REPO_ROOT, 'run.sh'), 'utf8');
    expect(runSh).toMatch(/exec node \/ha-ingress-proxy\.mjs/);
  });
});
