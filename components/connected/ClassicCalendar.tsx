import React, { useEffect, useRef, useState } from "react";
import {
  FlatList,
  PanResponder,
  Image,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useConnected } from "@/contexts/ConnectedContext";
import { useTheme } from "@/contexts/ThemeContext";
import { Shadows } from "@/constants/theme";
import {
  isoDate,
  shiftDate,
  weekRange,
  type Meal,
} from "@/services/connectedClient";
import { plannedNutrition, householdTargets } from '@/services/plannedNutrition';
import { mealLabel } from '@/services/planning';
import { report } from './ui';
import { calendarStyles as s } from "./calendarStyles";
import { Caption, IconButton, StatusNotice } from "./classic";

type Props = {
  start: string;
  selectedDate: string;
  view: "week" | "month";
  setStart: (v: string) => void;
  setSelectedDate: (v: string) => void;
  setView: (v: "week" | "month") => void;
  onAdd: (date: string, type?: string) => void;
  onPreview: (m: Meal) => void;
  onOptions: (m: Meal) => void;
  onTemplates: () => void;
  onMove: (meal: Meal, date: string) => Promise<void>;
  children: React.ReactNode;
};
export default function ClassicCalendar({
  start,
  selectedDate,
  view,
  setStart,
  setSelectedDate,
  setView,
  onAdd,
  onPreview,
  onOptions,
  onTemplates,
  onMove,
  children,
}: Props) {
  const c = useConnected();
  const { colors } = useTheme();
  const { width, height, fontScale } = useWindowDimensions();
  const pageWidth = Math.min(width, 880),
    cardWidth = pageWidth * (fontScale > 1.3 ? 0.92 : 0.8),
    gap = 12;
  const list = useRef<FlatList<string>>(null);
  const [measured, setMeasured] = useState<Record<string, number>>({});
  const measure = (key: string, value: number) =>
    setMeasured((old) =>
      Math.abs((old[key] ?? 0) - value) < 1 ? old : { ...old, [key]: value },
    );
  const today = isoDate(new Date());
  const days = Array.from({ length: 7 }, (_, i) =>
    shiftDate(start, i),
  );
  const [dragging, setDragging] = useState<Meal | null>(null);
  const [hoverDate, setHoverDate] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<{meal: Meal; date: string} | null>(null);
  const dragRef = useRef<Meal | null>(null);
  const pendingRef = useRef(false);
  const targetRefs = useRef<Record<string, View | null>>({});
  const bounds = useRef<Record<string, {x:number;y:number;width:number;height:number}>>({});
  const dropAt = (x:number,y:number) => Object.entries(bounds.current).find(([,b]) => x>=b.x && x<=b.x+b.width && y>=b.y && y<=b.y+b.height)?.[0];
  const finishRef = useRef((x:number,y:number) => {});
  useEffect(() => { finishRef.current = (x,y) => {
    const meal = dragRef.current, date = dropAt(x,y);
    dragRef.current = null; setDragging(null); setHoverDate(null);
    if (!meal || !date || date === meal.date || pendingRef.current) return;
    pendingRef.current = true; setPendingMove({meal,date});
    onMove(meal,date).catch(report).finally(() => {pendingRef.current=false;setPendingMove(null);});
  }; });
  // PanResponder stores these callbacks; it does not execute them during construction.
  // eslint-disable-next-line react-hooks/refs
  const [pan] = useState(() => PanResponder.create({
    onMoveShouldSetPanResponderCapture: () => !!dragRef.current,
    onPanResponderMove: (_,g) => setHoverDate(dropAt(g.moveX,g.moveY) ?? null),
    onPanResponderRelease: (_,g) => finishRef.current(g.moveX,g.moveY),
    onPanResponderTerminationRequest: () => !dragRef.current,
    onPanResponderTerminate: () => {dragRef.current=null;setDragging(null);setHoverDate(null);},
  }));
  const entries = (pendingMove ? c.meals.map(m => m.id === pendingMove.meal.id ? {...m,date:pendingMove.date} : m) : c.meals).filter((m) => m.status !== "removed");
  const forDate = (date: string) =>
    entries
      .filter((m) => m.date === date)
      .sort(
        (a, b) =>
          [
            "breakfast",
            "lunch",
            "dinner",
            "side",
            "snack",
            "dessert",
            "component",
          ].indexOf(a.mealType) -
          [
            "breakfast",
            "lunch",
            "dinner",
            "side",
            "snack",
            "dessert",
            "component",
          ].indexOf(b.mealType),
      );
  const badge = (type: string) =>
    type === "breakfast"
      ? [colors.caloriesBadge, colors.caloriesText, "☀️"]
      : type === "lunch"
        ? [colors.carbsBadge, colors.carbsText, "🥪"]
        : [colors.proteinBadge, colors.proteinText, "🌙"];
  const title = (m: Meal) => mealLabel(m, c.recipes[m.recipeId]?.title);
  useEffect(() => {
    const timer = setTimeout(
      () =>
        list.current?.scrollToOffset({
          offset:
            Math.max(
              0,
              Math.min(
                6,
                Math.round((Date.parse(selectedDate) - Date.parse(start)) / 86400000),
              ),
            ) *
            (cardWidth + gap),
          animated: false,
        }),
      80,
    );
    return () => clearTimeout(timer);
  }, [start, selectedDate, cardWidth, view]);
  const shift = (direction: number) => {
    if (view === "month") {
      setStart(
        isoDate(
          new Date(
            Number(start.slice(0, 4)),
            Number(start.slice(5, 7)) - 1 + direction,
            1,
          ),
        ),
      );
      return;
    }
    const nextSelected = shiftDate(selectedDate, direction * 7);
    setSelectedDate(nextSelected);
    setStart(weekRange(nextSelected).start);
  };
  const dayCard = (date: string) => {
    const day = new Date(`${date}T12:00:00`),
      meals = forDate(date),
      isToday = date === today;
    const macros = plannedNutrition(meals,c.recipes,c.meals);
    const perServing = plannedNutrition(meals,c.recipes,c.meals,'per-serving');
    const targets = householdTargets(c.settings);
    return (
      <View
        testID={`calendar-day-${date}`}
        style={[
          s.dayCard,
          {
            backgroundColor: colors.surface,
            width: cardWidth,
            height: Math.min(
              Math.max(300, height - 250),
              Math.max(
                280,
                ...days.map(
                  (d) =>
                    (measured[d + ":header"] ?? 96) +
                    (measured[d + ":body"] ?? 140) +
                    (targets.enabled ? (measured[d + ':targets'] ?? 90) : 0) +
                    (forDate(d).some((m) => c.recipes[m.recipeId]?.nutrition)
                      ? (measured[d + ":footer"] ?? 100)
                      : 0) +
                    4,
                ),
              ),
            ),
            marginRight: view === "week" ? gap : 0,
          },
          isToday && { borderWidth: 2, borderColor: colors.primary },
          Shadows.sm,
        ]}
      >
        <View
          style={s.dayCardHeader}
          onLayout={(e) =>
            measure(date + ":header", e.nativeEvent.layout.height)
          }
        >
          <View>
            <Text
              style={[
                s.dayCardWeekday,
                { color: isToday ? colors.primary : colors.textSecondary },
              ]}
            >
              {day.toLocaleDateString(undefined, { weekday: "long" })}
            </Text>
            <Text style={[s.dayCardDate, { color: colors.text }]}>
              {day.toLocaleDateString(undefined, {
                day: "numeric",
                month: "short",
              })}
            </Text>
          </View>
          <IconButton
            icon="add-circle-outline"
            label={`Add meal for ${date}`}
            onPress={() =>
              onAdd(
                date,
                ["dinner", "lunch", "breakfast", "snack", "dessert"].find(
                  (t) =>
                    !meals.some(
                      (m) => m.mealType === t && m.status !== "skipped",
                    ),
                ) || "dinner",
              )
            }
          />
          {isToday && (
            <View style={[s.todayPill, { backgroundColor: colors.primary }]}>
              <Text style={[s.todayPillText, { color: colors.textInverse }]}>
                Today
              </Text>
            </View>
          )}
        </View>
        {targets.enabled && <View onLayout={e => measure(date + ':targets', e.nativeEvent.layout.height)} style={{paddingHorizontal:16,paddingBottom:8,gap:4}}>
          <Caption>Daily goal · {targets.adults} adults · {targets.children} children</Caption>
          {!targets.complete ? <Caption>Complete all nutrition target slots in Settings.</Caption> :
            (['calories','protein'] as const).map(key => <View key={key} style={{gap:3}}>
              <Caption>{macros[key] === undefined ? '—' : Math.round(macros[key]!)} / {targets[key]} {key === 'calories' ? 'kcal' : 'g protein'}{macros.incomplete ? ' · incomplete' : ''}</Caption>
              {macros[key] !== undefined && <View accessibilityRole="progressbar" accessibilityLabel={key + ' planned household nutrition'} accessibilityValue={{min:0,max:targets[key],now:Math.min(macros[key]!,targets[key]!)}}
                style={{height:5,backgroundColor:colors.borderLight,borderRadius:3}}><View style={{height:5,borderRadius:3,backgroundColor:colors.primary,width:Math.min(100,macros[key]!/targets[key]!*100)+'%' as `${number}%`}} /></View>}
            </View>)}
        </View>}
        <ScrollView scrollEnabled={!dragging}
          nestedScrollEnabled
          style={{ flex: 1 }}
          contentContainerStyle={{ flexGrow: 1 }}
        >
          {!meals.length ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Add meal for ${date}`}
              onPress={() => onAdd(date)}
              style={s.cardEmptyWrap}
              onLayout={(e) =>
                measure(date + ":body", e.nativeEvent.layout.height)
              }
            >
              <Text style={{ fontSize: 36 }}>🍽️</Text>
              <Text style={[s.cardEmptyText, { color: colors.textSecondary }]}>
                No meals planned
              </Text>
            </Pressable>
          ) : (
            <View
              style={s.cardMeals}
              onLayout={(e) =>
                measure(date + ":body", e.nativeEvent.layout.height)
              }
            >
              {meals.map((m) => {
                const recipe = c.recipes[m.recipeId],
                  [bg, , emoji] = badge(m.mealType);
                const parts = [recipe, ...(m.sides ?? []).map(side => c.recipes[side.recipeId])];
                const needsDefrost = parts.some(part => part?.needsDefrost);
                const needsMarinate = parts.some(part => part?.needsMarinate);
                return (
                  <View key={m.id} style={{ gap: 4 }}>
                    <View
                      style={[
                        s.cardMealRow,
                        {
                          backgroundColor: colors.background,
                          opacity: m.status === "skipped" ? 0.5 : 1,
                          gap: 2,
                        },
                      ]}
                    >
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={title(m)}
                        disabled={!!pendingMove}
                        delayLongPress={450}
                        onLongPress={() => {if (view !== "week" || !c.online || pendingRef.current) return; bounds.current={};dragRef.current=m;setDragging(m);}}
                        onPress={() =>
                          m.kind === "eating-out" ? onOptions(m) : onPreview(m)
                        }
                        style={[
                          s.cardMealPreview,
                          {
                            flexWrap: fontScale > 1.3 ? "wrap" : "nowrap",
                            gap: 8,
                          },
                        ]}
                      >
                        <View
                          style={[
                            s.mealBadge,
                            { backgroundColor: bg, paddingHorizontal: 7 },
                          ]}
                        >
                          <Text
                            accessibilityLabel={m.mealType}
                            style={{ fontSize: 16 }}
                          >
                            {emoji}
                          </Text>
                        </View>
                        <View style={s.cardMealInfo}>
                          <Text
                            style={[s.cardMealTitle, { color: colors.text }]}
                          >
                            {title(m)}
                          </Text>
                          <View
                            style={[s.cardMealMetaRow, { flexWrap: "wrap" }]}
                          >
                            <Text
                              style={[
                                s.cardMealMeta,
                                { color: colors.textSecondary },
                              ]}
                            >
                              {recipe?.totalTime ||
                                (recipe
                                  ? `${recipe.prepTime} prep`
                                  : m.mealType)}
                              {m.status !== "planned" ? ` · ${m.status}` : ""}
                              {` · ${m.servings} servings`}
                            </Text>
                          </View>
                          {!!m.sides?.length && (
                            <Caption>
                              +{" "}
                              {m.sides
                                .map(
                                  (side) =>
                                    c.recipes[side.recipeId]?.title || "Side",
                                )
                                .join(", ")}
                            </Caption>
                          )}
                        </View>
                        {recipe?.imageUrl ? (
                          <Image
                            source={{ uri: recipe.imageUrl }}
                            style={s.mealRowThumb}
                            accessibilityIgnoresInvertColors
                          />
                        ) : m.kind === "eating-out" ? (
                          <Text style={{ fontSize: 24 }}>🥂</Text>
                        ) : null}
                      </Pressable>
                      <IconButton
                        icon="ellipsis-horizontal"
                        label={`Options for ${title(m)}`}
                        onPress={() => onOptions(m)}
                      />
                    </View>
                    {(needsDefrost || needsMarinate) &&
                      m.kind === "recipe" && m.status === "planned" && (
                        <Caption>
                          {needsDefrost ? "❄️ Defrost ahead  " : ""}
                          {needsMarinate ? "⏱ Marinate ahead" : ""}
                        </Caption>
                      )}
                  </View>
                );
              })}
            </View>
          )}
        </ScrollView>
        {macros.meals > 0 && (
          <View
            onLayout={(e) =>
              measure(date + ":footer", e.nativeEvent.layout.height)
            }
          >
            <View
              style={[
                s.cardMacroStrip,
                {
                  borderTopColor: colors.borderLight,
                  flexWrap: fontScale > 1.3 ? "wrap" : "nowrap",
                },
              ]}
            >
              {(
                [
                  [
                    "calories",
                    "kcal",
                    colors.caloriesText,
                    colors.caloriesBadge,
                  ],
                  [
                    "protein",
                    "protein",
                    colors.proteinText,
                    colors.proteinBadge,
                  ],
                  ["carbs", "carbs", colors.carbsText, colors.carbsBadge],
                  ["fat", "fat", colors.fatText, colors.fatBadge],
                ] as const
              ).map(([key, label, fg, bg]) => (
                <View
                  key={key}
                  style={[
                    s.cardMacro,
                    {
                      backgroundColor: bg,
                      minWidth: fontScale > 1.3 ? "40%" : undefined,
                    },
                  ]}
                >
                  <Text style={[s.cardMacroValue, { color: fg }]}>
                    {perServing[key] === undefined
                      ? "—"
                      : `${Math.round(perServing[key]!)}${key === "calories" ? "" : "g"}`}
                  </Text>
                  <Text style={[s.cardMacroLabel, { color: fg }]}>{label}</Text>
                </View>
              ))}
            </View>
            {(perServing.incomplete || perServing.estimated) && <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
              <Caption>
                {[perServing.incomplete && 'Incomplete data', perServing.estimated && 'Estimated after substitutions'].filter(Boolean).join(' · ')}
              </Caption>
            </View>}
          </View>
        )}
      </View>
    );
  };
  const first = new Date(`${start.slice(0, 7)}-01T12:00:00`),
    leading = (first.getDay() + 6) % 7,
    count = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.background }}
      edges={["top", "left", "right"]}
    >
      <View
        {...pan.panHandlers}
        onTouchEnd={e => {if(dragRef.current) finishRef.current(e.nativeEvent.pageX,e.nativeEvent.pageY);}}
        onTouchCancel={() => {dragRef.current=null;setDragging(null);setHoverDate(null);}}
        style={{ flex: 1, width: "100%", maxWidth: 880, alignSelf: "center" }}
      >
        <View style={[s.screenHeader, { flexWrap: "wrap", gap: 6 }]}>
          <Text style={[s.screenTitle, { color: colors.text, flex: 1 }]}>
            Calendar
          </Text>
          <View style={[s.toggle, { backgroundColor: colors.surface }]}>
            {(["week", "month"] as const).map((mode) => (
              <Pressable
                key={mode}
                accessibilityRole="button"
                accessibilityState={{ selected: view === mode }}
                style={[
                  s.toggleBtn,
                  {
                    minHeight: 44,
                    justifyContent: "center",
                    paddingHorizontal: 14,
                  },
                  view === mode && { backgroundColor: colors.primary },
                ]}
                onPress={() => {
                  setView(mode);
                  if (mode === "week") setStart(weekRange(start).start);
                }}
              >
                <Text
                  style={[
                    s.toggleText,
                    {
                      color:
                        view === mode
                          ? colors.textInverse
                          : colors.textSecondary,
                    },
                  ]}
                >
                  {mode === "week" ? "Week" : "Month"}
                </Text>
              </Pressable>
            ))}
          </View>
          <IconButton
            icon="ellipsis-horizontal"
            label="Calendar options"
            onPress={onTemplates}
          />
        </View>
        <StatusNotice />
        <View style={s.navRow}>
          <IconButton
            icon="chevron-back"
            label="Previous dates"
            onPress={() => shift(-1)}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Go to today"
            onPress={() => {
              setSelectedDate(today);
              setStart(view === "month" ? today : weekRange(today).start);
            }}
            style={{ flex: 1 }}
          >
            <Text
              style={[s.navLabel, { color: colors.text, textAlign: "center" }]}
            >
              {view === "month"
                ? first.toLocaleDateString(undefined, {
                    month: "long",
                    year: "numeric",
                  })
                : `${new Date(`${start}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" })} – ${new Date(`${shiftDate(start, 6)}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`}
            </Text>
          </Pressable>
          <IconButton
            icon="chevron-forward"
            label="Next dates"
            onPress={() => shift(1)}
          />
        </View>
        {view === "week" ? (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 32 }}
          >
            <FlatList
              ref={list}
              horizontal
              data={days}
              scrollEnabled={!dragging}
              keyExtractor={(d) => d}
              showsHorizontalScrollIndicator={false}
              snapToInterval={cardWidth + gap}
              decelerationRate="fast"
              onMomentumScrollEnd={(event) => {
                const index = Math.max(0, Math.min(6, Math.round(
                  event.nativeEvent.contentOffset.x / (cardWidth + gap),
                )));
                setSelectedDate(days[index]);
              }}
              contentContainerStyle={[
                s.carouselContent,
                { paddingHorizontal: (pageWidth - cardWidth) / 2 },
              ]}
              renderItem={({ item }) => dayCard(item)}
            />
          </ScrollView>
        ) : (
          <ScrollView contentContainerStyle={s.monthScroll}>
            <View style={s.dowRow}>
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
                <Text
                  key={d}
                  style={[s.dowLabel, { color: colors.textSecondary }]}
                >
                  {d}
                </Text>
              ))}
            </View>
            {Array.from(
              { length: Math.ceil((leading + count) / 7) },
              (_, row) => (
                <View key={row} style={s.gridRow}>
                  {Array.from({ length: 7 }, (_, col) => {
                    const num = row * 7 + col - leading + 1;
                    if (num < 1 || num > count)
                      return <View key={col} style={s.gridCell} />;
                    const date = `${start.slice(0, 7)}-${String(num).padStart(2, "0")}`,
                      meals = forDate(date);
                    return (
                      <Pressable
                        key={col}
                        accessibilityRole="button"
                        accessibilityLabel={`${date}, ${meals.length} meals`}
                        onPress={() => {
                          setSelectedDate(date);
                          setStart(weekRange(date).start);
                          setView("week");
                        }}
                        style={[
                          s.gridCell,
                          date === today && {
                            backgroundColor: colors.primaryLight,
                            borderRadius: 12,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            s.gridDayNum,
                            {
                              color:
                                date === today ? colors.primary : colors.text,
                            },
                          ]}
                        >
                          {num}
                        </Text>
                        {meals.slice(0, 2).map((m) => (
                          <View
                            key={m.id}
                            style={[
                              s.gridMealPill,
                              { backgroundColor: badge(m.mealType)[0] },
                            ]}
                          >
                            <Text
                              numberOfLines={1}
                              style={[
                                s.gridMealText,
                                { color: badge(m.mealType)[1], fontSize: 10 },
                              ]}
                            >
                              {title(m)}
                            </Text>
                          </View>
                        ))}
                        {meals.length > 2 && (
                          <Caption>+{meals.length - 2}</Caption>
                        )}
                      </Pressable>
                    );
                  })}
                </View>
              ),
            )}
          </ScrollView>
        )}
        {pendingMove && <View style={{position:'absolute',top:75,left:16,right:16,padding:12,backgroundColor:colors.surface,borderRadius:12}}><Caption>Moving meal…</Caption></View>}
        {dragging && <View pointerEvents="none" style={{position:'absolute',top:75,left:8,right:8,padding:8,backgroundColor:colors.surface,borderWidth:1,borderColor:colors.primary,borderRadius:12,gap:6}}>
          <Caption>Drop {title(dragging)} onto a date</Caption>
          <View style={{flexDirection:'row',flexWrap:'wrap',gap:4}}>{days.map(date => <View key={date} ref={v=>{targetRefs.current[date]=v;}}
            onLayout={()=>targetRefs.current[date]?.measureInWindow((x,y,width,height)=>{bounds.current[date]={x,y,width,height};})}
            style={{minWidth:70,flexGrow:1,minHeight:56,padding:8,borderRadius:8,backgroundColor:hoverDate===date ? colors.primaryLight : colors.background}}>
            <Caption>{new Date(date+'T12:00:00').toLocaleDateString(undefined,{weekday:'short',day:'numeric'})}</Caption>
          </View>)}</View>
          <Caption>Release outside these dates to cancel. Use Move to date for another week.</Caption>
        </View>}
        {children}
      </View>
    </SafeAreaView>
  );
}
