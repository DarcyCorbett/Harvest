import { httpsCallable } from "firebase/functions";
import { functions } from "@/config/firebase";
import type {
  BrowseRequest,
  BrowseResponse,
} from "../functions/src/catalogue/browse";
export type {
  BrowseRequest,
  BrowseResponse,
  RecipeSummary,
} from "../functions/src/catalogue/browse";
export async function browseCatalogue(
  request: BrowseRequest,
): Promise<BrowseResponse> {
  const response = await httpsCallable<BrowseRequest, BrowseResponse>(
    functions,
    "browseCatalogueRecipes",
  )(request);
  if (
    !response.data ||
    !Array.isArray(response.data.recipes) ||
    response.data.recipes.length > 20 ||
    response.data.recipes.some(
      (r) => typeof r.id !== "string" || typeof r.title !== "string",
    ) ||
    (response.data.nextCursor !== undefined &&
      typeof response.data.nextCursor !== "string")
  )
    throw new Error("Invalid catalogue response. Please retry.");
  return response.data;
}
