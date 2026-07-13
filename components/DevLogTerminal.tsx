import React, { useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  Platform,
  DimensionValue,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useDeveloperMode, DevLog } from '@/contexts/DeveloperModeContext';
import { Radius, Spacing, Fonts } from '@/constants/theme';

interface DevLogTerminalProps {
  maxHeight?: DimensionValue;
}

export function DevLogTerminal({ maxHeight = 280 }: DevLogTerminalProps) {
  const { logs, clearLogs } = useDeveloperMode();
  const scrollViewRef = useRef<ScrollView>(null);
  const [isAutoScrollEnabled, setIsAutoScrollEnabled] = React.useState(true);

  // Helper to format timestamp to HH:MM:SS.mmm
  const formatTime = (date: Date) => {
    const d = new Date(date);
    const pad = (n: number, l = 2) => String(n).padStart(l, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(
      d.getMilliseconds(),
      3
    )}`;
  };

  const handleScroll = (event: any) => {
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
    const paddingToBottom = 30; // 30px threshold
    const isAtBottom =
      layoutMeasurement.height + contentOffset.y >=
      contentSize.height - paddingToBottom;

    if (isAutoScrollEnabled !== isAtBottom) {
      setIsAutoScrollEnabled(isAtBottom);
    }
  };

  // Auto-scroll when logs change (only if auto-scroll is enabled)
  useEffect(() => {
    if (isAutoScrollEnabled && scrollViewRef.current) {
      scrollViewRef.current.scrollToEnd({ animated: true });
    }
  }, [logs.length, isAutoScrollEnabled]);

  // Color code tags parsed from messages like "[Tag] Message"
  const renderLogContent = (log: DevLog) => {
    const text = log.text;
    const match = text.match(/^(\[[a-zA-Z0-9_\-\s]+\])(.*)$/s);

    let textColor = '#E4E4E7'; // default zinc-200
    if (log.type === 'warn') textColor = '#FBBF24'; // amber-400
    if (log.type === 'error') textColor = '#F87171'; // red-400

    if (match) {
      const tag = match[1];
      const rest = match[2];
      let tagColor = '#A1A1AA'; // default zinc-400

      const tagLower = tag.toLowerCase();
      if (tagLower.includes('generator')) tagColor = '#60A5FA'; // blue-400
      else if (tagLower.includes('scraper') || tagLower.includes('index')) tagColor = '#34D399'; // emerald-400
      else if (tagLower.includes('gemini') || tagLower.includes('tagger')) tagColor = '#C084FC'; // purple-400
      else if (tagLower.includes('shopping') || tagLower.includes('confirm') || tagLower.includes('background')) tagColor = '#F472B6'; // pink-400
      else if (tagLower.includes('auth')) tagColor = '#F59E0B'; // amber-500
      else if (tagLower.includes('theme')) tagColor = '#2DD4BF'; // teal-400

      return (
        <Text style={[styles.logText, { color: textColor }]}>
          <Text style={[styles.logTag, { color: tagColor }]}>{tag}</Text>
          {rest}
        </Text>
      );
    }

    return <Text style={[styles.logText, { color: textColor }]}>{text}</Text>;
  };

  const getLogTypeBadge = (type: 'log' | 'warn' | 'error') => {
    if (type === 'warn') {
      return <Text style={[styles.typeBadge, styles.warnBadge]}>[WRN]</Text>;
    }
    if (type === 'error') {
      return <Text style={[styles.typeBadge, styles.errorBadge]}>[ERR]</Text>;
    }
    return <Text style={[styles.typeBadge, styles.infoBadge]}>[LOG]</Text>;
  };

  return (
    <View style={[styles.container, { maxHeight, flex: 1 }]}>
      {/* Terminal Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Ionicons name="terminal" size={16} color="#34D399" style={styles.headerIcon} />
          <Text style={styles.headerTitle}>EXECUTION LOGS</Text>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{logs.length}</Text>
          </View>
        </View>
        <TouchableOpacity style={styles.clearButton} onPress={clearLogs} activeOpacity={0.7}>
          <Ionicons name="trash-outline" size={14} color="#EF4444" />
          <Text style={styles.clearButtonText}>Clear</Text>
        </TouchableOpacity>
      </View>

      {/* Terminal Output */}
      <ScrollView
        ref={scrollViewRef}
        style={styles.terminalBody}
        contentContainerStyle={styles.terminalContent}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        onContentSizeChange={() => {
          if (isAutoScrollEnabled) {
            scrollViewRef.current?.scrollToEnd({ animated: true });
          }
        }}
        nestedScrollEnabled
      >
        {logs.length === 0 ? (
          <Text style={styles.emptyText}>Terminal idle. Awaiting operations...</Text>
        ) : (
          logs.map((log) => (
            <View key={log.id} style={styles.logLine}>
              <Text style={styles.timestamp}>{formatTime(log.timestamp)}</Text>
              {getLogTypeBadge(log.type)}
              <View style={styles.textContainer}>{renderLogContent(log)}</View>
            </View>
          ))
        )}
      </ScrollView>

      {/* Floating autoscroll resume badge */}
      {!isAutoScrollEnabled && logs.length > 0 && (
        <TouchableOpacity
          style={styles.autoscrollBadge}
          onPress={() => {
            setIsAutoScrollEnabled(true);
            scrollViewRef.current?.scrollToEnd({ animated: true });
          }}
          activeOpacity={0.85}
        >
          <Ionicons name="arrow-down-circle" size={14} color="#10B981" />
          <Text style={styles.autoscrollBadgeText}>Auto-scroll Paused (Tap to Resume)</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    backgroundColor: '#121214', // sleek warm obsidian
    borderRadius: Radius.md,
    borderWidth: 1.5,
    borderColor: '#2A2A30', // sharp dark borders
    overflow: 'hidden',
    marginTop: Spacing.sm,
    marginBottom: Spacing.sm,
    ...Platform.select({
      android: {
        elevation: 3,
      },
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 6,
      },
    }),
  },
  header: {
    height: 40,
    backgroundColor: '#1C1C21', // lighter header for depth
    borderBottomWidth: 1,
    borderBottomColor: '#2A2A30',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerIcon: {
    marginRight: Spacing.xs,
  },
  headerTitle: {
    fontFamily: Fonts.bold,
    fontSize: 11,
    color: '#E4E4E7',
    letterSpacing: 1,
  },
  badge: {
    backgroundColor: '#2D2D34',
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: Radius.pill,
    marginLeft: Spacing.xs,
  },
  badgeText: {
    fontFamily: 'monospace',
    fontSize: 10,
    color: '#10B981',
    fontWeight: 'bold',
  },
  clearButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(239, 68, 68, 0.08)',
    paddingHorizontal: Spacing.xs,
    paddingVertical: Spacing.xxs,
    borderRadius: Radius.xs,
    borderWidth: 0.5,
    borderColor: 'rgba(239, 68, 68, 0.3)',
  },
  clearButtonText: {
    fontFamily: Fonts.semibold,
    fontSize: 11,
    color: '#EF4444',
    marginLeft: 4,
  },
  terminalBody: {
    flex: 1,
    backgroundColor: '#0E0E10',
  },
  terminalContent: {
    padding: Spacing.sm,
  },
  emptyText: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: '#71717A',
    fontStyle: 'italic',
    textAlign: 'center',
    marginTop: Spacing.md,
  },
  logLine: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 5,
  },
  timestamp: {
    fontFamily: 'monospace',
    fontSize: 10,
    color: '#52525B', // dimmed timeline
    marginRight: 6,
    width: 74,
  },
  typeBadge: {
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: 'bold',
    marginRight: 6,
    width: 32,
  },
  infoBadge: {
    color: '#34D399',
  },
  warnBadge: {
    color: '#FBBF24',
  },
  errorBadge: {
    color: '#F87171',
  },
  textContainer: {
    flex: 1,
  },
  logText: {
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 14,
  },
  logTag: {
    fontWeight: 'bold',
  },
  autoscrollBadge: {
    position: 'absolute',
    bottom: Spacing.sm,
    alignSelf: 'center',
    backgroundColor: '#1E1E22',
    borderColor: '#3F3F46',
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingVertical: 5,
    paddingHorizontal: Spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3,
    elevation: 4,
  },
  autoscrollBadgeText: {
    fontFamily: Fonts.semibold,
    fontSize: 10,
    color: '#A1A1AA',
  },
});
