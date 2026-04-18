// ============================================================
// Meal Wizard — TypeScript Interfaces
// Matches the Firestore data model from the spec (Section 8)
// ============================================================

/** A single ingredient with quantity, unit, and optional inline notes */
export interface Ingredient {
  name: string;
  quantity: number;
  unit: string; // g, ml, cups, tsp, tbsp, etc.
  notes?: string; // e.g. "minced", "or substitute garlic powder"
}

/** A named group of ingredients (e.g. "For the sauce", "For the marinade") */
export interface IngredientGroup {
  name: string; // empty string for the default/unnamed group
  ingredients: Ingredient[];
}

/** Nutritional information per serving */
export interface Nutrition {
  calories: number;
  protein: number; // grams
  carbs: number;   // grams
  fat: number;     // grams
}

/** A fully scraped and parsed recipe (root-level collection) */
export interface Recipe {
  id?: string;
  title: string;
  sourceUrl: string;
  prepTime: string;         // e.g. "15 min"
  cookTime: string;         // e.g. "30 min"
  totalTime?: string;       // e.g. "45 min" — from wprm-recipe-total_time-*
  originalServings: number;
  course?: string[];        // WPRM course taxonomy e.g. ["Main Course", "Dinner"]
  description?: string;     // Short blurb from wprm-recipe-summary
  cuisine?: string;         // e.g. "Italian", "Asian"
  difficulty?: string;      // e.g. "Easy", "Medium"
  ingredients: Ingredient[];
  ingredientGroups?: IngredientGroup[]; // WPRM grouped ingredients (if present)
  instructions: string[];
  notes: string;
  nutrition: Nutrition;
  scrapedAt: Date;
}

/** Household document */
export interface Household {
  members: string[];      // array of user UIDs
  inviteCode: string;
}

/** User profile (lightweight, for household lookup) */
export interface UserProfile {
  email: string;
  householdId: string;
}

/** Meal type options */
export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'side';

/** A single meal plan entry */
export interface MealPlanEntry {
  id?: string;            // document ID: "{date}_{mealType}" e.g. "2025-07-14_dinner"
  recipeId: string;
  date: string;           // ISO date string: "2025-07-14"
  mealType: MealType;
}

/** A single shopping list item */
export interface ShoppingItem {
  id?: string;
  name: string;
  quantity: number;
  unit: string;
  category: ShoppingCategory;
  checked: boolean;
  manual: boolean;        // true if manually added by user
  /** Recipes this ingredient was sourced from (populated during aggregation) */
  sources?: { id: string; title: string }[];
}

/** Shopping list aisle categories */
export type ShoppingCategory =
  | 'Produce'
  | 'Meat & Seafood'
  | 'Dairy & Eggs'
  | 'Herbs & Spices'
  | 'Oils, Sauces & Condiments'
  | 'Pantry & Dry Goods'
  | 'Frozen'
  | 'Bread & Bakery'
  | 'Other';

/** Cookbook entry (household subcollection) */
export interface CookbookEntry {
  id?: string;            // same as recipeId
  recipeId: string;
  starred: boolean;
  addedAt: Date;
}

/** Cuisine/style options for the generator */
export type CuisineStyle =
  | 'Quick & Easy'
  | 'Moderate'
  | 'Vegetarian'
  | 'Kid Friendly'
  | 'Asian'
  | 'Mexican'
  | 'Mediterranean'
  | 'Healthy'
  | 'Salad'
  | 'Custom';

/** Per-household generation settings (stored in Firestore) */
export interface HouseholdSettings {
  /** Site domain → weight multiplier. 0 = disabled, default 1 if absent. */
  sourceWeights: Record<string, number>;
  /** Ingredient name → weight multiplier. Default 1 if absent. */
  ingredientWeights: Record<string, number>;
}

/** Generator input configuration */
export interface GeneratorConfig {
  numberOfDays: number;
  customDateRange?: { startDate: string; endDate: string };
  adults: number;
  children: number;
  mealTypes: MealType[];
  cuisineStyles: CuisineStyle[];
  customInstructions?: string;
}
