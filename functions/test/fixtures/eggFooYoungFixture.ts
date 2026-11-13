export const EGG_FOO_YOUNG_JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Recipe",
      "name": "Egg Foo Young (Chinese omelette)",
      "recipeYield": "4 servings",
      "prepTime": "PT10M",
      "cookTime": "PT15M",
      "totalTime": "PT25M",
      "recipeIngredient": [
        "4 tsp cornflour / corn starch",
        "1 1/2 tbsp light soy sauce (, or all purpose (Note 2))",
        "2 tsp Oyster Sauce",
        "1 tbsp Chinese Cooking Wine  ((shaoxing wine) OR Mirin (Note 3))",
        "1/2 tsp sesame oil",
        "1 cup / 250 ml  water",
        "Dash of white pepper",
        "6  eggs",
        "2 cups bean sprouts ((just eyeball it))",
        "4  shallots/green onions (, white part only, sliced)",
        "Salt and white pepper",
        "2 tbsp vegetable oil",
        "1 tsp sesame oil",
        "1  garlic clove (, finely chopped)",
        "ONE Filling of Choice, below (Prawn or Pork)",
        "100 - 120g/3.5 - 4 oz   chopped raw small prawns/shrimp (, peeled and deveined (Note 4))",
        "100 - 120g/3.5 - 4 oz   ground/mince pork ((or chicken, turkey, beef or veal))",
        "1/2 tsp EACH soy sauce and Oyster Sauce",
        "1/4 tsp sugar",
        "Dash of sesame oil",
        "Sesame seeds, sliced green onion"
      ],
      "recipeInstructions": [
        {
          "@type": "HowToStep",
          "text": "Mix Sauce ingredients in a small saucepan."
        }
      ]
    }
  ]
};

