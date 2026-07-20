// Downloads real contract exhibits from SEC EDGAR and saves them as clean .txt
// files you can upload to the app for manual testing.
//
// EDGAR is public-domain US government data — free to download and use.
// SEC requires a descriptive User-Agent with contact info; be polite about rate
// limits (they ask for <10 req/sec; this script sleeps between fetches).
//
// Usage:  node fetch-contracts.js ["search phrase"] [count]

const fs = require('fs');
const path = require('path');

const UA = 'ContractAI-testing parthchallawar31@gmail.com';
const OUT_DIR = __dirname;
const query = process.argv[2] || 'master services agreement';
const wanted = Number(process.argv[3] || 5);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// EDGAR exhibits are HTML; strip to readable text while keeping paragraph breaks
// so the app's clause-aware chunker still has structure to work with.
function htmlToText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#8217;|&rsquo;/gi, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&#8212;|&mdash;/gi, '—')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.trim()).join('\n')
    .trim();
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}

(async () => {
  console.log(`Searching EDGAR for: "${query}"\n`);
  const searchUrl = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${query}"`)}`;
  const res = await fetch(searchUrl, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`EDGAR search failed: ${res.status}`);
  const data = await res.json();
  const hits = (data.hits && data.hits.hits) || [];
  if (!hits.length) throw new Error('No results.');

  let saved = 0;
  const seenCompanies = new Set();
  for (const hit of hits) {
    if (saved >= wanted) break;

    // _id is "<accession-with-dashes>:<filename>"
    const [accession, filename] = String(hit._id).split(':');
    const src = hit._source || {};
    const company = (src.display_names || ['unknown'])[0].replace(/\s*\(.*?\)\s*/g, '').trim();
    const cik = (src.ciks || [])[0];
    if (!accession || !filename || !cik) continue;

    // One document per company — EDGAR returns the same exhibit refiled many
    // times, which would otherwise overwrite itself and give you 4 copies.
    const companyKey = slug(company);
    if (seenCompanies.has(companyKey)) continue;

    const accNoDashes = accession.replace(/-/g, '');
    const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accNoDashes}/${filename}`;

    try {
      await sleep(400); // be polite to SEC
      const docRes = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!docRes.ok) { console.log(`  skip (${docRes.status}) ${url}`); continue; }
      const html = await docRes.text();
      const text = htmlToText(html);

      // Skip stubs and giant filings that aren't really a single contract.
      if (text.length < 3000) { console.log(`  skip (too short: ${text.length}) ${company}`); continue; }

      // The whole point is exercising monetary extraction and grounding, so a
      // contract with no dollar figures isn't a useful test document.
      const money = (text.match(/\$\s?[\d,]+/g) || []).length;
      if (money < 3) { console.log(`  skip (only ${money} amounts) ${company}`); continue; }

      seenCompanies.add(companyKey);
      const name = `${slug(company)}-${slug(src.file_type || 'exhibit')}.txt`;
      fs.writeFileSync(path.join(OUT_DIR, name), text, 'utf8');
      saved++;
      console.log(`  saved ${name}`);
      console.log(`        ${(text.length / 1000).toFixed(0)}k chars · ${money} dollar amounts · ${src.file_type} · ${src.file_date}`);
    } catch (err) {
      console.log(`  error on ${company}: ${err.message}`);
    }
  }

  console.log(`\nDone — ${saved} contract(s) in:\n  ${OUT_DIR}\nUpload them at http://localhost:8080`);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
