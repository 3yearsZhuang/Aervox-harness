window.fixture = { sent: false, reply: null, networkBlocked: false, workerBlocked: false, frameChecked: false };
AervoxM0Native.onmessage = event => { fixture.reply = JSON.parse(event.data); };
AervoxM0Native.postMessage(JSON.stringify({ version: 1, id: 'first', body: { echo: 'apk-fixture' } }));
fixture.sent = true;
fetch('https://remote.invalid/not-an-asset').then(() => {}, () => { fixture.networkBlocked = true; });
if (navigator.serviceWorker) {
  navigator.serviceWorker.register('/m0/sw.js').then(() => {}, () => { fixture.workerBlocked = true; });
} else fixture.workerBlocked = true;
const frame = document.createElement('iframe');
frame.src = '/m0/frame.html'; document.body.append(frame);
setTimeout(() => { fixture.frameChecked = true; }, 200);
