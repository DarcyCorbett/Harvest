# Meal Wizard — App Build Specification
### Version 1.0 | Planning Document

---

## SECTION 1: PROJECT OVERVIEW

**App Name:** Meal Wizard
**Platform:** Android (native mobile app via React Native or Flutter)
**Users:** Two people (a couple) sharing a private, invite-only app instance
**Backend:** Firebase (Firestore database, Firebase Auth)
**AI Integration:** Google Gemini API (for recipe scraping, parsing, and formatting)
**Goal:** A private intelligent meal planning app that fetches real recipes from trusted food websites, generates weekly meal plans, builds smart shopping lists, and maintains a personal cookbook — all synced in real time between two users.

---

## SECTION 2: AUTHENTICATION & SHARING

- Authentication uses **Firebase Auth with a shared invite/access-code approach**: the app is protected by a fixed invite code or a shareable deep link. Only users who have this code/link can create an account.
- Each user has their own account (email + password), but both accounts share the **same household data** (meal plans, shopping lists, cookbook) via a shared `householdId` in Firestore.
- The first user to register creates the household and receives a shareable invite link/code. The second user registers using that invite code to join the same household.
- All Firestore data is scoped to `households/{householdId}/...` so both users read and write to the same data.
- The shopping list must support **real-time sync**: if one user crosses off an item, the other sees it crossed off instantly (use Firestore real-time listeners).

---

## SECTION 3: TECH STACK RECOMMENDATION

| Layer | Technology |
|---|---|
| Mobile Framework | React Native (Expo) — easiest for a single developer to build and share |
| Database | Firebase Firestore |
| Auth | Firebase Authentication |
| AI/Scraping | Google Gemini API (gemini-2.5-flash-preview) |
| Hosting/Distribution | Expo Go for testing; EAS Build for distributing an APK to install on Android |
| Real-time Sync | Firestore onSnapshot listeners |

---

## SECTION 4: APP STRUCTURE — 4 TABS

### Tab 1: Home (Calendar)
### Tab 2: Generate
### Tab 3: Shopping List
### Tab 4: Cookbook

Navigation: Bottom tab bar (Android-native style).

---

## SECTION 5: FEATURE SPECIFICATIONS

---

### 5.1 HOME TAB — Meal Calendar

**Purpose:** View all planned meals laid out on a calendar.

**Views:**
- Toggle between **Weekly view** and **Monthly view**
- All days are visible, even if no meal is scheduled (empty days show as blank slots)
- Swipe/scroll to navigate between weeks or months

**Recipe Tap:**
When a user taps a recipe on the calendar, a full-screen modal or detail page opens showing:
- Recipe name and source website link (credit)
- Prep time & cook time
- Servings (as adjusted for the household)
- Macronutrients per serve: Calories, Protein (g), Carbs (g), Fat (g)
- Full ingredients list (metric: grams, ml, cups)
- Step-by-step instructions
- Notes (if any from the original recipe)

**Meal Types per Day:**
Each calendar day can have up to 3 meals: Breakfast, Lunch, Dinner. Each is shown as a separate card/chip on that day.

---

### 5.2 GENERATE TAB — Meal Planner

**Purpose:** Configure and generate a new batch of recipes using AI + recipe scraping.

#### Input Controls:

**A) Number of Days**
- Dropdown with options: 1, 2, 3, 4, 5 (default), 6, 7, 8, 9, 10, 11, 12, 13, 14, "Custom Date Range"
- When "Custom Date Range" is selected: show a Start Date and End Date picker (hidden otherwise)

**B) Servings**
- Input for number of adults (default: 2)
- Input for number of children (default: 2)
- Rule: children count as 0.5 adult portions when calculating recipe scaling

**C) Meal Types (checkboxes — multiple allowed)**
- [ ] Breakfast
- [ ] Lunch
- [x] Dinner (default selected)

