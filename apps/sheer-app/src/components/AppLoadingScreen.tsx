import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';

// These match the native splash screen configured in app.json (expo-splash-screen),
// so the launch → JS-bootstrap handoff is seamless with no color jump.
const SPLASH_BG = '#4A1828';
const ACCENT = '#E8B4BC';
const WORDMARK = '#F4E4E7';

// React Native loads bundled image assets via require(); there is no static
// module type for *.png in this project, so the lint rule is disabled here.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ICON = require('../../assets/icon.png');

/**
 * Full-screen branded loading state shown while the session bootstraps.
 * Mirrors the native splash (icon on the deep-maroon brand field) so the app
 * appears to continue the splash rather than flashing a different screen.
 */
export function AppLoadingScreen() {
  return (
    <View style={styles.root}>
      <View style={styles.brand}>
        <Image source={ICON} style={styles.logo} resizeMode="contain" />
        <Text style={styles.wordmark}>QLOOQO</Text>
      </View>
      <ActivityIndicator color={ACCENT} style={styles.spinner} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: SPLASH_BG,
  },
  brand: {
    alignItems: 'center',
    gap: 18,
  },
  logo: {
    width: 132,
    height: 132,
    borderRadius: 30,
  },
  wordmark: {
    color: WORDMARK,
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: 5,
  },
  spinner: {
    position: 'absolute',
    bottom: 96,
  },
});
