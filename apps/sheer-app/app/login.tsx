import { useState } from 'react';
import { Redirect, router } from 'expo-router';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { palette, radius, spacing } from '@sheer/design-tokens';
import { AppButton, Card, Screen, SectionHeader } from '@sheer/ui-mobile';
import { useAuth } from '../src/auth/AuthProvider';

export default function LoginScreen() {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (auth.user) {
    return <Redirect href={auth.user.primaryRole === 'stylist' ? '/performance' : '/dashboard'} />;
  }

  async function onSubmit() {
    setError(null);
    setIsSubmitting(true);

    try {
      const signedInUser = await auth.signIn(email, password);
      router.replace(signedInUser.primaryRole === 'stylist' ? '/performance' : '/dashboard');
    } catch {
      setError('Sign in failed. Use an active QLOOQO account for this app.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Screen>
      <Card>
        <SectionHeader
          title="Welcome back"
          subtitle="Sign in with your personal QLOOQO credentials."
        />
        <View style={styles.form}>
          <TextInput
            autoCapitalize="none"
            autoComplete="email"
            inputMode="email"
            onChangeText={setEmail}
            placeholder="Email"
            placeholderTextColor="rgba(255,255,255,0.4)"
            style={styles.input}
            value={email}
          />
          <TextInput
            autoCapitalize="none"
            onChangeText={setPassword}
            placeholder="Password"
            placeholderTextColor="rgba(255,255,255,0.4)"
            secureTextEntry
            style={styles.input}
            value={password}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>
        <AppButton
          label={isSubmitting ? 'Signing in...' : 'Sign in'}
          disabled={isSubmitting}
          onPress={onSubmit}
        />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: spacing.sm,
  },
  input: {
    minHeight: 52,
    borderRadius: radius.input,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    color: palette.white,
    paddingHorizontal: spacing.base,
  },
  error: {
    color: '#FCA5A5',
  },
});
