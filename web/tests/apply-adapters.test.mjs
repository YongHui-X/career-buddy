import test from "node:test";
import assert from "node:assert/strict";
import { applyAdapterDefinition, detectApplyVendor } from "../src/lib/apply/adapters-core.mjs";

test("detects supported ATS only on exact domains or subdomains", () => {
  assert.equal(detectApplyVendor("https://boards.greenhouse.io/acme/jobs/1"), "greenhouse");
  assert.equal(detectApplyVendor("https://jobs.lever.co/acme/1"), "lever");
  assert.equal(detectApplyVendor("https://jobs.ashbyhq.com/acme/1/application"), "ashby");
  assert.equal(detectApplyVendor("https://apply.workable.com/acme/j/1"), "workable");
  assert.equal(detectApplyVendor("https://acme.wd5.myworkdayjobs.com/jobs/job/1"), "workday");
  assert.equal(detectApplyVendor("https://greenhouse.io.evil.example/apply"), "generic");
  assert.equal(detectApplyVendor("https://notlever.co/jobs/1"), "generic");
});

test("adapter capabilities preserve submission policy and vendor input strategy", () => {
  assert.equal(applyAdapterDefinition("https://apply.workable.com/acme").textEntry, "type");
  assert.equal(applyAdapterDefinition("https://acme.myworkdayjobs.com/jobs").multiStep, true);
  assert.equal(applyAdapterDefinition("https://linkedin.com/jobs/view/1").submission, false);
  assert.equal(applyAdapterDefinition("https://jobs.ashbyhq.com/acme").submission, true);
});
