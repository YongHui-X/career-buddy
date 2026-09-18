import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { chromium } from 'playwright-core';

async function loadTs(name) {
  const source = fs.readFileSync(new URL(`../src/lib/apply/${name}.ts`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}

test('live ATS regressions: actual browser DOM', async t => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const { verifyFillDetailed } = await loadTs('diagnose');
    const { finalSubmissionControls } = await loadTs('submit-control');
    await t.test('navigation Apply is not a submit control; ambiguity stays visible', async () => {
      await page.setContent('<button type="button">Apply</button><button type="submit">Submit application</button>');
      assert.equal(await finalSubmissionControls(page.mainFrame()).count(), 1);
      assert.equal(await finalSubmissionControls(page.mainFrame()).getAttribute('type'), 'submit');
      await page.setContent('<button type="button">Apply</button>');
      assert.equal(await finalSubmissionControls(page.mainFrame()).count(), 0);
      await page.setContent('<button>Submit application</button><button>Submit application</button>');
      assert.equal(await finalSubmissionControls(page.mainFrame()).count(), 2);
    });
    await t.test('phone formatting is equivalent but changed digits are rejected', async () => {
      await page.setContent('<input type="tel" data-co-field="phone" value="9733 2464">');
      const fields = [{ id: 'phone', type: 'text', label: 'Phone', required: true }];
      assert.equal((await verifyFillDetailed(page.mainFrame(), fields, { phone: '97332464' })).outcomes[0].status, 'verified');
      assert.equal((await verifyFillDetailed(page.mainFrame(), fields, { phone: '97332465' })).outcomes[0].status, 'mismatch');
    });
    await t.test('country uses observed flag identity, not shared dial code', async () => {
      await page.setContent('<div class="select__control"><div class="select__single-value"><div class="iti__flag iti__sg"></div><span>+65</span></div><input data-co-field="country"></div>');
      const fields = [{ id:'country', type:'select', combobox:true, label:'Country', required:true }];
      assert.equal((await verifyFillDetailed(page.mainFrame(), fields, { country:'Singapore' })).outcomes[0].status, 'verified');
      assert.equal((await verifyFillDetailed(page.mainFrame(), fields, { country:'Malaysia' })).outcomes[0].status, 'mismatch');
    });
    await t.test('removed file input needs matching verified upload and visible receipt', async () => {
      await page.setContent('<div role="group" aria-labelledby="upload-label-resume"><div class="file-upload__filename"><p>resume.pdf</p></div></div><input data-co-field="co5" value="https://linkedin.com/in/example">');
      const file = { id:'missing-co5', nativeId:'resume', label:'Resume/CV', type:'file', required:true, uploadedFileName:'resume.pdf' };
      assert.equal((await verifyFillDetailed(page.mainFrame(), [file], {})).outcomes[0].status, 'verified');
      assert.equal((await verifyFillDetailed(page.mainFrame(), [{...file, uploadedFileName:'other.pdf'}], {})).outcomes[0].status, 'unverified');
      assert.equal((await verifyFillDetailed(page.mainFrame(), [{...file, uploadedFileName:undefined}], {})).outcomes[0].status, 'unverified');
    });
  } finally { await browser.close(); }
});