export const EGG_FOO_YOUNG_DOM_HTML = `
<script type="application/ld+json">${JSON.stringify(EGG_FOO_YOUNG_JSON_LD)}</script>
<div class="wprm-recipe-container">
  <div class="wprm-recipe-ingredients-container">
    <div class="wprm-recipe-ingredient-group">
      <h4 class="wprm-recipe-group-name wprm-recipe-ingredient-group-name">Sauce (Note 1 for Charlie option):</h4>
      <ul class="wprm-recipe-ingredients">
        <li class="wprm-recipe-ingredient"><span class="wprm-recipe-ingredient-amount">4</span> <span class="wprm-recipe-ingredient-unit">tsp</span> <span class="wprm-recipe-ingredient-name">cornflour / corn starch</span></li>
        <li class="wprm-recipe-ingredient"><span class="wprm-recipe-ingredient-amount">1 1/2</span> <span class="wprm-recipe-ingredient-unit">tbsp</span> <span class="wprm-recipe-ingredient-name">light soy sauce</span> <span class="wprm-recipe-ingredient-notes">, or all purpose (Note 2)</span></li>
        <li class="wprm-recipe-ingredient"><span class="wprm-recipe-ingredient-amount">2</span> <span class="wprm-recipe-ingredient-unit">tsp</span> <span class="wprm-recipe-ingredient-name">Oyster Sauce</span></li>
        <li class="wprm-recipe-ingredient"><span class="wprm-recipe-ingredient-amount">1</span> <span class="wprm-recipe-ingredient-unit">tbsp</span> <span class="wprm-recipe-ingredient-name">Chinese Cooking Wine OR Mirin (Note 3)</span> <span class="wprm-recipe-ingredient-notes">(shaoxing wine)</span></li>
        <li class="wprm-recipe-ingredient"><span class="wprm-recipe-ingredient-amount">1/2</span> <span class="wprm-recipe-ingredient-unit">tsp</span> <span class="wprm-recipe-ingredient-name">sesame oil</span></li>
        <li class="wprm-recipe-ingredient"><span class="wprm-recipe-ingredient-amount">1</span> <span class="wprm-recipe-ingredient-unit">cup / 250 ml</span> <span class="wprm-recipe-ingredient-name">water</span></li>
        <li class="wprm-recipe-ingredient"><span class="wprm-recipe-ingredient-unit">dash</span> <span class="wprm-recipe-ingredient-name">of white pepper</span></li>
      </ul>
    </div>
    <div class="wprm-recipe-ingredient-group">
      <h4 class="wprm-recipe-group-name wprm-recipe-ingredient-group-name">Omelette:</h4>
      <ul class="wprm-recipe-ingredients">
        <li class="wprm-recipe-ingredient"><span class="wprm-recipe-ingredient-amount">6</span> <span class="wprm-recipe-ingredient-name">eggs</span></li>
        <li class="wprm-recipe-ingredient"><span class="wprm-recipe-ingredient-amount">2</span> <span class="wprm-recipe-ingredient-unit">cups</span> <span class="wprm-recipe-ingredient-name">bean sprouts</span> <span class="wprm-recipe-ingredient-notes">(just eyeball it)</span></li>
        <li class="wprm-recipe-ingredient"><span class="wprm-recipe-ingredient-amount">4</span> <span class="wprm-recipe-ingredient-name">shallots/green onions</span> <span class="wprm-recipe-ingredient-notes">, white part only, sliced</span></li>
        <li class="wprm-recipe-ingredient"><span class="wprm-recipe-ingredient-name">Salt and white pepper</span></li>
        <li class="wprm-recipe-ingredient"><span class="wprm-recipe-ingredient-amount">2</span> <span class="wprm-recipe-ingredient-unit">tbsp</span> <span class="wprm-recipe-ingredient-name">vegetable oil</span></li>
        <li class="wprm-recipe-ingredient"><span class="wprm-recipe-ingredient-amount">1</span> <span class="wprm-recipe-ingredient-unit">tsp</span> <span class="wprm-recipe-ingredient-name">sesame oil</span></li>
        <li class="wprm-recipe-ingredient"><span class="wprm-recipe-ingredient-amount">1</span> <span class="wprm-recipe-ingredient-unit">clove</span> <span class="wprm-recipe-ingredient-name">garlic</span> <span class="wprm-recipe-ingredient-notes">, finely chopped</span></li>
        <li class="wprm-recipe-ingredient"><span class="wprm-recipe-ingredient-name">ONE Filling of Choice, below (Prawn or Pork)</span></li>
      </ul>
    </div>
    <div class="wprm-recipe-ingredient-group">
      <h4 class="wprm-recipe-group-name wprm-recipe-ingredient-group-name">Option 1: For Prawn /Shrimp Egg Foo Young</h4>
      <ul class="wprm-recipe-ingredients">
        <li class="wprm-recipe-ingredient"><span class="wprm-recipe-ingredient-amount">100 &ndash; 120g/3.5 &ndash; 4 oz </span> <span class="wprm-recipe-ingredient-name">chopped raw small prawns/shrimp</span> <span class="wprm-recipe-ingredient-notes">, peeled and deveined (Note 4)</span></li>
      </ul>
    </div>
    <div class="wprm-recipe-ingredient-group">
      <h4 class="wprm-recipe-group-name wprm-recipe-ingredient-group-name">Option 2: For Pork Egg Foo Young :</h4>
      <ul class="wprm-recipe-ingredients">
        <li class="wprm-recipe-ingredient"><span class="wprm-recipe-ingredient-amount">100 &ndash; 120g/3.5 &ndash; 4 oz </span> <span class="wprm-recipe-ingredient-name">ground/mince pork</span> <span class="wprm-recipe-ingredient-notes">(or chicken, turkey, beef or veal)</span></li>
        <li class="wprm-recipe-ingredient"><span class="wprm-recipe-ingredient-amount">1/2</span> <span class="wprm-recipe-ingredient-unit">tsp</span> <span class="wprm-recipe-ingredient-name">EACH soy sauce and Oyster Sauce</span></li>
        <li class="wprm-recipe-ingredient"><span class="wprm-recipe-ingredient-amount">1/4</span> <span class="wprm-recipe-ingredient-unit">tsp</span> <span class="wprm-recipe-ingredient-name">sugar</span></li>
        <li class="wprm-recipe-ingredient"><span class="wprm-recipe-ingredient-unit">dash</span> <span class="wprm-recipe-ingredient-name">of sesame oil</span></li>
      </ul>
    </div>
    <div class="wprm-recipe-ingredient-group">
      <h4 class="wprm-recipe-group-name wprm-recipe-ingredient-group-name">Garnish (optional):</h4>
      <ul class="wprm-recipe-ingredients">
        <li class="wprm-recipe-ingredient"><span class="wprm-recipe-ingredient-name">Sesame seeds</span> <span class="wprm-recipe-ingredient-notes">, sliced green onion</span></li>
      </ul>
    </div>
  </div>
</div>
`;

