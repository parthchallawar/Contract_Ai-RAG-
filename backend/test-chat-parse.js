// Phase 3 unit tests for the chat parsing/verification helpers in
// backend/server.js — no server, no network. The LLM call itself is not
// under test; only the plain-text protocol parser, citation verifier, SSE
// line-buffering, and history sanitizer.
// Run: node backend/test-chat-parse.js

const { parseChatAnswer, verifyQuote, sanitizeChatHistory, parseSseChunk } = require('./server');

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// --- parseChatAnswer ---------------------------------------------------------
console.log('1. parseChatAnswer');

{
  const reply = `The liability cap is $50,000 per the agreement.

SOURCES:
- "liability cap of $50,000"
- "in the event of a claim"

IMPLICATIONS:
- Damages beyond $50,000 are not recoverable`;
  const parsed = parseChatAnswer(reply);
  check('full reply: content extracted', parsed.content === 'The liability cap is $50,000 per the agreement.', parsed.content);
  check('full reply: 2 quotes extracted', parsed.quotes.length === 2, JSON.stringify(parsed.quotes));
  check('full reply: quote marks stripped', parsed.quotes[0] === 'liability cap of $50,000', parsed.quotes[0]);
  check('full reply: 1 implication extracted', parsed.implications.length === 1, JSON.stringify(parsed.implications));
}

{
  const reply = 'This contract does not mention a specific liability cap.';
  const parsed = parseChatAnswer(reply);
  check('answer-only reply: content is the whole text', parsed.content === reply);
  check('answer-only reply: no quotes', parsed.quotes.length === 0);
  check('answer-only reply: no implications', parsed.implications.length === 0);
}

{
  const reply = `Answer text here.

sources:
- "lowercase header quote"`;
  const parsed = parseChatAnswer(reply);
  check('lowercase section header matched', parsed.quotes.length === 1 && parsed.quotes[0] === 'lowercase header quote',
    JSON.stringify(parsed));
}

{
  const reply = `Answer text.

SOURCES:
* "star bullet quote"`;
  const parsed = parseChatAnswer(reply);
  check('"*" bullet accepted', parsed.quotes.length === 1 && parsed.quotes[0] === 'star bullet quote', JSON.stringify(parsed));
}

{
  const reply = `Answer text.

SOURCES:
- quote without surrounding quote marks`;
  const parsed = parseChatAnswer(reply);
  check('quote without quote marks kept as-is', parsed.quotes.length === 1 && parsed.quotes[0] === 'quote without surrounding quote marks',
    JSON.stringify(parsed));
}

{
  const reply = `Answer text.

SOURCES:

IMPLICATIONS:
- one implication`;
  const parsed = parseChatAnswer(reply);
  check('SOURCES with zero bullets -> empty quotes array', parsed.quotes.length === 0, JSON.stringify(parsed));
  check('IMPLICATIONS after empty SOURCES still parsed', parsed.implications.length === 1, JSON.stringify(parsed));
}

{
  const garbage = `Some answer.

SOURCES:
random garbage line with no bullet
- "a real quote"
??? more noise ???

IMPLICATIONS:
not a bullet
- a real implication`;
  let threw = false;
  let parsed;
  try {
    parsed = parseChatAnswer(garbage);
  } catch (e) {
    threw = true;
  }
  check('garbage between sections never throws', !threw);
  check('garbage lines ignored, real bullets still found',
    parsed && parsed.quotes.length === 1 && parsed.implications.length === 1, JSON.stringify(parsed));
}

check('parseChatAnswer never throws on empty input', (() => { try { parseChatAnswer(''); return true; } catch { return false; } })());
check('parseChatAnswer never throws on non-string input', (() => { try { parseChatAnswer(null); return true; } catch { return false; } })());

// --- verifyQuote --------------------------------------------------------------
console.log('\n2. verifyQuote');

{
  const quote = 'liability cap of $50,000';
  const source = 'The Contractor may terminate this agreement with a liability cap of $50,000 for any claim.';
  const result = verifyQuote(quote, source);
  check('exact match found', !!result, JSON.stringify(result));
  check('offset maps back to original text', result && source.slice(result.offset, result.offset + quote.length) === quote,
    result && source.slice(result.offset, result.offset + quote.length));
}

{
  const source = 'The total shall be liability cap of $50,000 as stated herein.';
  const mangled = 'liability  cap of\n$50,000';
  const result = verifyQuote(mangled, source);
  check('whitespace-mangled quote matches', !!result, JSON.stringify(result));
  if (result) {
    const slice = source.slice(result.offset, result.offset + 'liability cap of $50,000'.length);
    check('offset lands on the real occurrence', slice === 'liability cap of $50,000', slice);
  }
}

