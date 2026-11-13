// Original Calendar presentation, retained for the connected workflow.
import { StyleSheet } from "react-native";
import { Fonts, FontSizes, Spacing, Radius } from "@/constants/theme";
export const calendarStyles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },

  // Header
  screenHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.md,
  },
  screenTitle: { fontSize: FontSizes.xxl, fontFamily: Fonts.bold },

  // Week/Month toggle
  toggle: {
    flexDirection: "row",
    borderRadius: Radius.pill,
    padding: 2,
  },
  toggleBtn: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.xs,
    borderRadius: Radius.pill,
  },
  toggleText: { fontSize: FontSizes.sm, fontFamily: Fonts.medium },

  // Navigation row
  navRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
  },
  navLabel: { fontSize: FontSizes.md, fontFamily: Fonts.semibold },

  // ── Weekly carousel ──
  carouselContent: {
    paddingVertical: Spacing.xl,
    alignItems: "flex-start",
  },

  // Day card
  dayCard: {
    borderRadius: Radius.xxl,
    overflow: "hidden",
  },
  dayCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.xl,
    paddingBottom: Spacing.md,
  },
  dayCardWeekday: {
    fontSize: FontSizes.xs,
    fontFamily: Fonts.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  dayCardDate: {
    fontSize: FontSizes.xl,
    fontFamily: Fonts.bold,
    marginTop: 2,
  },
  todayPill: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
    borderRadius: Radius.pill,
  },
  todayPillText: {
    color: "#fff",
    fontSize: FontSizes.xs,
    fontFamily: Fonts.bold,
  },

  // Card empty state
  cardEmptyWrap: {
    alignItems: "center",
    paddingVertical: Spacing.massive,
    gap: Spacing.sm,
  },
  cardEmptyText: {
    fontSize: FontSizes.sm,
    fontFamily: Fonts.regular,
  },

  // Card meals
  cardMeals: {
    paddingHorizontal: Spacing.md,
    gap: Spacing.xs,
    paddingBottom: Spacing.md,
  },
  cardMealRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    padding: Spacing.sm,
    borderRadius: Radius.xl,
  },
  cardMealPreview: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
  },
  cardMealInfo: { flex: 1 },
  cardMealTitle: {
    fontSize: FontSizes.md,
    fontFamily: Fonts.semibold,
    lineHeight: 20,
  },
  cardMealMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.xs,
    marginTop: 2,
  },
  cardMealMeta: { fontSize: FontSizes.xs, fontFamily: Fonts.regular },
  reminderChips: { flexDirection: "row", gap: 4 },
  reminderChip: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  mealRowThumb: {
    width: 44,
    height: 44,
    borderRadius: Radius.md,
    flexShrink: 0,
  },

  mealBadge: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xxs,
    borderRadius: Radius.pill,
    flexShrink: 0,
  },
  mealBadgeText: { fontSize: FontSizes.xs, fontFamily: Fonts.semibold },

  // Card macro strip
  cardMacroStrip: {
    flexDirection: "row",
    borderTopWidth: 1,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    gap: Spacing.xs,
  },
  cardMacro: {
    flex: 1,
    alignItems: "center",
    paddingVertical: Spacing.xs,
    borderRadius: Radius.md,
    gap: 1,
  },
  cardMacroValue: { fontSize: FontSizes.xs, fontFamily: Fonts.bold },
  cardMacroLabel: { fontSize: 9, fontFamily: Fonts.regular },

  // ── Month view ──
  monthScroll: { padding: Spacing.lg, paddingBottom: Spacing.massive },

  dowRow: { flexDirection: "row", marginBottom: Spacing.sm },
  dowLabel: {
    flex: 1,
    textAlign: "center",
    fontSize: FontSizes.xs,
    fontFamily: Fonts.medium,
  },

  gridRow: { flexDirection: "row", marginBottom: 4 },
  gridCell: {
    flex: 1,
    alignItems: "center",
    paddingVertical: Spacing.xs,
    paddingHorizontal: 2,
    minHeight: 92,
  },
  gridDayNum: {
    fontSize: FontSizes.sm,
    fontFamily: Fonts.medium,
    marginBottom: 3,
  },

  gridMealPill: {
    borderRadius: Radius.sm,
    paddingHorizontal: 3,
    paddingVertical: 1,
    marginBottom: 2,
    maxWidth: "100%",
  },
  gridMealText: {
    fontSize: 8,
    fontFamily: Fonts.semibold,
  },
  gridOverflow: {
    fontSize: 8,
    fontFamily: Fonts.medium,
    marginTop: 1,
  },

  // ── Empty state ──
  emptyWrap: {
    alignItems: "center",
    paddingTop: Spacing.massive,
    gap: Spacing.md,
  },
  emptyTitle: { fontSize: FontSizes.xl, fontFamily: Fonts.bold },
  emptyHint: {
    fontSize: FontSizes.md,
    fontFamily: Fonts.regular,
    textAlign: "center",
    lineHeight: 22,
  },
});
