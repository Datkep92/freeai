/**
 * The offline shell: what the page needs in order to boot with no network.
 *
 * The app is ES modules, so index.html is not enough to render anything - it
 * pulls in app.js, which pulls in every core file. A service worker that caches
 * only the two shell files serves the HTML from cache and then fails on the
 * first module, and the symptom is a blank page with nothing in the console,
 * which is close to undiagnosable for the person using it.
 *
 * These cases compare the worker's list against the files the app actually
 * imports, so adding a core module without listing it here fails the suite
 * instead of shipping.
 */
import { describe, it, assert, assertEqual } from './harness.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
// `URL.pathname` keeps the percent-encoding and this folder's name is in
// Vietnamese, so a path built from it resolves to nothing on disk.
// fileURLToPath decodes it back into a path the filesystem understands.
const rootDir = fileURLToPath(root);
const read = (rel) => fs.readFileSync(new URL(rel, root), 'utf8');

/** Every module the app imports, in './core/...' form. */
function appModules() {
  const app = read('app.js');
  const direct = [...app.matchAll(/from\s+'\.\/(core\/[^']+)'/g)].map((m) => './' + m[1]);
  return [...new Set(direct)];
}

/** The list inside sw.js. */
function shellList() {
  const sw = read('sw.js');
  const block = sw.slice(sw.indexOf('const SHELL'), sw.indexOf('];', sw.indexOf('const SHELL')));
  return [...block.matchAll(/'\.\/([^']*)'/g)].map((m) => './' + m[1]);
}

/** Every local file the app tree can reach at runtime. */
function projectFiles() {
  const out = [];
  for (const dir of ['core', 'core/adapters']) {
    for (const name of fs.readdirSync(path.join(rootDir, dir))) {
      if (name.endsWith('.js')) out.push('./' + dir + '/' + name);
    }
  }
  return out;
}

export function registerShellCases() {
  describe('SH. The app boots offline', () => {
    it('SH1: every module app.js imports is in the service worker shell', () => {
      const shell = new Set(shellList());
      const missing = appModules().filter((m) => !shell.has(m));
      assertEqual(missing.length, 0, 'not cached, so an offline load fails on it: ' + missing.join(', '));
    });

    it('SH2: the entry point and its stylesheet are cached', () => {
      const shell = new Set(shellList());
      for (const required of ['./', './index.html', './app.js', './styles.css']) {
        assert(shell.has(required), required + ' must be cached or the page cannot open offline');
      }
    });

    it('SH3: every core module is reachable without a second hop', () => {
      // A module that exists but is not in the shell is only noticed when the
      // person is already offline, so it is checked here instead.
      const shell = new Set(shellList());
      const missing = projectFiles().filter((f) => !shell.has(f));
      assertEqual(missing.length, 0, 'core modules missing from the shell: ' + missing.join(', '));
    });

    it('SH4: the shell has no entry that does not exist on disk', () => {
      // A listed file that is not there fails the whole addAll batch in some
      // browsers, which would leave no cache at all.
      //
      // './' is skipped: it is the site root, which the server resolves to
      // index.html, so there is no file of that name on disk to look for.
      for (const entry of shellList()) {
        if (entry === './') continue;
        const file = path.join(rootDir, entry.replace(/^\.\//, ''));
        assert(fs.existsSync(file), entry + ' is listed but missing on disk');
      }
    });

    it('SH5: the cache name changes when the shell changes', () => {
      // Without a bump, activate keeps the old cache and the new worker serves
      // the previous build, so an update never reaches the person.
      const sw = read('sw.js');
      const version = sw.match(/const CACHE = 'fmh-v(\d+)'/);
      assert(version, 'the cache name carries a version');
      assert(Number(version[1]) >= 2, 'the cache was bumped after the module list grew');
    });

    it('SH6: provider API calls are never served from the cache', () => {
      const sw = read('sw.js');
      assert(
        /url\.origin\s*!==\s*self\.location\.origin/.test(sw),
        'cross-origin requests must be left to the network'
      );
      // And a failure must not be cached, or the failure becomes permanent.
      assert(/if\s*\(response\.ok\)/.test(sw), 'only successful responses are stored');
    });

    it('SH7: a failed navigation still opens the app', () => {
      const sw = read('sw.js');
      assert(
        /request\.mode\s*===\s*'navigate'/.test(sw),
        'an offline reload falls back to the cached shell rather than an error page'
      );
    });
  });
}
