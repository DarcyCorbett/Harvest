// ============================================================
// Meal Wizard — Time Picker Modal
// A styled, premium cross-platform hour/minute selector.
// Zero-dependency alternative to @react-native-community/datetimepicker.
// ============================================================

import { FontSizes, Fonts, Radius, Shadows, Spacing } from '@/constants/theme';
import { useTheme } from '@/contexts/ThemeContext';
import { Ionicons } from '@expo/vector-icons';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  FlatList,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Dimensions,
} from 'react-native';

interface TimePickerModalProps {
  visible: boolean;
  value: string; // "HH:MM" e.g. "07:30"
  onClose: () => void;
  onSelect: (time: string) => void;
  title?: string;
}

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));

export default function TimePickerModal({
  visible,
  value,
  onClose,
  onSelect,
  title = 'Select Time',
}: TimePickerModalProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [selectedHour, setSelectedHour] = useState('07');
  const [selectedMinute, setSelectedMinute] = useState('30');

  const hourListRef = useRef<FlatList>(null);
  const minuteListRef = useRef<FlatList>(null);

  // Parse initial value on mount/visible
  useEffect(() => {
    if (visible && value) {
      const parts = value.split(':');
      if (parts.length === 2) {
        const hh = parts[0];
        const mm = parts[1];
        if (HOURS.includes(hh)) setSelectedHour(hh);
        if (MINUTES.includes(mm)) setSelectedMinute(mm);
      }
    }
  }, [visible, value]);

  // Auto-scroll selected items into view when modal opens
  const latestHour = useRef(selectedHour);
  const latestMinute = useRef(selectedMinute);

  useEffect(() => {
    latestHour.current = selectedHour;
  }, [selectedHour]);

  useEffect(() => {
    latestMinute.current = selectedMinute;
  }, [selectedMinute]);

  useEffect(() => {
    if (visible) {
      setTimeout(() => {
        const hIdx = HOURS.indexOf(latestHour.current);
        if (hIdx !== -1 && hourListRef.current) {
          hourListRef.current.scrollToIndex({ index: hIdx, animated: true, viewPosition: 0.5 });
        }
        const mIdx = MINUTES.indexOf(latestMinute.current);
        if (mIdx !== -1 && minuteListRef.current) {
          minuteListRef.current.scrollToIndex({ index: mIdx, animated: true, viewPosition: 0.5 });
        }
      }, 150);
    }
  }, [visible]);

  const handleDone = () => {
    onSelect(`${selectedHour}:${selectedMinute}`);
    onClose();
  };

  const renderItem = (
    item: string,
    isSelected: boolean,
    onPress: () => void
  ) => {
    return (
      <TouchableOpacity
        onPress={onPress}
        style={[
          styles.itemBtn,
          isSelected && { backgroundColor: colors.primaryLight, borderColor: colors.primary },
        ]}
        activeOpacity={0.7}
      >
        <Text
          style={[
            styles.itemText,
            isSelected && { color: colors.primary, fontFamily: Fonts.bold },
          ]}
        >
          {item}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent={true}
      onRequestClose={onClose}
    >
      <View style={styles.modalOverlay}>
        <View style={[styles.modalContainer, Shadows.lg]}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.headerTitle}>{title}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Selectors */}
          <View style={styles.pickerRow}>
            {/* Hours Column */}
            <View style={styles.columnWrap}>
              <Text style={styles.columnLabel}>Hour</Text>
              <FlatList
                ref={hourListRef}
                data={HOURS}
                keyExtractor={(item) => item}
                getItemLayout={(_, index) => ({ length: 48, offset: 48 * index, index })}
                showsVerticalScrollIndicator={false}
                renderItem={({ item }) =>
                  renderItem(item, item === selectedHour, () => setSelectedHour(item))
                }
                style={styles.list}
              />
            </View>

            <View style={styles.pickerSeparator}>
              <Text style={styles.separatorText}>:</Text>
            </View>

            {/* Minutes Column */}
            <View style={styles.columnWrap}>
              <Text style={styles.columnLabel}>Minute</Text>
              <FlatList
                ref={minuteListRef}
                data={MINUTES}
                keyExtractor={(item) => item}
                getItemLayout={(_, index) => ({ length: 48, offset: 48 * index, index })}
                showsVerticalScrollIndicator={false}
                renderItem={({ item }) =>
                  renderItem(item, item === selectedMinute, () => setSelectedMinute(item))
                }
                style={styles.list}
              />
            </View>
          </View>

          {/* Footer Buttons */}
          <View style={styles.footer}>
            <TouchableOpacity style={styles.cancelBtn} onPress={onClose} activeOpacity={0.75}>
              <Text style={[styles.btnText, { color: colors.textSecondary }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.confirmBtn} onPress={handleDone} activeOpacity={0.75}>
              <Text style={[styles.btnText, { color: colors.textInverse }]}>Confirm</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    modalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.4)',
      justifyContent: 'center',
      alignItems: 'center',
    },
    modalContainer: {
      width: Dimensions.get('window').width * 0.8,
      backgroundColor: colors.surface,
      borderRadius: Radius.lg,
      padding: Spacing.md,
      maxHeight: Dimensions.get('window').height * 0.5,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      borderBottomWidth: 1,
      borderBottomColor: colors.borderLight,
      paddingBottom: Spacing.sm,
      marginBottom: Spacing.md,
    },
    headerTitle: {
      fontSize: FontSizes.md,
      fontFamily: Fonts.bold,
      color: colors.text,
    },
    pickerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      height: 180,
    },
    columnWrap: {
      flex: 1,
      alignItems: 'center',
      height: '100%',
    },
    columnLabel: {
      fontSize: FontSizes.xs,
      fontFamily: Fonts.semibold,
      color: colors.textSecondary,
      marginBottom: Spacing.xs,
    },
    list: {
      width: '100%',
      flex: 1,
    },
    pickerSeparator: {
      paddingHorizontal: Spacing.xs,
      justifyContent: 'center',
    },
    separatorText: {
      fontSize: FontSizes.xl,
      fontFamily: Fonts.bold,
      color: colors.textSecondary,
    },
    itemBtn: {
      height: 40,
      width: '100%',
      justifyContent: 'center',
      alignItems: 'center',
      borderRadius: Radius.md,
      borderWidth: 1.5,
      borderColor: 'transparent',
      marginVertical: 2,
    },
    itemText: {
      fontSize: FontSizes.md,
      fontFamily: Fonts.regular,
      color: colors.text,
    },
    footer: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: Spacing.sm,
      borderTopWidth: 1,
      borderTopColor: colors.borderLight,
      paddingTop: Spacing.sm,
      marginTop: Spacing.md,
    },
    cancelBtn: {
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.pill,
      borderWidth: 1.5,
      borderColor: colors.border,
    },
    confirmBtn: {
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.pill,
      backgroundColor: colors.primary,
    },
    btnText: {
      fontSize: FontSizes.sm,
      fontFamily: Fonts.semibold,
    },
  });
