import { useRef, useState } from 'react';
import { Redirect, router } from 'expo-router';
import { StyleSheet, View, type TextInput } from 'react-native';
import { spacing } from '@sheer/design-tokens';
import {
  AuthField,
  AuthLayout,
  AuthSwitch,
  BrandMark,
  FormMessage,
  PrimaryButton,
} from '../src/auth/AuthUi';
import { useAuth } from '../src/auth/AuthProvider';

export default function LoginScreen() {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const passwordRef = useRef<TextInput>(null);

  if (auth.user) {
    return <Redirect href={auth.user.primaryRole === 'stylist' ? '/performance' : '/dashboard'} />;
  }

  const canSubmit = email.trim().length > 0 && password.length > 0 && !isSubmitting;

  async function onSubmit() {
    if (!canSubmit) return;
    setError(null);
    setIsSubmitting(true);

    try {
      const signedInUser = await auth.signIn(email.trim(), password);
      router.replace(signedInUser.primaryRole === 'stylist' ? '/performance' : '/dashboard');
    } catch {
      setError('Sign in failed. Check your details, or use an active QLOOQO account for this app.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AuthLayout
      footer={
        <AuthSwitch
          prompt="New to QLOOQO?"
          actionLabel="Create an account"
          onPress={() => router.push('/signup')}
        />
      }
    >
      <BrandMark title="Welcome back" subtitle="Sign in with your personal QLOOQO credentials." />

      <View style={styles.form}>
        <AuthField
          label="Email"
          icon="mail-outline"
          value={email}
          onChangeText={setEmail}
          placeholder="you@email.com"
          autoCapitalize="none"
          autoComplete="email"
          inputMode="email"
          keyboardType="email-address"
          returnKeyType="next"
          onSubmitEditing={() => passwordRef.current?.focus()}
          editable={!isSubmitting}
        />
        <AuthField
          ref={passwordRef}
          label="Password"
          icon="lock-closed-outline"
          value={password}
          onChangeText={setPassword}
          placeholder="Your password"
          autoCapitalize="none"
          autoComplete="password"
          isPassword
          returnKeyType="go"
          onSubmitEditing={onSubmit}
          editable={!isSubmitting}
        />

        {error ? <FormMessage tone="error">{error}</FormMessage> : null}

        <PrimaryButton
          label="Sign in"
          loading={isSubmitting}
          disabled={!canSubmit}
          onPress={onSubmit}
        />
      </View>
    </AuthLayout>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: spacing.base,
  },
});
