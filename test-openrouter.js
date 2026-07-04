const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

async function test() {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "nemotron-3-nano-30b-a3b:free",
      messages: [{ role: "user", content: "Hello" }]
    })
  });
  const text = await response.text();
  console.log(text);
}
test();
