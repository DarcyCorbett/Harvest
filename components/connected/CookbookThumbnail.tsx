import React, { memo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { cookbookImageUrls } from '@/services/cookbookPresentation';
import type { Recipe } from '@/services/types';

function ThumbnailCandidates({ urls, title }: { urls: string[]; title: string }) {
  const { colors } = useTheme();
  const [index, setIndex] = useState(0);
  const uri = urls[index];
  return (
    <View style={[styles.frame, { backgroundColor: colors.surface }]}>
      <Ionicons name="restaurant-outline" size={40} color={colors.textTertiary} accessible={false} />
      {uri && <Image
        key={uri}
        source={{ uri }}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        cachePolicy="disk"
        recyclingKey={uri}
        accessibilityLabel={title}
        onError={() => setIndex((current) => current === index ? current + 1 : current)}
      />}
    </View>
  );
}

export default memo(function CookbookThumbnail({ recipe }: { recipe: Recipe }) {
  const urls = cookbookImageUrls(recipe);
  // Reset failures when the recipe or its sources change, including recycled rows.
  return <ThumbnailCandidates key={JSON.stringify([recipe.id, urls])} urls={urls} title={recipe.title} />;
});

const styles = StyleSheet.create({
  frame: { width: '100%', height: 160, borderRadius: 14, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
});
