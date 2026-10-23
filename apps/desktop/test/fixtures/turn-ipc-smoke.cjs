// Real Electron transport acceptance. The HTTP server and user-data profile are isolated.
const assert = require('node:assert/strict')
const {createServer} = require('node:http')
const {join} = require('node:path')
const {pathToFileURL} = require('node:url')
const {writeSync} = require('node:fs')
const {app, BrowserWindow, ipcMain} = require('electron')
const directory = process.env.AERVOX_TURN_IPC_SMOKE_DIR
const {createDesktopTurnBridge, createRendererBoundary, rendererEntryArgument} = require(join(directory, 'main.cjs'))
app.setPath('userData', join(directory, 'profile'))
app.on('window-all-closed', () => {})
const checks = [], requests = []
const record = value => writeSync(1, `${JSON.stringify(value)}\n`)
const pass = name => { checks.push(name); record({type: 'check', name, passed: true}) }
const frame = (turnId, sequence, eventType, text) => `data: ${JSON.stringify({eventId: `event_${sequence}`, turnId, sequence, eventType, data: {text}})}\n\n`
let cancelledResponseClosed = false
const server = createServer((request, response) => {
  const entry = {method: request.method, url: request.url, authorization: request.headers.authorization, idempotencyKey: request.headers['idempotency-key'], cursor: request.headers['last-event-id']}
  requests.push(entry)
  if (request.method === 'POST') {
    assert.equal(request.headers.authorization, 'Bearer smoke-secret')
    response.writeHead(201, {'content-type': 'application/json'})
    const session = request.url.split('/')[3]
    response.end(JSON.stringify({turnId: session === 'early' ? 'turn_early' : session === 'cancel' ? 'turn_cancel' : 'turn_main'}))
    request.resume()
    return
  }
  response.writeHead(200, {'content-type': 'text/event-stream'})
  if (request.url.startsWith('/v1/turns/turn_early/events')) response.end()
  else if (request.url.startsWith('/v1/turns/turn_resume/events')) response.end(frame('turn_resume', 12, 'delta', 'continued') + frame('turn_resume', 13, 'done'))
  else if (request.url.startsWith('/v1/turns/turn_cancel/events')) {
    response.flushHeaders()
    response.on('close', () => {cancelledResponseClosed = true})
  } else response.end(frame('turn_main', 1, 'delta', 'hello') + frame('turn_main', 2, 'done'))
})
let window, bridge
async function until(predicate, label) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out: ${label}`)
}
const evaluate = source => window.webContents.executeJavaScript(source)
async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const boundary = createRendererBoundary({openExternal: async () => {}})
  bridge = createDesktopTurnBridge({apiBaseUrl: `http://127.0.0.1:${server.address().port}`, authToken: () => 'smoke-secret', requireAcknowledgement: true,
    isTrustedSender: sender => boundary.isTrustedContents(sender)})
  const ipc = boundary.ipc(ipcMain)
  ipc.on('aervox:turn:start', (event, payload) => {void bridge.streamAervoxTurn(event, payload)})
  ipc.on('aervox:turn:observe', (event, payload) => {void bridge.observeAervoxTurn(event, payload)})
  ipc.on('aervox:turn:cancel', (event, requestId) => bridge.cancelTurn(event.sender, requestId))
  ipc.on('aervox:turn:ack', (event, payload) => bridge.acknowledge(event.sender, payload))
  const entry = pathToFileURL(join(directory, 'index.html')).href
  window = new BrowserWindow({show: false, webPreferences: {preload: join(directory, 'preload.cjs'), contextIsolation: true, sandbox: true,
    nodeIntegration: false, additionalArguments: [rendererEntryArgument(entry)]}})
  boundary.attach(window.webContents, entry)
  await window.loadURL(entry)
  assert.equal(await evaluate('typeof window.fairyDesktop.observeTurn'), 'function')
  pass('actual trusted preload exposes typed Turn observation')

  await evaluate(`(() => {
    window.order = []; window.outcome = undefined;
    window.running = window.turnSmoke.streamTurn('normal', 'hello', {
      onDelta: text => window.order.push(text), onDone: () => window.order.push('done'),
      onEvent: event => { if (event.sequence === 1) return new Promise(resolve => {window.releaseEvent = resolve}); },
    }, {idempotencyKey: 'business-reservation', onAccepted: id => {
      window.order.push('accepted_' + id);
      return new Promise(resolve => {window.releaseAcceptance = resolve});
    }}).then(() => {window.outcome = 'completed'}, error => {window.outcome = error.message});
  })()`)
  await until(() => evaluate('typeof window.releaseAcceptance === "function"'), 'renderer acceptance callback')
  assert.equal(requests.filter(request => request.method === 'GET').length, 0)
  pass('async acceptance crosses contextBridge and blocks upstream observation until ACK')
  await evaluate('window.releaseAcceptance()')
  await until(() => evaluate('typeof window.releaseEvent === "function"'), 'renderer event consumer')
  assert.deepEqual(await evaluate('window.order'), ['accepted_turn_main', 'hello'])
  assert.equal(bridge.activeTurnRequests.size, 1)
  pass('async event consumer crosses contextBridge and blocks terminal dispatch until ACK')
  await evaluate('window.releaseEvent()')
  await until(() => evaluate('window.outcome !== undefined'), 'normal stream completion')
  assert.equal(await evaluate('window.outcome'), 'completed')
  assert.deepEqual(await evaluate('window.order'), ['accepted_turn_main', 'hello', 'done'])
  assert.equal(requests[0].idempotencyKey, 'business-reservation')
  assert.ok(requests.every(request => request.authorization === 'Bearer smoke-secret'))
  pass('real renderer/main IPC preserves caller idempotency, Bearer auth and terminal order')

  const beforeEarly = requests.length
  const early = await evaluate(`window.turnSmoke.streamTurn('early', 'hello', {onDelta() {}, onDone() {throw new Error('false success')}})
    .then(() => 'unexpected success', error => error.message)`)
  assert.match(early, /turn_stream_incomplete/)
  assert.equal(requests.slice(beforeEarly).filter(request => request.method === 'POST').length, 1)
  assert.equal(requests.slice(beforeEarly).filter(request => request.method === 'GET').length, 3)
  pass('real IPC rejects early EOF after bounded observation reconnects without resubmission')

  const beforeResume = requests.length
  const resumed = await evaluate(`(() => {
    const texts = [];
    return window.turnSmoke.observeTurn('turn_resume', {onDelta: text => texts.push(text), onDone() {}}, {afterEventId: 'decision'})
      .then(() => texts);
  })()`)
  assert.deepEqual(resumed, ['continued'])
  assert.equal(requests.length, beforeResume + 1)
  assert.equal(requests.at(-1).method, 'GET')
  assert.equal(requests.at(-1).url, '/v1/turns/turn_resume/events?after=decision')
  assert.equal(requests.at(-1).cursor, 'decision')
  pass('typed observation resumes an existing Turn with matching query/header cursor')

  await evaluate(`(() => {
    window.abortObserver = new AbortController(); window.cancelOutcome = undefined;
    window.cancelRun = window.turnSmoke.streamTurn('cancel', 'hello', {onDelta() {}, onDone() {}}, {signal: window.abortObserver.signal})
      .then(() => {window.cancelOutcome = 'unexpected success'}, error => {window.cancelOutcome = error.name});
  })()`)
  await until(() => requests.at(-1)?.url === '/v1/turns/turn_cancel/events', 'cancel observation opened')
  await evaluate('window.abortObserver.abort()')
  await until(() => bridge.activeTurnRequests.size === 0 && cancelledResponseClosed, 'main observer and HTTP response closed')
  assert.equal(await evaluate('window.cancelOutcome'), 'AbortError')
  pass('renderer cancellation closes the owned main observer and upstream HTTP stream')
}
app.whenReady().then(run).then(() => {
  record({type: 'result', passed: true, checks, requests})
  window?.destroy(); server.closeAllConnections(); server.close(); app.exit(0)
}, error => {
  record({type: 'result', passed: false, checks, requests, error: error?.stack ?? String(error)})
  window?.destroy(); server.closeAllConnections(); server.close(); app.exit(1)
})