**D) Cuisine / Style Guidelines (multi-select chips or multi-select dropdown)**
- Quick & Easy
- Moderate
- Vegetarian
- Kid Friendly
- Asian
- Mexican
- Mediterranean
- Custom *(when selected, show a free text input field for custom instructions e.g. "high protein", "dairy free", "keto")*

#### Scheduling Logic:
- Generated meals always start on the **next Monday** after the generation date.
  - Example: If generated on a Thursday, meals start the following Monday.
- Each day/meal combination generates one recipe.
  - Example: If Breakfast + Dinner selected for 3 days = 6 recipes total, placed Mon-Wed.

#### Generation Process:
1. User configures inputs and taps **"Generate Meal Plan"**
2. App shows step-by-step loading messages during generation, e.g.:
   - "Searching for the perfect recipes..."
   - "Scraping and reading recipes..."
   - "Adjusting portions for your family..."
   - "Building your meal plan..."
3. Results are displayed as a list of recipe cards (NOT yet added to calendar)

#### Post-Generation Review:
- Each generated recipe card has a **checkbox** to select it
- A **"Regenerate Selected"** button re-runs generation only for checked recipes
  - Regeneration uses whatever inputs are currently set — user can change cuisine/style before regenerating
- An **"Add to Calendar"** button confirms and saves all recipes to the calendar and shopping list

---

### 5.3 RECIPE SCRAPING — Technical Detail

**Trusted Recipe Sources (scrape ONLY from these):**
1. www.recipetineats.com
2. www.seriouseats.com
3. www.budgetbytes.com
4. thewoksoflife.com
5. omnivorescookbook.com
6. www.themediterraneandish.com
7. www.spendwithpennies.com
8. akispetretzikis.com/en

**Scraping Strategy using Gemini API:**
1. Use Gemini to search within the trusted site list for a recipe matching the requested criteria (cuisine, meal type, guidelines).
2. Fetch the raw HTML of the recipe page.
3. Pass the HTML to Gemini with a prompt to extract and return structured JSON containing: title, source URL, prep time, cook time, servings (original), ingredients (list of {name, quantity, unit}), instructions (ordered list), notes, nutrition per serve (calories, protein, carbs, fat).
4. If a site's HTML is not parseable or Gemini cannot extract a valid recipe, skip that site and try the next.
5. All measurements must be standardized to metric (grams, ml) or cups where appropriate.

**Caching:**
- Once a recipe has been successfully scraped and parsed, save it to Firestore under `recipes/{recipeId}` so it is never scraped again.
- When the same recipe is needed again, load from Firestore cache.

**Portion Scaling:**
- Scale ingredient quantities from the original recipe's serving count to the household's required serving count.
- Formula: `scaled_quantity = (original_quantity / original_servings) * required_servings`
- Required servings = adults + (children × 0.5), rounded up to nearest 0.5.

---

### 5.4 SHOPPING LIST TAB

**Purpose:** Aggregated, real-time shopping list from all confirmed calendar meals.

**Features:**
- All ingredients from all planned (future) meals are combined into a single master list.
- Duplicate ingredients are merged (e.g., 200g onion + 150g onion = 350g onion).
- Ingredients are grouped by **supermarket aisle category**:
  - Produce (fruit & vegetables)
  - Meat & Seafood
  - Dairy & Eggs
  - Pantry & Dry Goods
  - Frozen
  - Bread & Bakery
  - Other
- Each item can be **tapped to toggle as "crossed off"** (strikethrough style)
- Real-time sync: crossing off an item updates Firestore instantly, both users see it live
- **"+ Add Item"** button to manually add custom items (e.g., "Paper Towels", "Milk")
- **"Clear Purchased"** button removes all checked/crossed-off items from the list

---

### 5.5 COOKBOOK TAB

**Purpose:** Personal archive of all recipes ever added to the household's meal plans.

**Features:**

**Library:**
- All recipes ever added to the calendar are permanently saved in the Cookbook.
- Toggle between **Grid view** (recipe cards with image/thumbnail from source) and **List view** (compact rows).
- **Search bar** to filter recipes by keyword (name, cuisine, ingredient).

