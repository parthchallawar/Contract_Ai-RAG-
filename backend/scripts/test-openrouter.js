// Minimal standalone smoke test for the configured OpenRouter key/model —
// confirms connectivity and auth without going through the full app.
// Run: node backend/scripts/test-openrouter.js  (reads backend/.env)

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'nemotron-3-nano-30b-a3b:free';

async function test() {
  if (!OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY is not set in backend/.env');
    process.exit(1);
  }
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [{ role: "user", content: "Hello" }]
    })
  });
  const text = await response.text();
  console.log(text);
}
test();
