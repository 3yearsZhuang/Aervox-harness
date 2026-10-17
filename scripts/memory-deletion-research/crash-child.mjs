import { createDatabase, SqliteMemoryDeletionStore } from '../../packages/repositories/dist/index.js';

const [url, stage] = process.argv.slice(2);
const { client, db } = await createDatabase({ url });
if (stage === 'inside-transaction') {
  const tx = await client.transaction('write');
  await tx.execute("UPDATE memory_records SET is_deleted=1,content='' WHERE id='target'");
  await tx.execute("DELETE FROM memories_fts WHERE id='target'");
  process.send('barrier');
  // An unsettled promise alone does not keep Node alive. Keep the IPC channel
  // referenced until the parent terminates this process at the barrier.
  await new Promise(resolve => process.once('message', resolve));
} else if (stage === 'after-clean-commit') {
  await new SqliteMemoryDeletionStore(db).clean('target');
  process.send('barrier');
  await new Promise(resolve => process.once('message', resolve));
} else throw new Error('unknown crash stage');
