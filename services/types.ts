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

/** A single instruction step. May have an inline image (from JSON-LD HowToStep.image
 *  or recipe-card HTML), an inline video (from JSON-LD HowToStep.video.embedUrl),
 *  or be a section header flattened from a HowToSection wrapper. */
export interface InstructionStep {
  text: string;
  imageUrl?: string;
  videoEmbedUrl?: string;
  isHeader?: boolean;
}

/** A fully scraped and parsed recipe (root-level collection) */
export interface Recipe {
  id?: string;
  title: string;
  sourceUrl: string;
  imageUrl?: string;        // hero image URL extracted from JSON-LD / og:image
  videoEmbedUrl?: string;   // hero overview video (Vimeo/YouTube embed URL); replaces banner image when present
  prepTime: string;         // e.g. "15 min"
  cookTime: string;         // e.g. "30 min"
  totalTime?: string;       // e.g. "45 min" — from wprm-recipe-total_time-*
  originalServings: number;
  course?: string[];        // WPRM course taxonomy e.g. ["Main Course", "Dinner"]
  tags?: string[];          // Gemini-assigned labels: CuisineStyle values + course names
  description?: string;     // Short blurb from wprm-recipe-summary
  cuisine?: string;         // e.g. "Italian", "Asian"
  difficulty?: string;      // e.g. "Easy", "Medium"
  ingredients: Ingredient[];
  ingredientGroups?: IngredientGroup[]; // WPRM grouped ingredients (if present)
  instructions: InstructionStep[];
  notes: string;
  nutrition: Nutrition;
  /** True if recipe's main protein typically needs defrosting (Gemini-detected at confirm time). */
  needsDefrost?: boolean;
  /** True if recipe requires ≥30 min refrigerated marinating (Gemini-detected at confirm time). */
  needsMarinate?: boolean;
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
  servings?: number;      // household-adjusted serving count used when this meal was confirmed
  adults?: number;        // adults at confirm time
  children?: number;      // children at confirm time
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
  sources?: { id: string; title: string; servings?: number }[];
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
  | 'Drinks & Beverages'
  | 'Personal Care'
  | 'Household & Cleaning'
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
  | 'Healthy'
  | 'Asian'
  | 'Mexican'
  | 'Mediterranean'
  | 'Italian'
  | 'Indian'
  | 'Salad'
  | 'Custom';

/** Kid Friendly filter overrides (stored inside HouseholdSettings) */
export interface KidFriendlySettings {
  /** Extra ingredient name fragments to block (added to the default list). */
  excludedIngredients?: string[];
  /** Ingredient name fragments from the default block list to allow through. */
  allowedExceptions?: string[];
  /** Max number of ingredients a recipe may have. Default 20. */
  maxIngredients?: number;
}

/** Per-household generation settings (stored in Firestore) */
export interface HouseholdSettings {
  /** Site domain → weight multiplier. 0 = disabled, default 1 if absent. */
  sourceWeights: Record<string, number>;
  /** Ingredient name → weight multiplier. Default 1 if absent. */
  ingredientWeights: Record<string, number>;
  /** Ingredient names selected for strict round-robin slot assignment. */
  selectedSeeds?: string[];
  /** Customisations to the Kid Friendly ingredient filter. */
  kidFriendly?: KidFriendlySettings;
  /** Per-household reminder preferences for defrost / marinate notifications. */
  mealReminders?: {
    defrostEnabled: boolean;
    marinateEnabled: boolean;
    /** "HH:MM" 24-hour, e.g. "07:30" */
    morningTime: string;
    /** "HH:MM" 24-hour, e.g. "19:30" */
    eveningTime: string;
  };
  /** Preselected number of adults when launching generate tab. Default 2. */
  defaultAdults?: number;
  /** Preselected number of children when launching generate tab. Default 2. */
  defaultChildren?: number;
  /** Automatically regenerate mismatched meals until all criteria are met. Default true. */
  strictMatching?: boolean;
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

/** A single meal in a generated plan (pre-confirmation) */
export interface GeneratedMeal {
  recipe: Recipe;
  recipeId: string;
  /** ISO date string: "2025-07-14" */
  date: string;
  mealType: MealType;
  isFromFavourites: boolean;
  servings: number;
}

/** Configuration for a generation run */
export interface GenerateConfig {
  /** First day of the plan (should be the next Monday). */
  startDate: Date;
  numberOfDays: number;
  adults: number;
  children: number;
  mealTypes: MealType[];
  cuisineStyles: CuisineStyle[];
  customInstructions?: string;
  settings?: HouseholdSettings;
}
