import { SafeAreaView } from 'react-native-safe-area-context';
import { ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { labTheme } from './labTheme';

interface LabScreenProps {
  children: React.ReactNode;
  scroll?: boolean;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
}

export function LabScreen({ children, scroll = true, style, contentStyle }: LabScreenProps) {
  const content = <View style={[styles.content, contentStyle]}>{children}</View>;

  return (
    <SafeAreaView style={[styles.safe, style]} edges={['top', 'right', 'bottom', 'left']}>
      {scroll ? <ScrollView contentContainerStyle={styles.scroll}>{content}</ScrollView> : content}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: labTheme.colors.bg,
  },
  scroll: {
    flexGrow: 1,
  },
  content: {
    flex: 1,
    padding: 24,
    gap: 18,
  },
});