**Star / Favourites System:**
- Every recipe has a ⭐ star button.
- Starred recipes appear in a **"Favourites"** filtered view within the Cookbook.

**Smart Favourites Loop (automatic behaviour in Generator):**
- When generating a new meal plan, if the household has **more than 10 starred recipes**, the generator will automatically and randomly include **1 to 3 starred recipes** woven into the new plan.
- These are mixed in alongside newly scraped recipes so the user always has a blend of familiar favourites and new discoveries.
- The selected favourites are chosen randomly each time to avoid repetition.

---

## SECTION 6: RECIPE CARD UI STANDARD

No matter what website a recipe is scraped from, every recipe must be displayed in a **consistent, clean card format** — stripping away all ads, life stories, and blog content. The standardised recipe card contains:

| Field | Details |
|---|---|
| Recipe Name | Large heading |
| Source | Smaller text link back to original URL (for credit) |
| Prep Time | e.g., "15 min" |
| Cook Time | e.g., "30 min" |
| Servings | As adjusted for household |
| Nutrition (per serve) | Calories / Protein / Carbs / Fat — shown as 4 badge chips |
| Ingredients | Bulleted list, metric units (g, ml, cups) |
| Instructions | Numbered steps |
| Notes | If present on original recipe |

---

## SECTION 7: UX / DESIGN REQUIREMENTS

- **Theme:** Support Light Mode and Dark Mode, auto-matching the device system preference.
- **Loading states:** All AI generation steps show descriptive, friendly loading messages (not just a spinner).
- **Responsive:** Designed for Android phones; comfortable on both small and large screens.
- **Bottom navigation:** 4-tab bottom bar with icons and labels: Home, Generate, Shopping, Cookbook.

---

## SECTION 8: FIRESTORE DATA MODEL

```
households/
  {householdId}/
    members: [userId1, userId2]
    inviteCode: "ABC123"

    mealPlan/
      {date_mealtype}/         e.g. "2025-07-14_dinner"
        recipeId: string
        date: timestamp
        mealType: "breakfast" | "lunch" | "dinner"

    shoppingList/
      {itemId}/
        name: string
        quantity: number
        unit: string
        category: string
        checked: boolean
        manual: boolean        // true if manually added by user

    cookbook/
      {recipeId}/
        starred: boolean
        addedAt: timestamp

recipes/
  {recipeId}/
    title: string
    sourceUrl: string
    prepTime: string
    cookTime: string
    originalServings: number
    ingredients: [{name, quantity, unit}]
    instructions: [string]
    notes: string
    nutrition: {calories, protein, carbs, fat}
    scrapedAt: timestamp
```

---

## SECTION 9: PHASED BUILD GUIDE

---

### Phase 1 — Project Scaffold & Authentication

> Using the specification above, begin building Phase 1 only. Do not build any features beyond what is listed here.
>
> **Tasks:**
> 1. Initialise a new React Native project using Expo (TypeScript template).
> 2. Install and configure Firebase (Auth + Firestore). Use environment variables via a `.env` file for all Firebase config keys and the Gemini API key — never hardcode them.
> 3. Set up the bottom tab navigator with 4 placeholder screens: Home, Generate, Shopping List, Cookbook. Each screen should just show its name as a text label for now.
> 4. Build the Authentication flow: Login screen and Register screen. Registration requires an invite code. The first user to register creates a new household document in Firestore and receives their generated invite code on screen. A second user can register using an existing invite code to join that household.
> 5. On successful login, navigate to the main tab navigator. On logout, return to the Login screen.
> 6. Persist the auth session so the user does not have to log in again on app restart.
>
> **Definition of done:** I can install the app, register as User 1, see my invite code, register as User 2 using that code, and both accounts are linked to the same `householdId` in Firestore. The 4 placeholder tabs are visible after login.

---

### Phase 2 — Firestore Data Layer & Navigation Shell

