// Plugin settings document: defaults, tolerant parsing, persistence, and the
// live switch that makes the panel's choices take effect without a restart.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_SETTINGS, SettingsStore, applyProfileSettings, resolveSettings } from '../lib/browser-electron/settings-store.js'
import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'

/** A unique settings file per test. */
function settingsFile() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-settings-')), 'settings.json')
}

/** Read the history file, or '' when it does not exist yet. */
function readHistory(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** Poll until fn() is truthy or the budget runs out. */
async function waitFor(fn, ms = 3000) {
  const deadline = Date.now() + ms
  for (;;) {
    if (await fn()) return true
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Host stub answering the probes a navigation makes (stamp + url/title). */
function makeHost() {
  // The document stamp must change per navigation, exactly like a real load,
  // and the URL must reflect the address actually navigated to.
  let loads = 0
  let current = 'about:blank'
  return {
    createView() {
      return {
        id: 'view1',
        async sendCommand(method, params) {
          if (method === 'Page.navigate') { loads += 1; current = params.url; return {} }
          if (method === 'Runtime.evaluate') {
            const expr = params.expression ?? ''
            if (expr.includes('timeOrigin')) return { result: { value: `${loads}|complete` } }
            if (expr.includes('document.title')) return { result: { value: `${current}\u0000Example` } }
            return { result: { value: { ok: true } } }
          }
          return {}
        },
      }
    },
    destroyView() {}, showView() {}, groupView() {}, onUserAction() {},
  }
}

test('a missing file resolves to the documented defaults', () => {
  const store = new SettingsStore(settingsFile())
  assert.deepEqual(store.get(), DEFAULT_SETTINGS)
  assert.equal(store.get().history.enabled, true, 'history records by default')
  assert.equal(store.get().ui.autoExpandOnce, true, 'auto-expand is once-per-task by default')
  assert.equal(store.get().ui.closeWithSession, false, 'closing the interface is not the default end of a session')
  assert.equal(store.get().ui.quiet, false, 'quiet mode is opt-in: the default shares the window with the human')
  assert.equal(store.get().bridge.autoInstall, false, 'bridge maintenance is explicit by default')
})

test('bridge automatic-install compatibility defaults remain off', () => {
  for (const raw of [undefined, {}, { bridge: {} }, { bridge: { autoInstall: 'true' } }]) {
    assert.equal(resolveSettings(raw).bridge.autoInstall, false)
  }
  assert.equal(resolveSettings({ bridge: { autoInstall: true } }).bridge.autoInstall, true, 'historical preference remains readable without activating runtime installation')
})

test('quiet mode is opt-in, and a mistyped value cannot turn it on', () => {
  // Presentation policy, not a capability gate: a document that predates the switch, or a
  // hand-edited `"true"`, must keep the documented default (off) rather than quietly making
  // every operation stop presenting itself.
  assert.equal(resolveSettings({}).ui.quiet, false, 'absent keeps the default')
  assert.equal(resolveSettings({ ui: {} }).ui.quiet, false, 'an existing section without the key keeps it too')
  assert.equal(resolveSettings({ ui: { quiet: true } }).ui.quiet, true, 'the switch is honoured when present')
  assert.equal(resolveSettings({ ui: { quiet: 'true' } }).ui.quiet, false, 'a string is not a boolean')
})

test('partial and mistyped fields fall back per field, unknown keys are dropped', () => {
  const resolved = resolveSettings({
    history: { enabled: false, maxEntries: 'lots', maxAgeDays: 7 },
    ui: { virtualCursor: false },
    somethingElse: { sneaky: true },
  })
  assert.equal(resolved.history.enabled, false, 'valid boolean kept')
  assert.equal(resolved.history.maxEntries, DEFAULT_SETTINGS.history.maxEntries, 'mistyped number falls back')
  assert.equal(resolved.history.maxAgeDays, 7)
  assert.equal(resolved.ui.virtualCursor, false)
  assert.equal(resolved.ui.autoExpandOnce, true, 'untouched field keeps its default')
  assert.equal('somethingElse' in resolved, false, 'unknown sections are not smuggled through')
})

test('update merges, persists, and reads back', () => {
  const file = settingsFile()
  const store = new SettingsStore(file)
  store.update({ history: { enabled: false } })
  store.update({ ui: { autoExpandOnce: false } })

  const reread = new SettingsStore(file).get()
  assert.equal(reread.history.enabled, false, 'first patch persisted')
  assert.equal(reread.history.maxEntries, DEFAULT_SETTINGS.history.maxEntries, 'merge kept sibling fields')
  assert.equal(reread.ui.autoExpandOnce, false, 'second patch persisted')

  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(onDisk.history.enabled, false)
})

test('a malformed file refuses the capability gates instead of failing or defaulting', () => {
  // The behaviour changed on purpose. A file that exists and cannot be parsed used to resolve to
  // DEFAULT_SETTINGS, which meant a torn write (a TerminateProcess during the save) or one stray
  // character silently reopened every switch the operator had turned off — and the next save
  // wrote those defaults to disk for good. "No file" is still a first run and still takes the
  // defaults; "a file I cannot read" is not the same statement.
  const file = settingsFile()
  writeFileSync(file, '{ this is not json')
  const resolved = new SettingsStore(file).get()

  assert.equal(resolved.credentials.allowRead, false, 'cookie reading is not granted by a corrupt file')
  assert.deepEqual(resolved.actions, { allowExecute: false, allowDownload: false, allowCredentialWrite: false })

  // Everything that is merely convenient keeps its default: refusing history or the browser
  // choice would punish the user for a corrupt file without protecting anything.
  assert.deepEqual(resolved.history, DEFAULT_SETTINGS.history)
  assert.deepEqual(resolved.ui, DEFAULT_SETTINGS.ui)
  assert.deepEqual(resolved.browser, DEFAULT_SETTINGS.browser)

  // And a file that is simply ABSENT — a first run — still gets the documented defaults.
  const fresh = new SettingsStore(join(mkdtempSync(join(tmpdir(), 'dsh-settings-new-')), 'settings.json')).get()
  assert.deepEqual(fresh, DEFAULT_SETTINGS)
})

test('the provider honours a settings switch flipped at runtime', async () => {
  let settings = { ...DEFAULT_SETTINGS, history: { ...DEFAULT_SETTINGS.history, enabled: true } }
  const history = join(mkdtempSync(join(tmpdir(), 'dsh-settings-hist-')), 'history.jsonl')
  const p = new ElectronBrowserProvider(makeHost(), {
    history: { file: history },
    settings: () => settings,
  })
  const sid = await p.open()

  await p.navigate(sid, { url: 'https://example.com/one' })
  assert.ok(await waitFor(() => readHistory(history).includes('/one')), 'recorded while enabled')

  settings = { ...settings, history: { ...settings.history, enabled: false } }
  await p.navigate(sid, { url: 'https://example.com/two' })
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(readHistory(history).includes('/two'), false, 'nothing recorded once switched off')
  assert.ok(readHistory(history).includes('/one'), 'earlier records were kept')
  await p.close(sid)
})

// A hand-edited settings file has to survive the editor. Notepad and PowerShell's
// `Set-Content -Encoding utf8` both write a leading BOM, and JSON.parse rejects it —
// so without a strip the document looked correct while every value in it was silently
// discarded and the plugin ran on defaults (including switches just turned off).
test('a settings file written with a UTF-8 BOM is still honoured', () => {
  const file = settingsFile()
  const document = { vision: { strategy: 'nonVisual' }, ui: { autoExpandOnce: false, virtualCursor: false } }
  writeFileSync(file, `\uFEFF${JSON.stringify(document)}`)
  const settings = new SettingsStore(file).get()
  assert.equal(settings.vision.strategy, 'nonVisual', 'the strategy survived the BOM')
  assert.equal(settings.ui.autoExpandOnce, false, 'so did the switches')
  assert.equal(settings.ui.virtualCursor, false)
  assert.equal(settings.history.enabled, DEFAULT_SETTINGS.history.enabled, 'unspecified fields keep defaults')
})

// Per-profile carrier overrides: profiles sharing one $DSH_HOME want different carriers, and a
// single global `browser.channel` made them overwrite each other (the file is shared and every
// host re-reads it on a stat), so the value is nameable per booted profile.
test('per-profile overrides parse, validate and fall back to the global value', () => {
  const warnings = []
  const resolved = resolveSettings({
    browser: {
      channel: 'sidebar',
      headless: 'windowed',
      profiles: {
        web: { channel: 'edge', headless: 'headless', quiet: true },
        desktop: { channel: 'sidebar' },
        broken: { channel: 'netscape', quiet: 'yes' },
        empty: {},
        notAnObject: 7,
      },
    },
  }, message => warnings.push(message))
  assert.deepEqual(resolved.browser.profiles.web, { channel: 'edge', headless: 'headless', quiet: true })
  assert.deepEqual(resolved.browser.profiles.desktop, { channel: 'sidebar' }, 'a partial entry keeps only what it set')
  assert.equal('broken' in resolved.browser.profiles, false, 'nothing usable means no override at all')
  assert.equal('empty' in resolved.browser.profiles, false)
  assert.equal('notAnObject' in resolved.browser.profiles, false)
  assert.equal(resolved.browser.channel, 'sidebar', 'the global value is untouched by an override')
  assert.equal(warnings.length, 2, 'the mistyped channel and the mistyped quiet are both reported')
})

test('an override only changes what it names, and only for its own profile', () => {
  const raw = { browser: { channel: 'sidebar', headless: 'windowed', profiles: { web: { channel: 'edge' } } } }
  const resolved = resolveSettings(raw)
  const web = applyProfileSettings(resolved, 'web')
  assert.equal(web.browser.channel, 'edge', 'the override wins for its profile')
  assert.equal(web.browser.headless, 'windowed', 'unmentioned fields follow the global value')
  assert.equal(web.ui.quiet, resolved.ui.quiet, 'and so does quiet mode')
  const desktop = applyProfileSettings(resolved, 'desktop')
  assert.equal(desktop, resolved, 'a profile without an override gets the document itself')
  assert.equal(applyProfileSettings(resolved, undefined), resolved, 'a surface without a profile is unchanged')
})

test('a profile-bound store writes its carrier choice into its own override', () => {
  const file = settingsFile()
  const store = new SettingsStore(file, undefined, 'web')
  const updated = store.update({ browser: { channel: 'edge' }, ui: { quiet: true } })
  assert.equal(updated.browser.channel, 'edge', 'the caller sees the effective value')
  assert.equal(updated.ui.quiet, true)

  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(onDisk.browser.channel, DEFAULT_SETTINGS.browser.channel, 'the global default is not overwritten')
  assert.deepEqual(onDisk.browser.profiles.web, { channel: 'edge', quiet: true }, 'the profile carries the choice')
  assert.equal(onDisk.ui.quiet, DEFAULT_SETTINGS.ui.quiet, 'quiet mode moved into the override too')

  // A second profile, edited from elsewhere, must not be erased by the first one's next write.
  new SettingsStore(file).update({ browser: { profiles: { desktop: { channel: 'sidebar' } } } })
  new SettingsStore(file, undefined, 'web').update({ browser: { channel: 'chrome' } })
  const profiles = JSON.parse(readFileSync(file, 'utf8')).browser.profiles
  assert.equal(profiles.desktop.channel, 'sidebar', 'another profile keeps its own override')
  assert.equal(profiles.web.channel, 'chrome', 'and this one is updated in place')
  assert.equal(new SettingsStore(file, undefined, 'web').get().browser.channel, 'chrome')
  assert.equal(new SettingsStore(file, undefined, 'desktop').get().browser.channel, 'sidebar')
})

// A profile that stops overriding must go back to following the document, and the way the panel
// says that is `null`: storing the null would make the field unreadable and warn on every read.
test('a null field clears the override instead of storing an unreadable value', () => {
  const file = settingsFile()
  const store = new SettingsStore(file, undefined, 'web')
  store.update({ browser: { channel: 'edge' } })
  assert.equal(store.get().browser.channel, 'edge')

  store.update({ browser: { profiles: { web: { channel: null } } } })
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal('web' in onDisk.browser.profiles, false, 'the emptied entry is removed, not left as {}')
  assert.equal(store.get().browser.channel, DEFAULT_SETTINGS.browser.channel, 'and the global value applies again')
})

test('a store without a profile keeps writing the global value', () => {
  const file = settingsFile()
  const store = new SettingsStore(file)
  store.update({ browser: { channel: 'edge' } })
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(onDisk.browser.channel, 'edge', 'an unnamed surface is unchanged by this feature')
  assert.deepEqual(onDisk.browser.profiles, {}, 'and records no override')
})
