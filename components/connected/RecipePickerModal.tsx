import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/contexts/ThemeContext";
import { Fonts, Shadows } from "@/constants/theme";
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
  const { colors } = useTheme();
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
  const loading = useRef(false);
  const browse = async (more = false) => {
    if (!householdId || !c.online || busy || (more && loading.current)) return;
    loading.current = true;
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
      loading.current = false;
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
  // Discover pages load as the list nears the bottom, instead of a "Load more" button.
  const loadMore = () => {
    if (tab === "discover" && searched && cursor && !busy && !error && c.online) void browse(true);
  };
  // A page can come back empty after filtering; the sheet's size may not change, so keep going here.
  useEffect(() => {
    if (searched && !results.length && cursor && !busy && !error) loadMore();
  });
  return (
    <Sheet
      title="Choose a recipe"
      onClose={() => {
        epoch.current++;
        onClose();
      }}
      onEndReached={loadMore}
    >
      <Segmented
        options={[
          { value: "saved", label: "Saved", icon: "bookmark-outline" },
          { value: "discover", label: "Discover", icon: "compass-outline" },
        ]}
        value={tab}
        onChange={(next) => {
          invalidate();
          setTab(next);
        }}
      />
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
          {saved.length > 40 && (
            <Label muted>Showing 40 of {saved.length}. Search to narrow the list.</Label>
          )}
          {saved.slice(0, 40).map((r) => (
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
          <View style={{ gap: 18, padding: 16, borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
            <Field
              label="Main ingredient (optional)"
              placeholder="For example, chicken"
              value={ingredient}
              maxLength={120}
              onChangeText={(v) => {
                invalidate();
                setIngredient(v);
              }}
            />
            <FilterSection title="Meal">
              {types.map((t) => (
                <Chip
                  key={t}
                  label={titleCase(t)}
                  selected={type === t}
                  onPress={() => {
                    invalidate();
                    setType(t);
                  }}
                />
              ))}
            </FilterSection>
            <FilterSection title="Cuisine">
              <Chip
                label="Any"
                selected={!cuisine}
                onPress={() => {
                  invalidate();
                  setCuisine(undefined);
                }}
              />
              {cuisines.map((t) => (
                <Chip
                  key={t}
                  label={titleCase(t)}
                  selected={cuisine === t}
                  onPress={() => {
                    invalidate();
                    setCuisine(t);
                  }}
                />
              ))}
            </FilterSection>
          </View>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <ActionButton
              icon="search"
              label="Find recipes"
              primary
              disabled={busy || !c.online}
              onPress={() => browse()}
            />
            <ActionButton
              icon="shuffle"
              label="Surprise me"
              disabled={busy || !c.online}
              onPress={recommend}
            />
          </View>
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
          {searched && (
            <SectionTitle>{results.length ? `Results · ${results.length}${cursor ? "+" : ""}` : "Results"}</SectionTitle>
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
          {searched && !results.length && !cursor && (
            <Label>No recipes match these filters.</Label>
          )}
          {searched && !cursor && results.length > 0 && (
            <Label muted>That&apos;s every match for these filters.</Label>
          )}
        </>
      )}
      {busy && <ActivityIndicator accessibilityLabel="Loading recipes" />}
      {!!error && (
        <View style={{ gap: 8 }}>
          <Label>{error}</Label>
          {tab === "discover" && searched && !!cursor && (
            <Button label="Retry" secondary disabled={busy || !c.online} onPress={() => { setError(""); void browse(true); }} />
          )}
        </View>
      )}
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

const titleCase = (value: string) =>
  value.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");

function SectionTitle({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <Text
      accessibilityRole="header"
      style={{ fontFamily: Fonts.semibold, fontSize: 12, letterSpacing: 0.6, textTransform: "uppercase", color: colors.textSecondary }}
    >
      {children}
    </Text>
  );
}

/** A labelled group of filter chips, so each filter reads as its own question. */
function FilterSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <SectionTitle>{title}</SectionTitle>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{children}</View>
    </View>
  );
}

/** Compact filter choice: tinted with a tick when selected, unlike the solid action buttons. */
function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      hitSlop={{ top: 4, bottom: 4 }}
      style={({ pressed }) => ({
        minHeight: 36,
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 12,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: selected ? colors.primary : colors.border,
        backgroundColor: selected ? colors.primaryLight : colors.background,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      {selected && <Ionicons name="checkmark" size={14} color={colors.primaryText} />}
      <Text style={{ fontFamily: selected ? Fonts.semibold : Fonts.medium, fontSize: 13, color: selected ? colors.primaryText : colors.textSecondary }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Saved / Discover switch: a segmented control, visually distinct from filters and actions. */
function Segmented<T extends string>({ options, value, onChange }: {
  options: { value: T; label: string; icon: React.ComponentProps<typeof Ionicons>["name"] }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const { colors } = useTheme();
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: "row", padding: 4, borderRadius: 14, backgroundColor: colors.border }}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityLabel={option.label}
            accessibilityState={{ selected: active }}
            onPress={() => { if (!active) onChange(option.value); }}
            style={{
              flex: 1,
              minHeight: 40,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              borderRadius: 10,
              backgroundColor: active ? colors.surface : "transparent",
              ...(active ? Shadows.sm : {}),
            }}
          >
            <Ionicons name={option.icon} size={16} color={active ? colors.text : colors.textSecondary} />
            <Text style={{ fontFamily: active ? Fonts.semibold : Fonts.medium, fontSize: 14, color: active ? colors.text : colors.textSecondary }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Full-height action with an icon; primary is solid, secondary is outlined. */
function ActionButton({ icon, label, primary = false, disabled, onPress }: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string;
  primary?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 50,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        borderRadius: 25,
        borderWidth: primary ? 0 : 1.5,
        borderColor: colors.primary,
        backgroundColor: primary ? colors.primary : colors.surface,
        opacity: disabled ? 0.45 : pressed ? 0.75 : 1,
      })}
    >
      <Ionicons name={icon} size={18} color={primary ? colors.textInverse : colors.primaryText} />
      <Text style={{ fontFamily: Fonts.semibold, fontSize: 15, color: primary ? colors.textInverse : colors.primaryText }}>{label}</Text>
    </Pressable>
  );
}