export interface ExpectedOccurrence {
  group: string;
  name: string;
  quantity: number;
  unit: string;
  notes?: string;
}

export const EXPECTED_EGG_FOO_YOUNG_OCCURRENCES: ExpectedOccurrence[] = [
  // Group 0: Sauce
  { group: "Sauce (Note 1 for Charlie option):", name: "cornflour / corn starch", quantity: 4, unit: "tsp" },
  { group: "Sauce (Note 1 for Charlie option):", name: "light soy sauce", quantity: 1.5, unit: "tbsp", notes: "or all purpose (Note 2)" },
  { group: "Sauce (Note 1 for Charlie option):", name: "Oyster Sauce", quantity: 2, unit: "tsp" },
  { group: "Sauce (Note 1 for Charlie option):", name: "Chinese Cooking Wine OR Mirin", quantity: 1, unit: "tbsp", notes: "shaoxing wine; Note 3" },
  { group: "Sauce (Note 1 for Charlie option):", name: "sesame oil", quantity: 0.5, unit: "tsp" },
  { group: "Sauce (Note 1 for Charlie option):", name: "water", quantity: 250, unit: "ml" },
  { group: "Sauce (Note 1 for Charlie option):", name: "white pepper", quantity: 0, unit: "dash" },

  // Group 1: Omelette
  { group: "Omelette:", name: "eggs", quantity: 6, unit: "" },
  { group: "Omelette:", name: "bean sprouts", quantity: 2, unit: "cup", notes: "just eyeball it" },
  { group: "Omelette:", name: "shallots/green onions", quantity: 4, unit: "", notes: "white part only, sliced" },
  { group: "Omelette:", name: "Salt and white pepper", quantity: 0, unit: "" },
  { group: "Omelette:", name: "vegetable oil", quantity: 2, unit: "tbsp" },
  { group: "Omelette:", name: "sesame oil", quantity: 1, unit: "tsp" },
  { group: "Omelette:", name: "garlic", quantity: 1, unit: "clove", notes: "finely chopped" },
  { group: "Omelette:", name: "ONE Filling of Choice", quantity: 0, unit: "", notes: "Prawn or Pork; below" },

  // Group 2: Option 1
  { group: "Option 1: For Prawn /Shrimp Egg Foo Young", name: "chopped raw small prawns/shrimp", quantity: 100, unit: "g", notes: "Note 4; peeled and deveined" },

  // Group 3: Option 2
  { group: "Option 2: For Pork Egg Foo Young :", name: "ground/mince pork", quantity: 100, unit: "g", notes: "or chicken, turkey, beef or veal" },
  { group: "Option 2: For Pork Egg Foo Young :", name: "EACH soy sauce and Oyster Sauce", quantity: 0.5, unit: "tsp" },
  { group: "Option 2: For Pork Egg Foo Young :", name: "sugar", quantity: 0.25, unit: "tsp" },
  { group: "Option 2: For Pork Egg Foo Young :", name: "sesame oil", quantity: 0, unit: "dash" },

  // Group 4: Garnish
  { group: "Garnish (optional):", name: "Sesame seeds", quantity: 0, unit: "", notes: "sliced green onion" },
];
