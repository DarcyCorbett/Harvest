import type { ShoppingCategory } from "@/services/types";

export const QUICK_ADD_ITEMS: { category: ShoppingCategory; items: string[] }[] = [
  { category: "Produce", items: ["Bananas", "Apples", "Pears", "Cucumbers"] },
  { category: "Dairy & Eggs", items: ["Milk", "Eggs", "Butter", "Cheese", "Parmesan", "Yoghurt"] },
  { category: "Bread & Bakery", items: ["Bread", "Wraps"] },
  { category: "Meat & Seafood", items: ["Chicken", "Beef mince", "Ham"] },
  { category: "Herbs & Spices", items: ["Garlic", "Ginger", "Parsley", "Cumin", "Paprika"] },
  { category: "Frozen", items: ["Frozen peas", "Frozen berries", "Ice cream"] },
  { category: "Pantry & Dry Goods", items: ["Pasta", "Rice", "Cereal", "Jam", "Peanut Butter", "Vegemite", "Honey", "Coffee", "Decaf Coffee"] },
  { category: "Oils, Sauces & Condiments", items: ["Olive oil", "Soy sauce", "Pesto"] },
  { category: "Drinks & Beverages", items: ["Juice", "Soft Drinks", "Water", "Tea"] },
  { category: "Personal Care", items: ["Toothpaste", "Toothbrush", "Shampoo", "Body Wash", "Deodorant", "Pads", "Baby Wipes"] },
  { category: "Household & Cleaning", items: ["Washing up liquid", "Dishwasher tablets", "Tissues", "Toilet paper"] },
];

export const QUICK_ADD_BY_CATEGORY: Partial<Record<ShoppingCategory, string[]>> =
  Object.fromEntries(QUICK_ADD_ITEMS.map(({ category, items }) => [category, items]));
