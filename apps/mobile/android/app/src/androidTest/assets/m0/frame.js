parent.frameExecuted = true;
if (typeof AervoxM0Native === 'object') AervoxM0Native.postMessage(JSON.stringify({ version: 1, id: 'child', body: {} }));
