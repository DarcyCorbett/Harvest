import { Alert, Platform } from 'react-native';

/**
 * Ask before a destructive action. react-native-web's Alert.alert is a no-op,
 * so on web this uses the browser's confirm dialog instead; otherwise the
 * action could never be confirmed (or would run unasked).
 */
export function confirmAction(options: {
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
}): Promise<boolean> {
  if (Platform.OS === 'web') {
    const confirm = typeof window !== 'undefined' ? window.confirm : undefined;
    return Promise.resolve(confirm ? confirm(`${options.title}\n\n${options.message}`) : false);
  }
  return new Promise(resolve => {
    Alert.alert(options.title, options.message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: options.confirmLabel, style: options.destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}
