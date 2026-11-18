// Lists the indexes each collection has in the database (for comparing with what the code queries).
import mongoose from 'mongoose';
await mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/', { dbName: process.env.DB ?? 'pristine' });
const db = mongoose.connection.db;
const names = (await db.listCollections().toArray()).map((c) => c.name).sort();
for (const n of names) {
  if (process.argv[2] && !n.includes(process.argv[2])) continue;
  const idx = await db.collection(n).indexes().catch(() => []);
  const count = await db.collection(n).estimatedDocumentCount().catch(() => 0);
  console.log(`${n} (${count} docs)`);
  for (const i of idx) console.log('   ', JSON.stringify(i.key), i.unique ? 'unique' : '', i.sparse ? 'sparse' : '', i.expireAfterSeconds != null ? `ttl=${i.expireAfterSeconds}` : '');
}
process.exit(0);
