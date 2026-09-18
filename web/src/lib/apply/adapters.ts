import { applyAdapterDefinition, detectApplyVendor } from "./adapters-core.mjs";

export type ApplyVendor = "greenhouse" | "lever" | "ashby" | "workable" | "workday" | "linkedin" | "indeed" | "glassdoor" | "jobstreet" | "mycareersfuture" | "generic";

export type AdapterCapability = {
  vendor: ApplyVendor;
  submission: boolean;
  multiStep: boolean;
  accountMayBeRequired: boolean;
  textEntry: "fill" | "type";
  operations: readonly ["detect", "open", "enumerateSteps", "extractFields", "fill", "upload", "verify", "submit", "detectReceipt"];
};

export function detectVendor(value: string): ApplyVendor {
  return detectApplyVendor(value) as ApplyVendor;
}

export function adapterFor(value: string): AdapterCapability {
  return applyAdapterDefinition(value) as unknown as AdapterCapability;
}
