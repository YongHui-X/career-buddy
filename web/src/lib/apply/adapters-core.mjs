const OPERATIONS = ["detect", "open", "enumerateSteps", "extractFields", "fill", "upload", "verify", "submit", "detectReceipt"];

const DEFINITIONS = {
  greenhouse: { submission: true, multiStep: false, accountMayBeRequired: false, textEntry: "fill" },
  lever: { submission: true, multiStep: false, accountMayBeRequired: false, textEntry: "fill" },
  ashby: { submission: true, multiStep: false, accountMayBeRequired: false, textEntry: "fill" },
  workable: { submission: true, multiStep: true, accountMayBeRequired: true, textEntry: "type" },
  workday: { submission: true, multiStep: true, accountMayBeRequired: true, textEntry: "type" },
  linkedin: { submission: false, multiStep: true, accountMayBeRequired: true, textEntry: "fill" },
  indeed: { submission: false, multiStep: true, accountMayBeRequired: true, textEntry: "fill" },
  glassdoor: { submission: false, multiStep: true, accountMayBeRequired: true, textEntry: "fill" },
  jobstreet: { submission: false, multiStep: true, accountMayBeRequired: true, textEntry: "fill" },
  mycareersfuture: { submission: false, multiStep: true, accountMayBeRequired: true, textEntry: "fill" },
  generic: { submission: false, multiStep: true, accountMayBeRequired: true, textEntry: "fill" },
};

function isDomain(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

export function detectApplyVendor(value) {
  let host = "";
  try { host = new URL(value).hostname.toLowerCase().replace(/\.$/, ""); } catch { return "generic"; }
  if (isDomain(host, "greenhouse.io")) return "greenhouse";
  if (isDomain(host, "lever.co")) return "lever";
  if (isDomain(host, "ashbyhq.com")) return "ashby";
  if (isDomain(host, "workable.com")) return "workable";
  if (isDomain(host, "myworkdayjobs.com") || isDomain(host, "myworkdaysite.com") || isDomain(host, "workday.com")) return "workday";
  if (isDomain(host, "linkedin.com")) return "linkedin";
  if (isDomain(host, "indeed.com") || [...host.matchAll(/(?:^|\.)(indeed\.[a-z.]+)$/g)].length) return "indeed";
  if (isDomain(host, "glassdoor.com") || host.includes(".glassdoor.")) return "glassdoor";
  if (isDomain(host, "jobstreet.com") || host.includes(".jobstreet.")) return "jobstreet";
  if (isDomain(host, "mycareersfuture.gov.sg")) return "mycareersfuture";
  return "generic";
}

export function applyAdapterDefinition(value) {
  const vendor = detectApplyVendor(value);
  return { vendor, ...DEFINITIONS[vendor], operations: OPERATIONS };
}

