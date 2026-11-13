import React, { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "@/contexts/ThemeContext";
import { useRouter } from "expo-router";
import { httpsCallable } from "firebase/functions";
import { functions } from "@/config/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { useConnected } from "@/contexts/ConnectedContext";
import {
  addToCookbook,
  updateCookbookDetails,
} from "@/services/firestoreService";
import { filterCookbook, indexCookbook } from "@/services/cookbookPresentation";
import RecipeDetailModal from "@/components/RecipeDetailModal";
import type { CookbookEntry, Recipe } from "@/services/types";
import { Card, Heading, Label, Button, Row, Field, report } from "./ui";
import CookbookRecipeCard from './CookbookRecipeCard';
import { IconButton, StatusNotice } from './classic';
import { useFavourite } from '@/hooks/useFavourite';
export default function CookbookScreen() {
  const favourite = useFavourite();
  const { colors } = useTheme();
  const notesInFlight = useRef(false);
  const [notesSaving, setNotesSaving] = useState(false);
  const c = useConnected();
  const { householdId } = useAuth();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [starred, setStarred] = useState(false);
  const [cooked, setCooked] = useState(false);
  const [time, setTime] = useState(0);
  const [type, setType] = useState("all");
  const [preview, setPreview] = useState<Recipe | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [url, setUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<Recipe | null>(null);
  const indexed = useMemo(() => indexCookbook(c.cookbook, c.recipes), [c.cookbook, c.recipes]);
  const entries = useMemo(() => filterCookbook(indexed, { search, starred, cooked, time, type }),
    [indexed, search, starred, cooked, time, type]);
  const addToPlan = useCallback((recipeId: string) => {
    router.push({ pathname: "/", params: { recipeId } });
  }, [router]);
  const editNotes = useCallback((entry: CookbookEntry) => {
    setEditing(entry.recipeId);
    setNotes(entry.notes ?? "");
  }, []);
  const cancelNotes = useCallback(() => { setEditing(null); setNotes(""); }, []);
  const saveNotes = useCallback(async () => {
    if (!householdId || !editing || notesInFlight.current) return;
    notesInFlight.current = true;
    setNotesSaving(true);
    try {
      await updateCookbookDetails(householdId, editing, { notes });
      setEditing(null);
    } catch (error) { report(error); }
    finally { notesInFlight.current = false; setNotesSaving(false); }
  }, [householdId, editing, notes]);
  const importRecipe = async () => {
    if (!householdId) return;
    setImporting(true);
    try {
      const response = await httpsCallable<
        { householdId: string; url: string },
        { recipeId: string }
      >(functions, "importConnectedRecipe", { timeout: 120000 })({
        householdId,
        url,
      });
      const recipe = await c.load(response.data.recipeId);
      if (!recipe) throw new Error("Imported recipe is unavailable.");
      setImported(recipe);
      setPreview(recipe);
    } catch (e) {
      report(e);
    } finally {
      setImporting(false);
    }
  };
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={["top", "left", "right"]}>
      <FlatList
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ padding: 24, paddingBottom: 36, width: "100%", maxWidth: 880, alignSelf: "center" }}
        data={c.loading ? [] : entries}
        keyExtractor={(item) => item.entry.recipeId}
        initialNumToRender={4}
        maxToRenderPerBatch={4}
        windowSize={5}
        removeClippedSubviews={false}
        keyboardShouldPersistTaps="handled"
        ItemSeparatorComponent={CardSeparator}
        renderItem={({ item: { entry, recipe } }) => (
          <CookbookRecipeCard
            entry={entry}
            recipe={recipe}
            starred={favourite.starred(entry.recipeId)}
            favouritePending={favourite.pending(entry.recipeId)}
            favouriteDisabled={favourite.disabled}
            notesSaving={notesSaving}
            online={c.online}
            editingNotes={editing === entry.recipeId ? notes : undefined}
            onPreview={setPreview}
            onFavourite={favourite.toggle}
            onAddToPlan={addToPlan}
            onEditNotes={editNotes}
            onChangeNotes={setNotes}
            onCancelNotes={cancelNotes}
            onSaveNotes={editing === entry.recipeId ? saveNotes : undefined}
          />
        )}
        ListHeaderComponent={<View style={{ gap: 16, paddingBottom: 16 }}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <View style={{ flex: 1 }}><Heading>Cookbook</Heading></View>
            <IconButton icon="settings-outline" label="Settings" onPress={() => router.push("/profile")} />
          </View>
          <StatusNotice style={{ paddingHorizontal: 0 }} />
          {c.loading ? <ActivityIndicator color={colors.primary} accessibilityLabel="Loading household" /> : <>

            <Field
              label="Search recipes, ingredients, and cuisines"
              value={search}
              onChangeText={setSearch}
            />
            <Row>
              <Button
                label="Favourites"
                secondary
                selected={starred}
                onPress={() => setStarred((v) => !v)}
              />
              <Button
                label="Cooked before"
                secondary
                selected={cooked}
                onPress={() => setCooked((v) => !v)}
              />
              {[0, 30, 45].map((n) => (
                <Button
                  key={n}
                  label={n ? `Under ${n} min` : "Any time"}
                  secondary
                  selected={time === n}
                  onPress={() => setTime(n)}
                />
              ))}
            </Row>
            <Row>
              {[
                "all",
                "breakfast",
                "lunch",
                "dinner",
                "side",
                "snack",
                "dessert",
              ].map((t) => (
                <Button
                  key={t}
                  label={t === "all" ? "All meals" : t}
                  secondary
                  selected={type === t}
                  onPress={() => setType(t)}
                />
              ))}
            </Row>
            <Card>
              <Heading>Import a recipe</Heading>
              <Label muted>
                Paste a recipe link from a supported trusted source. Review it before
                adding it to your cookbook.
              </Label>
              <Field
                label="Recipe URL"
                value={url}
                onChangeText={setUrl}
                autoCapitalize="none"
                keyboardType="url"
              />
              <Button
                label={importing ? "Reading recipe…" : "Preview import"}
                disabled={importing || !url.trim() || !c.online}
                onPress={importRecipe}
              />
              {imported && (
                <>
                  <Label>{imported.title}</Label>
                  <Button
                    label="Save to cookbook"
                    onPress={async () => {
                      try {
                        if (
                          householdId &&
                          !c.cookbook.some((e) => e.recipeId === imported.id)
                        )
                          await addToCookbook(householdId, imported.id!);
                        setImported(null);
                        setUrl("");
                      } catch (e) {
                        report(e);
                      }
                    }}
                  />
                </>
              )}
            </Card>
            <Label>{entries.length} recipes</Label>
          </>}
        </View>}
        ListEmptyComponent={c.loading ? null : <Card>
          <Label>No recipes match these filters. Try another ingredient or save meals from a generated plan.</Label>
        </Card>}
      />
      <RecipeDetailModal
        recipe={preview}
        visible={!!preview}
        onClose={() => setPreview(null)}
        actionBar={
          preview ? (
            <Row>
              <Button
                label="Add to plan"
                onPress={() => {
                  const id = preview.id;
                  setPreview(null);
                  router.push({ pathname: "/", params: { recipeId: id } });
                }}
              />
            </Row>
          ) : undefined
        }
      />
    </SafeAreaView>
  );
}

function CardSeparator() {
  return <View style={{ height: 16 }} />;
}
