import { describe, expect, it } from "vitest";
import { trustedImportUrl } from "../src/connected/importRecipe.js";
describe("trusted direct recipe imports", () => {
  it("allows and canonicalises a supported HTTPS recipe", () => {
    expect(
      trustedImportUrl(
        "https://www.recipetineats.com/chicken/?utm_source=email",
      ),
    ).toContain("recipetineats.com/chicken");
  });
  it.each([
    "http://www.recipetineats.com/chicken/",
    "https://localhost/recipe",
    "https://127.0.0.1/recipe",
    "https://recipetineats.com.attacker.test/recipe",
    "https://user:password@www.recipetineats.com/chicken/",
    "https://www.recipetineats.com:444/chicken/",
  ])("rejects untrusted transport or host: %s", (url) => {
    expect(() => trustedImportUrl(url)).toThrow();
  });
});
