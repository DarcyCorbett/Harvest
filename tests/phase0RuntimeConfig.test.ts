import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const readPackageJson = (path: string) =>
  JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8"));

describe("Phase 0 runtime configuration", () => {
  it("uses Node.js 22 and exposes the complete aggregate verification gate", () => {
    const rootPackage = readPackageJson("package.json");
    const functionsPackage = readPackageJson("functions/package.json");

    expect(functionsPackage.engines.node).toBe("22");
    expect(rootPackage.scripts["verify:phase0"]).toBe(
      "npm run test:functions && npm run build:functions && npm run test:client && npm run test:rules && npm run lint && tsc --noEmit && npm run scan:client-secrets",
    );
  });
});