> The Phase 1 scaffold is complete. Now build Phase 2. Do not build any UI features yet — this phase is purely data and navigation infrastructure.
>
> **Tasks:**
> 1. Create a Firestore service module that encapsulates all database reads and writes. All other parts of the app must use this module — no direct Firestore calls scattered in components.
> 2. Implement the full data model from Section 8 of the spec: households, mealPlan, shoppingList, cookbook, and the root-level recipes collection.
> 3. Set up a React Context (or Zustand store) for global app state: current user, householdId, and household data.
> 4. Write and test the following Firestore operations (with console output to verify):
>    - Save a recipe to `recipes/{recipeId}`
>    - Add a meal plan entry to `households/{householdId}/mealPlan/`
>    - Add an item to `households/{householdId}/shoppingList/`
>    - Toggle an item's `checked` field in the shopping list
>    - Add a recipe to `households/{householdId}/cookbook/` and toggle its `starred` field
> 5. Set up Firestore security rules so only authenticated members of a household can read/write their household's data.
>
> **Definition of done:** All Firestore operations work correctly and are verified. Security rules are in place. Global state context is available throughout the app.

---

### Phase 3 — Recipe Scraping Service (Gemini Integration)

> Phases 1 and 2 are complete. Now build Phase 3 — the recipe scraping engine. This is the core AI feature of the app and must be built and tested in isolation before being wired into the UI.
>
> **Tasks:**
> 1. Build a `RecipeScraperService` module. This is a standalone service — no UI yet.
> 2. The service takes as input: meal type (breakfast/lunch/dinner), cuisine/style guidelines, and number of servings required.
> 3. It uses the Gemini API (model: `gemini-3-flash-preview`) to identify a suitable recipe URL from the trusted site list defined in Section 5.3.
> 4. It fetches the raw HTML of that URL.
> 5. It passes the HTML to Gemini with a structured prompt to extract the recipe as JSON matching the schema in Section 8 (`recipes/{recipeId}` fields).
> 6. It standardises all measurements to metric and scales all ingredient quantities to the requested serving count using the formula in Section 5.3.
> 7. It checks Firestore first — if a matching cached recipe exists, return that instead of scraping again.
> 8. It saves newly scraped recipes to Firestore `recipes/{recipeId}`.
> 9. If a site fails to parse, it silently tries the next trusted site.
> 10. Write a simple test harness (a temporary button on any screen) that calls the service and logs the returned recipe JSON to the console.
>
> **Definition of done:** Tapping the test button returns a valid, fully-populated recipe JSON object for at least 3 different cuisine types. Caching works — the second call for the same recipe returns from Firestore, not from a new scrape.

---

### Phase 4 — Generate Tab

> Phases 1–3 are complete. Now build the Generate Tab UI, wiring it to the scraping service from Phase 3.
>
> **Tasks:**
> 1. Build the full Generate Tab form as specified in Section 5.2: days dropdown (including custom date range with date pickers), adults/children inputs, meal type checkboxes, cuisine multi-select chips, and the custom free-text input that appears when "Custom" is selected.
> 2. Wire the "Generate Meal Plan" button to the RecipeScraperService. Generate one recipe per day/meal-type combination.
> 3. Show step-by-step loading messages during generation (not just a spinner) — one message per recipe being fetched.
> 4. Display the results as a scrollable list of recipe preview cards, each with a checkbox.
> 5. Implement "Regenerate Selected" — re-runs scraping only for checked recipes using the current form settings.
> 6. Implement "Add to Calendar" — saves all generated recipes to Firestore `mealPlan` and triggers shopping list aggregation (write all ingredients to `shoppingList`, merging duplicates by name+unit).
> 7. Apply the scheduling rule: meals start on the next Monday after today.
>
> **Definition of done:** I can configure the form, generate a meal plan, review the results, regenerate individual meals, and add the final plan to the calendar. The Firestore `mealPlan` and `shoppingList` collections are populated correctly after tapping "Add to Calendar".