{
  const source = 'The clause states the “party” shall indemnify the other.';
  const curlyQuote = 'the "party" shall indemnify';
  const result = verifyQuote(curlyQuote, source);
  check('curly-quote normalization matches straight quotes', !!result, JSON.stringify(result));
}

{
  const source = 'This agreement may be terminated by either party upon thirty days written notice to the other party without cause.';
  const hallucinatedTail = 'this agreement may be terminated by either party upon thirty days written notice to the moon';
  const result = verifyQuote(hallucinatedTail, source);
  check('>=8-word quote with hallucinated tail matches via 8-word prefix', !!result, JSON.stringify(result));
  check('prefix match lands at the real start of the source', result && result.offset === 0, JSON.stringify(result));
}

{
  const source = 'This contract contains no mention of indemnification whatsoever.';
  const result = verifyQuote('a completely fabricated quote that does not exist', source);
  check('genuinely absent quote returns null', result === null, JSON.stringify(result));
}

check('verifyQuote handles empty quote gracefully', verifyQuote('', 'some text') === null);
check('verifyQuote handles empty text gracefully', verifyQuote('some quote', '') === null);

// --- parseSseChunk (SSE line-buffer helper) -----------------------------------
console.log('\n3. parseSseChunk (SSE line-buffering)');

{
  const evt = { choices: [{ delta: { content: 'Hello' } }] };
  const raw = `data: ${JSON.stringify(evt)}\n\n`;
  const splitPoint = Math.floor(raw.length / 2);
  const chunk1 = raw.slice(0, splitPoint);
  const chunk2 = raw.slice(splitPoint);

  const first = parseSseChunk('', chunk1);
  check('mid-JSON split: first chunk yields no complete events', first.events.length === 0, JSON.stringify(first));

  const second = parseSseChunk(first.buffer, chunk2);
  check('mid-JSON split: second chunk completes the event', second.events.length === 1, JSON.stringify(second));
  check('reassembled event has the right delta',
    second.events[0]?.choices?.[0]?.delta?.content === 'Hello', JSON.stringify(second.events));
}

{
  const result = parseSseChunk('', 'data: [DONE]\n\n');
  check('[DONE] terminates without producing an event', result.events.length === 0, JSON.stringify(result));
}

{
  const evt1 = { choices: [{ delta: { content: 'A' } }] };
  const evt2 = { choices: [{ delta: { content: 'B' } }] };
  const chunk = `data: ${JSON.stringify(evt1)}\n\ndata: ${JSON.stringify(evt2)}\n\ndata: [DONE]\n\n`;
  const result = parseSseChunk('', chunk);
  check('multiple complete events in one chunk all parsed', result.events.length === 2, JSON.stringify(result));
  check('trailing buffer is empty after fully-terminated chunk', result.buffer === '', JSON.stringify(result.buffer));
}

// --- sanitizeChatHistory --------------------------------------------------------
console.log('\n4. sanitizeChatHistory');

check('non-array input -> []', Array.isArray(sanitizeChatHistory(null)) && sanitizeChatHistory(null).length === 0);
check('non-array input (string) -> []', sanitizeChatHistory('not an array').length === 0);

{
  const tenTurns = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i}` }));
  const result = sanitizeChatHistory(tenTurns);
  check('>8 turns trimmed to last 8', result.length === 8, `got ${result.length}`);
  check('trimmed to the LAST 8 turns (most recent kept)', result[0].content === 'turn 2' && result[7].content === 'turn 9',
    JSON.stringify(result));
}

{
  const withBadRoles = [
    { role: 'user', content: 'valid user turn' },
    { role: 'system', content: 'should be dropped' },
    { role: 'bot', content: 'should also be dropped' },
    { role: 'assistant', content: 'valid assistant turn' }
  ];
  const result = sanitizeChatHistory(withBadRoles);
  check('bad roles dropped', result.length === 2, JSON.stringify(result));
  check('valid turns preserved in order', result[0].content === 'valid user turn' && result[1].content === 'valid assistant turn');
}

{
  const withErrors = [
    { role: 'user', content: 'What is the cap?' },
    { role: 'assistant', content: 'ERROR: The AI service failed to produce a usable response.' },
    { role: 'user', content: 'Try again' },
    { role: 'assistant', content: 'Sorry, I encountered an error. Please try again.' },
    { role: 'assistant', content: 'The cap is $50,000.' }
  ];
  const result = sanitizeChatHistory(withErrors);
  check('ERROR-prefixed assistant turns filtered', result.length === 3, JSON.stringify(result));
  check('genuine assistant answer kept', result.some((h) => h.content === 'The cap is $50,000.'));
}

{
  const longTurn = [{ role: 'user', content: 'x'.repeat(5000) }];
  const result = sanitizeChatHistory(longTurn);
  check('per-turn content truncated to 2000 chars', result[0].content.length === 2000, result[0].content.length);
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
