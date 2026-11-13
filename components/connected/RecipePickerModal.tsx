import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, View } from "react-native";
import { useAuth } from "@/contexts/AuthContext";
import { useConnected } from "@/contexts/ConnectedContext";
import RecipeDetailModal from "@/components/RecipeDetailModal";
import {
  browseCatalogue,
  type RecipeSummary,
} from "@/services/catalogueBrowse";
import {
  catalogueClient,
  type CatalogueCuisine,
} from "@/services/catalogueClient";
import type { Recipe, MealType } from "@/services/types";
import { Sheet } from "./classic";
import { Button, Card, Field, Label, Row } from "./ui";

const types: MealType[] = [
  "breakfast",
  "lunch",
  "dinner",
  "side",
  "snack",
  "dessert",
  "component",
];
const cuisines: CatalogueCuisine[] = [
  "asian",
  "mexican",
  "mediterranean",
  "italian",
  "indian",
  "greek",
  "american",
  "french",
  "middle-eastern",
  "global",
];
type Props = {
  mealType: string;
  date: string;
  onClose: () => void;
  onSelect: (recipe: Recipe) => void;
};
export default function RecipePickerModal(props: Props) {
  const c = useConnected();
  const { householdId } = useAuth();
  return (
    <PickerBody
      key={JSON.stringify([
        householdId,
        c.settings.excludedIngredients,
        c.settings.sourceWeights,
        c.online,
      ])}
      {...props}
    />
  );
}
function PickerBody({
  mealType,
  date,
  onClose,
  onSelect,
}: {
  mealType: string;
  date: string;
  onClose: () => void;
  onSelect: (recipe: Recipe) => void;
}) {
  const c = useConnected();
  const { householdId } = useAuth();
  const [tab, setTab] = useState<"saved" | "discover">("saved");
  const [savedSearch, setSavedSearch] = useState("");
  const [ingredient, setIngredient] = useState("");
  const [type, setType] = useState<MealType>(
    types.includes(mealType as MealType) ? (mealType as MealType) : "dinner",
  );
  const [cuisine, setCuisine] = useState<CatalogueCuisine | undefined>();
  const [results, setResults] = useState<RecipeSummary[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Recipe | null>(null);
  const [surprise, setSurprise] = useState<Recipe | null>(null);
  const [noMatch, setNoMatch] = useState(false);
  const rejected = useRef<string[]>([]);
  const epoch = useRef(0);
  const alive = useRef(true);
  const invalidate = () => {
    epoch.current++;
    setBusy(false);
    setError("");
    setResults([]);
    setCursor(undefined);
    setSearched(false);
    setSurprise(null);
    setNoMatch(false);
  };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const current = (n: number) => alive.current && epoch.current === n;
  const fail = (e: unknown, n: number) => {
    if (current(n))
      setError(
        e instanceof Error
          ? e.message
          : "Could not load recipes. Please retry.",
      );
  };
  const browse = async (more = false) => {
    if (!householdId || !c.online || busy) return;
    const n = ++epoch.current;
    setBusy(true);
    setError("");
    setSurprise(null);
    try {
      const page = await browseCatalogue({
        householdId,
        mealType: type,
        ingredient,
        ...(cuisine ? { cuisine } : {}),
        ...(more && cursor ? { cursor } : {}),
      });
      if (!current(n)) return;
      setResults((old) =>
        more
          ? [
              ...new Map(
                [...old, ...page.recipes].map((r) => [r.id, r]),
              ).values(),
            ]
          : page.recipes,
      );
      setCursor(page.nextCursor);
      setSearched(true);
    } catch (e) {
      fail(e, n);
    } finally {
      if (current(n)) setBusy(false);
    }
  };
  const open = async (id: string) => {
    const n = ++epoch.current;
    setBusy(true);
    setError("");
    try {
      const recipe = await c.load(id);
      if (!current(n)) return;
      if (!recipe) throw new Error("This recipe is unavailable.");
      setPreview(recipe);
    } catch (e) {
      fail(e, n);
    } finally {
      if (current(n)) setBusy(false);
    }
  };
  const recommend = async () => {
    if (!householdId || !c.online || busy) return;
    if (surprise?.id && !rejected.current.includes(surprise.id))
      rejected.current.push(surprise.id);
    if (rejected.current.length >= 500) {
      setError("Start a new recipe search to explore more suggestions.");
      return;
    }
    const n = ++epoch.current;
    setBusy(true);
    setError("");
    setSurprise(null);
    setNoMatch(false);
    try {
      const response = await catalogueClient.select({
        householdId,
        slots: [
          {
            date,
            mealType: type,
            cuisines: cuisine ? [cuisine] : [],
            modifiers: [],
            ingredients: {
              must: ingredient.trim() ? [ingredient.trim()] : [],
              prefer: [],
              exclude: c.settings.excludedIngredients ?? [],
            },
          },
        ],
        currentPlanRecipeIds: rejected.current,
        recentRecipeIds: [],
      });
      if (!current(n)) return;
      const slot = response.slots[0];
      if (slot.status !== "selected") {
        setNoMatch(true);
        return;
      }
      const recipe = await c.load(slot.recipeId);
      if (!current(n)) return;
      if (!recipe) throw new Error("This recipe is unavailable. Try another.");
      setSurprise(recipe);
    } catch (e) {
      fail(e, n);
    } finally {
      if (current(n)) setBusy(false);
    }
  };
  const saved = c.cookbook
    .map((e) => c.recipes[e.recipeId])
    .filter((r): r is Recipe => !!r)
    .filter((r) =>
      [
        r.title,
        ...r.ingredients.map((i) => i.name),
        ...(r.tags ?? []),
        ...(r.course ?? []),
        r.cuisine ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(savedSearch.trim().toLowerCase()),
    );
  return (
    <Sheet
      title="Choose a recipe"
      onClose={() => {
        epoch.current++;
        onClose();
      }}
    >
      <Row>
        <Button
          label="Saved"
          secondary
          selected={tab === "saved"}
          onPress={() => {
            invalidate();
            setTab("saved");
          }}
        />
        <Button
          label="Discover"
          secondary
          selected={tab === "discover"}
          onPress={() => {
            invalidate();
            setTab("discover");
          }}
        />
      </Row>
      {tab === "saved" ? (
        <>
          <Field
            label="Search saved recipes, ingredients, and cuisines"
            value={savedSearch}
            onChangeText={setSavedSearch}
          />
          {!saved.length && (
            <Label>No saved recipes match. Try Discover to find a meal.</Label>
          )}
          {saved.map((r) => (
            <Button
              key={r.id}
              label={r.title}
              secondary
              disabled={busy}
              onPress={() => open(r.id!)}
            />
          ))}
        </>
      ) : (
        <>
          {!c.online && (
            <Label>
              Connect to discover recipes. Cached saved recipes are still
              available.
            </Label>
          )}
          <Field
            label="Ingredient"
            placeholder="For example, chicken"
            value={ingredient}
            maxLength={120}
            onChangeText={(v) => {
              invalidate();
              setIngredient(v);
            }}
          />
          <Row>
            {types.map((t) => (
              <Button
                key={t}
                label={t}
                secondary
                selected={type === t}
                onPress={() => {
                  invalidate();
                  setType(t);
                }}
              />
            ))}
          </Row>
          <Row>
            <Button
              label="Any cuisine"
              secondary
              selected={!cuisine}
              onPress={() => {
                invalidate();
                setCuisine(undefined);
              }}
            />
            {cuisines.map((t) => (
              <Button
                key={t}
                label={t}
                secondary
                selected={cuisine === t}
                onPress={() => {
                  invalidate();
                  setCuisine(t);
                }}
              />
            ))}
          </Row>
          <Row>
            <Button
              label="Find recipes"
              disabled={busy || !c.online}
              onPress={() => browse()}
            />
            <Button
              label="Surprise Me"
              secondary
              disabled={busy || !c.online}
              onPress={recommend}
            />
          </Row>
          {noMatch && (
            <Label>
              No matching suggestion remains. Change your filters to try again;
              household exclusions stay in effect.
            </Label>
          )}
          {surprise && (
            <Card>
              <Label>{surprise.title}</Label>
              {!!surprise.imageUrl && (
                <Image
                  source={{ uri: surprise.imageUrl }}
                  style={{ height: 140, borderRadius: 12 }}
                />
              )}
              <Label>
                Per serving: {surprise.nutrition?.calories ?? "—"} kcal ·{" "}
                {surprise.nutrition?.protein ?? "—"} g protein
              </Label>
              <Row>
                <Button
                  label="Preview"
                  secondary
                  onPress={() => setPreview(surprise)}
                />
                <Button label="Use recipe" onPress={() => onSelect(surprise)} />
                <Button
                  label="Try another"
                  secondary
                  disabled={busy || !c.online}
                  onPress={recommend}
                />
              </Row>
            </Card>
          )}
          {results.map((r) => (
            <Card key={r.id}>
              <Label>{r.title}</Label>
              <Label muted>
                {r.totalMinutes === undefined
                  ? "Time unavailable"
                  : `${r.totalMinutes} min`}
              </Label>
              <Button
                label="Preview recipe"
                secondary
                disabled={busy}
                onPress={() => open(r.id)}
              />
            </Card>
          ))}
          {searched && !results.length && (
            <Label>
              {cursor
                ? "No matches in this page. Continue searching the catalogue."
                : "No recipes match these filters."}
            </Label>
          )}
          {cursor && (
            <Button
              label="Load more"
              secondary
              disabled={busy || !c.online}
              onPress={() => browse(true)}
            />
          )}
        </>
      )}
      {busy && <ActivityIndicator accessibilityLabel="Loading recipes" />}
      {!!error && <Label>{error}</Label>}
      <RecipeDetailModal
        recipe={preview}
        visible={!!preview}
        onClose={() => setPreview(null)}
        actionBar={
          preview ? (
            <View>
              <Button
                label="Use recipe"
                onPress={() => {
                  onSelect(preview);
                  setPreview(null);
                }}
              />
            </View>
          ) : undefined
        }
      />
    </Sheet>
  );
}
