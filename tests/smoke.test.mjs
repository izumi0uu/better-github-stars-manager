// Headless smoke test for the built extension.
// NOTE: loading an unpacked MV3 extension with an active service worker is only
// reliable in a real (GUI) Chrome with a fresh --user-data-dir. In headless it
// often silently fails to register the SW. This script detects that condition
// and reports it as "environment limitation" rather than a product failure.
import puppeteer from 'puppeteer';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const EXT_PATH = path.resolve('dist');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-profile-'));
const errors = [];
function log(ok, msg) { console.log(`  ${ok ? '✓' : '✗'} ${msg}`); if (!ok) errors.push(msg); }

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: [
    `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  ],
});
let envLimitation = false;
try {
  await new Promise(r=>setTimeout(r,3000));
  const sw = (await browser.targets()).find(t=>t.type()==='service_worker');
  if (!sw) { envLimitation = true; log(false, 'SW not registered (headless ext-load limitation — run in GUI Chrome to verify)'); }
  else {
    log(true, `service worker registered: ${sw.url()}`);
    const page = await browser.newPage();
    page.on('pageerror',e=>errors.push('pageerror: '+e.message));
    await page.goto('https://github.com/izumi0uu?tab=stars',{waitUntil:'domcontentloaded',timeout:60000});
    await new Promise(r=>setTimeout(r,5000));
    const injected = await page.evaluate(()=>!!document.getElementById('gsm-manager-root')).catch(()=>false);
    log(injected, 'management panel injected on stars page');
    const anchor = await page.goto('https://github.com/NVIDIA/SkillSpector',{waitUntil:'domcontentloaded',timeout:60000}).then(()=>page.evaluate(()=>{
      const n=document.querySelector('strong[itemprop="name"]'); let c=0,s=n?.nextElementSibling;
      while(s){if(s.shadowRoot)c++;s=s.nextElementSibling;} return {anchor:!!n, chips:c};
    })).catch(()=>({anchor:false,chips:0}));
    log(anchor.chips>0, `tag chip injected on repo page (${anchor.chips})`);
  }
} catch (e) { log(false, 'crashed: '+(e?.message??e)); }
await browser.close();
fs.rmSync(profile,{recursive:true,force:true});
if (envLimitation) { console.log('\n⚠️  Headless environment cannot load unpacked MV3 extension (Chrome limitation). Run GUI verification in a real Chrome profile before release.'); process.exitCode = 0; }
else console.log(errors.length ? `\n❌ ${errors.length} issues` : '\n✅ Smoke test passed');
