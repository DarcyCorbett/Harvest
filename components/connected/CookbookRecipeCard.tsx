import React, { memo } from 'react';
import { Pressable, View } from 'react-native';
import type { CookbookEntry, Recipe } from '@/services/types';
import { Button, Card, Field, Heading, Label, Row } from './ui';
import FavouriteButton from './FavouriteButton';
import CookbookThumbnail from './CookbookThumbnail';

interface Props {
  entry: CookbookEntry;
  recipe: Recipe;
  starred: boolean;
  favouritePending: boolean;
  favouriteDisabled: boolean;
  notesSaving: boolean;
  online: boolean;
  editingNotes?: string;
  onPreview: (recipe: Recipe) => void;
  onFavourite: (id: string) => void;
  onAddToPlan: (id: string) => void;
  onEditNotes: (entry: CookbookEntry) => void;
  onChangeNotes: (notes: string) => void;
  onCancelNotes: () => void;
  onSaveNotes?: () => void;
}

export default memo(function CookbookRecipeCard({
  entry, recipe, starred, favouritePending, favouriteDisabled, notesSaving, online,
  editingNotes, onPreview, onFavourite, onAddToPlan, onEditNotes, onChangeNotes,
  onCancelNotes, onSaveNotes,
}: Props) {
  return (
    <Card>
      <Pressable accessibilityRole="button" accessibilityLabel={`View ${recipe.title}`} onPress={() => onPreview(recipe)}>
        <CookbookThumbnail recipe={recipe} />
      </Pressable>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Pressable style={{ flex: 1 }} accessibilityRole="button" accessibilityLabel={`View ${recipe.title}`} onPress={() => onPreview(recipe)}>
          <Heading>{recipe.title}</Heading>
        </Pressable>
        <FavouriteButton title={recipe.title} starred={starred} pending={favouritePending} disabled={favouriteDisabled} onPress={() => onFavourite(entry.recipeId)} />
      </View>
      <Label muted>
        {recipe.totalTime || `${recipe.prepTime} prep · ${recipe.cookTime} cook`} ·{' '}
        {entry.lastCookedAt ? `Cooked ${entry.lastCookedAt.slice(0, 10)}` : 'Saved — not yet cooked'}
      </Label>
      <Row>
        <Button label="Add to plan" onPress={() => onAddToPlan(entry.recipeId)} />
        <Button label="Notes" secondary disabled={notesSaving} onPress={() => onEditNotes(entry)} />
      </Row>
      {entry.notes && <Label>{entry.notes}</Label>}
      {editingNotes !== undefined && <>
        <Field label="Household cooking notes" value={editingNotes} onChangeText={onChangeNotes} multiline />
        <Row>
          <Button label={notesSaving ? 'Saving…' : 'Save'} disabled={notesSaving || !online} onPress={() => onSaveNotes?.()} />
          <Button label="Cancel" secondary disabled={notesSaving} onPress={onCancelNotes} />
        </Row>
      </>}
    </Card>
  );
});
