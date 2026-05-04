import { ScrollView, StyleSheet, Text, View, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Link } from 'expo-router';

interface ModuleCard {
  title: string;
  description: string;
  href: string;
}

const MODULES: ModuleCard[] = [
  { title: 'Dashboard', description: 'Today at a glance: bookings, rota, and revenue.', href: '/' },
  { title: 'Performance', description: 'Track stats, goals, commissions, and trends.', href: '/' },
  { title: 'Bookings', description: 'View upcoming appointments and client notes.', href: '/' },
  { title: 'Rota', description: 'See shifts, breaks, and availability.', href: '/' },
];

export default function Home() {
  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.heading}>Sheer App</Text>
        <Text style={styles.subheading}>
          Personal stylist app for dashboard, performance, commissions, bookings, and rota.
        </Text>

        <View style={styles.grid}>
          {MODULES.map((mod) => (
            <Link key={mod.title} href={mod.href} asChild>
              <Pressable style={styles.card}>
                <Text style={styles.cardTitle}>{mod.title}</Text>
                <Text style={styles.cardDescription}>{mod.description}</Text>
              </Pressable>
            </Link>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  content: {
    padding: 20,
    gap: 16,
  },
  heading: {
    fontSize: 24,
    fontWeight: '700',
    color: '#0f172a',
  },
  subheading: {
    fontSize: 14,
    color: '#64748b',
    marginBottom: 8,
  },
  grid: {
    gap: 12,
  },
  card: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    padding: 16,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#0f172a',
    marginBottom: 4,
  },
  cardDescription: {
    fontSize: 13,
    color: '#64748b',
  },
});
