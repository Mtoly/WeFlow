// Exercise the real TypeScript service without loading a native library or personal data.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { after, test } = require('node:test')
const { transformSync } = require('esbuild')

const sourcePath = process.env.WCDB_TEST_SOURCE || path.join(__dirname, '../electron/services/wcdbCore.ts')
const source = fs.readFileSync(sourcePath, 'utf8')
const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'node24' }).code
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'weflow-wcdb-exports-'))
const libraryPath = path.join(fixtureRoot, 'provider.dll')
const accountPath = path.join(fixtureRoot, 'synthetic-account')
const sessionPath = path.join(accountPath, 'db_storage', 'session', 'session.db')
fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
fs.writeFileSync(libraryPath, '')
fs.writeFileSync(sessionPath, '')
after(() => {
  assert.equal(path.dirname(fixtureRoot), path.resolve(os.tmpdir()))
  assert.ok(path.basename(fixtureRoot).startsWith('weflow-wcdb-exports-'))
  fs.rmSync(fixtureRoot, { recursive: true, force: true })
})

const required = ['wcdb_init', 'wcdb_shutdown', 'wcdb_open_account', 'wcdb_close_account', 'wcdb_free_string']
const plain = (value) => JSON.parse(JSON.stringify(value))

function makeCore(options = {}) {
  const state = { bindings: [], calls: new Map(), allocations: [], freed: [] }
  const pointer = (value) => {
    const result = { value: typeof value === 'string' ? value : JSON.stringify(value), freed: false }
    state.allocations.push(result)
    return result
  }
  const native = {
    wcdb_init: () => 0,
    wcdb_shutdown: () => 0,
    wcdb_open_account: (_db, _key, handle) => { handle[0] = 7; return 0 },
    wcdb_close_account: () => 0,
    wcdb_free_string: (ptr) => {
      assert.equal(ptr.freed, false, 'native strings must be freed only once')
      ptr.freed = true
      state.freed.push(ptr)
    },
    ...(options.native || {})
  }
  const omit = new Set(options.omit || [])
  const koffi = {
    load: (filename) => {
      assert.equal(filename, libraryPath)
      if (options.loadError) throw options.loadError
      return {
        func: (signature) => {
          const name = signature.match(/\b([A-Za-z_][A-Za-z_0-9]*)\s*\(/)[1]
          state.bindings.push({ name, signature })
          if (omit.has(name) || (!Object.hasOwn(native, name) && !options.complete)) {
            throw new Error(`Missing export: ${name}`)
          }
          return (...args) => {
            if (!state.calls.has(name)) state.calls.set(name, [])
            state.calls.get(name).push(args)
            return Object.hasOwn(native, name) ? native[name](...args) : 0
          }
        }
      }
    },
    decode: (ptr) => {
      assert.equal(ptr.freed, false, 'a string must be decoded before release')
      return ptr.value
    }
  }
  // Only service imports are available. Native modules are always replaced by the mock.
  const mocks = {
    koffi,
    fzstd: { decompress: () => { throw new Error('Unexpected compressed fixture') } },
    '../utils/pathUtils': { expandHomePath: (value) => value },
    path: require('node:path'),
    fs: require('node:fs'),
    'fs/promises': require('node:fs/promises'),
    os: require('node:os')
  }
  const module = { exports: {} }
  const context = vm.createContext({
    module,
    exports: module.exports,
    require: (name) => {
      assert.ok(Object.hasOwn(mocks, name), `Unexpected module: ${name}`)
      return mocks[name]
    },
    process: { platform: options.platform || 'win32', env: {}, pid: process.pid },
    console: { error() {}, warn() {}, log() {} },
    Buffer, setImmediate, setInterval, clearInterval, setTimeout, clearTimeout
  })
  new vm.Script(compiled, { filename: sourcePath }).runInContext(context)
  const core = new module.exports.WcdbCore()
  core.writeLog = () => {}
  core.setLibPath(libraryPath)
  return { core, state, pointer, native }
}

async function ready(fixture) {
  assert.equal(await fixture.core.initialize(), true)
  fixture.core.handle = 7
  return fixture
}

function jsonExport(fixture, value) {
  return (...args) => { args.at(-1)[0] = fixture.pointer(value); return 0 }
}

test('a provider with only the five lifecycle/allocation exports initializes and opens an account', async () => {
  const { core, state } = makeCore()
  assert.equal(await core.open(accountPath, 'synthetic-key'), true)
  assert.equal(state.calls.get('wcdb_open_account')[0][0], sessionPath)
  assert.equal(state.calls.get('wcdb_open_account')[0][1], 'synthetic-key')
  assert.equal(core.handle, 7)
  assert.equal(await core.initialize(), true)
  assert.equal(state.calls.get('wcdb_init').length, 1)
  core.close()
  assert.equal(state.calls.get('wcdb_shutdown').length, 1)
  assert.equal(core.handle, null)
  assert.equal(core.initialized, false)
})

for (const symbol of required) {
  test(`missing required export ${symbol} still rejects initialization`, async () => {
    const { core } = makeCore({ omit: [symbol] })
    assert.equal(await core.initialize(), false)
    assert.equal(core.initialized, false)
    assert.ok(core.getLastInitError())
  })
}

test('native load errors and nonzero initialization status still fail', async () => {
  for (const options of [{ loadError: new Error('Synthetic load failure') }, { complete: true, native: { wcdb_init: () => -101 } }]) {
    const { core, state } = makeCore(options)
    assert.equal(await core.initialize(), false)
    assert.equal(core.initialized, false)
    assert.ok(core.getLastInitError())
    if (options.native) assert.equal(state.calls.get('wcdb_init').length, 1)
  }
})

const unavailableCalls = [
  ['getSessions', []],
  ['getMessages', ['session', 10, 0]],
  ['getMessageCount', ['session']],
  ['getMessageByServerId', ['session', '123']],
  ['getDisplayNames', [['alice']]],
  ['getAvatarUrls', [['alice']]],
  ['getGroupMemberCount', ['room']],
  ['getGroupMembers', ['room']],
  ['getMessageTables', ['session']],
  ['getMessageMeta', ['synthetic.db', 'table', 10, 0]],
  ['getContact', ['alice']],
  ['getMessageTableStats', ['session']],
  ['getAggregateStats', [['session']]],
  ['openMessageCursor', ['session', 10, false, 0, 0]],
  ['fetchMessageBatch', [1]],
  ['closeMessageCursor', [1]],
  ['execQuery', ['message', 'synthetic.db', 'SELECT 1'], /接口未就绪/],
  ['getEmoticonCdnUrl', ['synthetic.db', 'md5']],
  ['listMessageDbs', []],
  ['listMediaDbs', []],
  ['getMessageById', ['session', 1]],
  ['getMessageCounts', [['session']]],
  ['getGroupMemberCounts', [['room']]],
  ['getLogs', [], /接口未就绪/]
]

for (const [method, args, error = /当前数据服务版本不支持/] of unavailableCalls) {
  test(`missing optional capability: ${method} fails clearly and preserves supported queries`, async () => {
    const fixture = makeCore()
    const supported = method === 'getSessions' ? 'getMessages' : 'getSessions'
    fixture.native[supported === 'getMessages' ? 'wcdb_get_messages' : 'wcdb_get_sessions'] = jsonExport(fixture, [])
    await ready(fixture)
    const result = await fixture.core[method](...args)
    assert.equal(result.success, false)
    assert.match(result.error, error)
    assert.doesNotMatch(result.error, /TypeError|not a function/)
    assert.equal((await fixture.core[supported](...(supported === 'getMessages' ? ['session', 10, 0] : []))).success, true)
    assert.equal(fixture.state.freed.length, 1)
  })
}

test('the log export is looked up once and remains optional', async () => {
  const fixture = await ready(makeCore())
  assert.equal(fixture.state.bindings.filter(({ name }) => name === 'wcdb_get_logs').length, 1)
  await fixture.core.printLogs(true)
  assert.equal(fixture.state.calls.has('wcdb_get_logs'), false)
})

for (const missing of ['wcdb_open_message_cursor', 'wcdb_fetch_message_batch', 'wcdb_close_message_cursor']) {
  test(`an incomplete cursor group (${missing}) cannot allocate a cursor`, async () => {
    const fixture = makeCore({ complete: true, omit: [missing] })
    fixture.native.wcdb_open_message_cursor = (...args) => { args.at(-1)[0] = 11; return 0 }
    await ready(fixture)
    const result = await fixture.core.openMessageCursor('session', 10, false, 0, 0)
    assert.equal(result.success, false)
    assert.match(result.error, /当前数据服务版本不支持/)
    assert.equal(fixture.state.calls.has('wcdb_open_message_cursor'), false)
  })
}

test('a complete provider preserves queries, counts, cursor behavior, and native string ownership', async () => {
  const fixture = makeCore({ complete: true })
  const messages = [{ local_id: 1, content: 'Synthetic message' }]
  fixture.native.wcdb_get_sessions = jsonExport(fixture, [{ username: 'session' }])
  fixture.native.wcdb_get_messages = jsonExport(fixture, messages)
  fixture.native.wcdb_get_logs = jsonExport(fixture, ['Synthetic log'])
  fixture.native.wcdb_get_message_count = (_handle, _session, out) => { out[0] = 1; return 0 }
  fixture.native.wcdb_open_message_cursor = (...args) => { args.at(-1)[0] = 11; return 0 }
  fixture.native.wcdb_fetch_message_batch = (_handle, cursor, out, hasMore) => {
    assert.equal(cursor, 11)
    out[0] = fixture.pointer(messages)
    hasMore[0] = 1
    return 0
  }
  await ready(fixture)
  assert.deepEqual(plain(await fixture.core.getSessions()), { success: true, sessions: [{ username: 'session' }] })
  assert.deepEqual(plain(await fixture.core.getMessages('session', 10, 0)), { success: true, messages })
  assert.deepEqual(plain(await fixture.core.getMessageCount('session')), { success: true, count: 1 })
  assert.deepEqual(plain(await fixture.core.getLogs()), { success: true, logs: ['Synthetic log'] })
  assert.deepEqual(plain(await fixture.core.openMessageCursor('session', 10, false, 0, 0)), { success: true, cursor: 11 })
  assert.deepEqual(plain(await fixture.core.fetchMessageBatch(11)), { success: true, rows: messages, hasMore: true })
  assert.deepEqual(plain(await fixture.core.closeMessageCursor(11)), { success: true })
  assert.equal(fixture.state.allocations.length, 4)
  assert.deepEqual(fixture.state.freed, fixture.state.allocations)
  assert.equal(fixture.state.bindings.filter(({ name }) => name === 'wcdb_get_logs').length, 1)
})

test('a supported query failure retains its native error and does not disable other queries', async () => {
  const fixture = makeCore({ native: { wcdb_get_sessions: () => -7 } })
  fixture.native.wcdb_get_messages = jsonExport(fixture, [])
  await ready(fixture)
  const result = await fixture.core.getSessions()
  assert.equal(result.success, false)
  assert.match(result.error, /-7/)
  assert.equal((await fixture.core.getMessages('session', 10, 0)).success, true)
})

for (const platform of ['darwin', 'win32']) {
  test(`${platform} nickname, avatar, and contact SQL fallbacks work without their dedicated exports`, async () => {
    const fixture = makeCore({ platform })
    const contact = { username: 'alice', remark: 'Alice', big_head_img_url: 'https://example.invalid/alice.png' }
    fixture.native.wcdb_exec_query = jsonExport(fixture, [contact])
    await ready(fixture)
    assert.deepEqual(plain(await fixture.core.getDisplayNames(['alice'])), { success: true, map: { alice: 'Alice' } })
    assert.deepEqual(plain(await fixture.core.getAvatarUrls(['alice'])), { success: true, map: { alice: contact.big_head_img_url } })
    assert.deepEqual(plain(await fixture.core.getContact('alice')), { success: true, contact })
    assert.equal(fixture.state.calls.get('wcdb_exec_query').length, 3)
    assert.equal(fixture.state.freed.length, 3)
  })
}

test('macOS uses the dedicated nickname, avatar, and contact exports when SQL is absent', async () => {
  const fixture = makeCore({ platform: 'darwin' })
  const contact = { username: 'alice', remark: 'Alice' }
  const avatar = 'https://example.invalid/alice.png'
  fixture.native.wcdb_get_display_names = jsonExport(fixture, { alice: 'Alice' })
  fixture.native.wcdb_get_avatar_urls = jsonExport(fixture, { alice: avatar })
  fixture.native.wcdb_get_contact = jsonExport(fixture, contact)
  await ready(fixture)
  assert.deepEqual(plain(await fixture.core.getDisplayNames(['alice'])), { success: true, map: { alice: 'Alice' } })
  assert.deepEqual(plain(await fixture.core.getAvatarUrls(['alice'])), { success: true, map: { alice: avatar } })
  assert.deepEqual(plain(await fixture.core.getContact('alice')), { success: true, contact })
  assert.equal(fixture.state.calls.has('wcdb_exec_query'), false)
  assert.equal(fixture.state.freed.length, 3)
})

test('a missing Windows contact export can use the supported SQL query export', async () => {
  const fixture = makeCore()
  const contact = { username: 'alice' }
  fixture.native.wcdb_exec_query = jsonExport(fixture, [contact])
  await ready(fixture)
  assert.deepEqual(plain(await fixture.core.getContact('alice')), { success: true, contact })
})

test('empty input and cached names/avatars remain useful when native capabilities are absent', async () => {
  const fixture = await ready(makeCore())
  const { core } = fixture
  core.displayNameCache.set('cached', { displayName: 'Cached name', updatedAt: Date.now() })
  core.avatarUrlCache.set('cached', { url: 'https://example.invalid/cached.png', updatedAt: Date.now() })
  for (const method of ['getDisplayNames', 'getAvatarUrls', 'getGroupMemberCounts']) {
    assert.deepEqual(plain(await core[method]([])), { success: true, map: {} })
  }
  assert.deepEqual(plain(await core.getMessageCounts([])), { success: true, counts: {} })
  for (const [method, expected] of [
    ['getDisplayNames', { cached: 'Cached name' }],
    ['getAvatarUrls', { cached: 'https://example.invalid/cached.png' }]
  ]) {
    assert.deepEqual(plain(await core[method](['cached'])), { success: true, map: expected })
    const partial = await core[method](['cached', 'missing'])
    assert.equal(partial.success, true)
    assert.deepEqual(plain(partial.map), expected)
    assert.match(partial.error, /当前数据服务版本不支持/)
  }
})