---

### Phase 5 — Home Tab (Calendar)

> Phases 1–4 are complete. Now build the Home Tab calendar.
>
> **Tasks:**
> 1. Build the calendar view with a toggle between Weekly view and Monthly view.
> 2. All days must be visible even if no meal is scheduled. Empty days show as blank slots.
> 3. Read meal plan data from Firestore in real time (onSnapshot listener). Each day shows up to 3 meal slots (Breakfast, Lunch, Dinner) as labelled chips or cards.
> 4. Tapping a meal opens a Recipe Detail modal as specified in Section 5.1: recipe name, source link, prep/cook time, adjusted servings, macro badge chips (Calories/Protein/Carbs/Fat), metric ingredient list, numbered instructions, and notes.
> 5. The user can swipe or scroll to navigate between weeks/months.
>
> **Definition of done:** Meals added in Phase 4 are visible on the correct days. Tapping any meal shows the full recipe detail. Weekly and monthly views both work correctly.

---

### Phase 6 — Shopping List Tab

> Phases 1–5 are complete. Now build the Shopping List Tab.
>
> **Tasks:**
> 1. Read the household's `shoppingList` collection from Firestore using a real-time listener (onSnapshot) so both users see changes instantly.
> 2. Display items grouped by aisle category as specified in Section 5.4: Produce, Meat & Seafood, Dairy & Eggs, Pantry & Dry Goods, Frozen, Bread & Bakery, Other.
> 3. Tapping an item toggles its `checked` field in Firestore. Show checked items with strikethrough styling.
> 4. Build the "+ Add Item" flow: a modal or inline input where the user types a name (and optionally quantity/unit), then it is saved to Firestore as a manual item.
> 5. Implement "Clear Purchased" — deletes all documents in `shoppingList` where `checked` is true.
>
> **Definition of done:** Both users (logged in on separate devices) see the shopping list update in real time when either one crosses off an item. Manual items can be added and cleared.

---

### Phase 7 — Cookbook Tab

> Phases 1–6 are complete. Now build the Cookbook Tab.
>
> **Tasks:**
> 1. Read all recipes from `households/{householdId}/cookbook/` and join with the corresponding data from the root `recipes/` collection to get full recipe details.
> 2. Display in Grid view (default) with recipe name and a thumbnail/placeholder image. Add a toggle to switch to List view (compact rows with name and cuisine).
> 3. Add a search bar that filters recipes by keyword across name, cuisine, and ingredients.
> 4. Add a ⭐ star button to each recipe. Tapping it toggles the `starred` field in Firestore.
> 5. Add a "Favourites" filter tab/toggle that shows only starred recipes.
> 6. Wire up the Smart Favourites Loop in the GenerateService: when generating a new plan, check if the household has more than 10 starred recipes. If so, randomly select 1–3 of them and include them in the generated plan (skipping the scraper for those slots).
>
> **Definition of done:** All previously added recipes appear in the Cookbook. Starring works. Favourites filter works. When I have 10+ starred recipes and generate a new plan, 1–3 of my favourites are automatically included in the results.

---

### Phase 8 — Polish, Dark Mode & Final Testing

> Phases 1–7 are complete and all features are working. Now polish the app for use.
>
> **Tasks:**
> 1. Implement Light/Dark mode throughout the app, auto-matching the device system preference. Every screen, modal, and component must look correct in both modes.
> 2. Review all loading states — every async operation (scraping, saving, loading data) should show appropriate feedback. No silent waits.
> 3. Add basic error handling with user-friendly messages for: network failures during scraping, Firestore write failures, and invalid invite codes during registration.
> 4. Review the app on a small screen (360px wide) and a large screen (420px wide) and fix any layout issues.
> 5. Generate a production APK using EAS Build so the app can be installed on both Android devices.
>
> **Definition of done:** The app works end-to-end on two Android devices simultaneously. Dark mode looks correct. Errors are handled gracefully. An installable APK is produced.
