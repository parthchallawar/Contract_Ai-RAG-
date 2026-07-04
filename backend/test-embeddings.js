// Smoke test: local embedding model via Transformers.js
// First run downloads ~25MB of weights to the local cache; later runs are offline.
const { pipeline } = require('@xenova/transformers');

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function main() {
  console.time('model load (incl. download on first run)');
  const embed = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  console.timeEnd('model load (incl. download on first run)');

  const sentences = [
    'Either party may terminate this agreement with thirty days written notice.',   // termination clause
    'The Contractor may cancel the contract by giving one month advance notification.', // paraphrase of above
    'All invoices are due within Net 30 days of receipt.'                           // unrelated (payment)
  ];

  console.time('embed 3 sentences');
  const out = await Promise.all(sentences.map(s => embed(s, { pooling: 'mean', normalize: true })));
  console.timeEnd('embed 3 sentences');

  const [a, b, c] = out.map(o => o.data);
  console.log('embedding dims:', a.length);
  console.log('similarity(termination, termination-paraphrase):', cosine(a, b).toFixed(4), '<- should be HIGH');
  console.log('similarity(termination, payment-terms):        ', cosine(a, c).toFixed(4), '<- should be LOW');
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
