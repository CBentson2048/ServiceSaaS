import { useRef, useState } from 'react';
import { Redirect, router } from 'expo-router';
import { StyleSheet, Text, View, type TextInput } from 'react-native';
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

export default function SignUpScreen() {
  const auth = useAuth();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const lastRef = useRef<TextInput>(null);
  const emailRef = useRef<TextInput>(null);
  const phoneRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);

  if (auth.user) {
    return <Redirect href={auth.user.primaryRole === 'stylist' ? '/performance' : '/dashboard'} />;
  }

  function backToLogin() {
    if (router.canGoBack()) router.back();
    else router.replace('/login');
  }

  function validate(): string | null {
    if (!firstName.trim()) return 'Please enter your first name.';
    if (!lastName.trim()) return 'Please enter your last name.';
    if (!EMAIL_RE.test(email.trim())) return 'Please enter a valid email address.';
    if (password.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
    return null;
  }

  async function submit() {
    if (submitting) return;
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const user = await auth.signUp({
        email: email.trim(),
        password,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        phone: phone.trim() ? phone.trim() : undefined,
      });
      router.replace(user.primaryRole === 'stylist' ? '/performance' : '/dashboard');
      // Keep the spinner up through the redirect.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'We couldn’t create your account. Please try again.');
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      onBack={backToLogin}
      footer={
        <AuthSwitch prompt="Already have an account?" actionLabel="Sign in" onPress={backToLogin} />
      }
    >
      <BrandMark
        title="Create your account"
        subtitle="One account for every salon you visit. Pick a salon when you book your first appointment."
      />

      <View style={styles.form}>
        <View style={styles.nameRow}>
          <View style={styles.flex}>
            <AuthField
              label="First name"
              icon="person-outline"
              value={firstName}
              onChangeText={setFirstName}
              placeholder="First"
              autoCapitalize="words"
              autoComplete="given-name"
              returnKeyType="next"
              onSubmitEditing={() => lastRef.current?.focus()}
              editable={!submitting}
            />
          </View>
          <View style={styles.flex}>
            <AuthField
              ref={lastRef}
              label="Last name"
              icon="person-outline"
              value={lastName}
              onChangeText={setLastName}
              placeholder="Last"
              autoCapitalize="words"
              autoComplete="family-name"
              returnKeyType="next"
              onSubmitEditing={() => emailRef.current?.focus()}
              editable={!submitting}
            />
          </View>
        </View>

        <AuthField
          ref={emailRef}
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
          onSubmitEditing={() => phoneRef.current?.focus()}
          editable={!submitting}
        />

        <AuthField
          ref={phoneRef}
          label="Phone"
          icon="call-outline"
          hint="Optional — used for booking reminders."
          value={phone}
          onChangeText={setPhone}
          placeholder="+44 7700 900000"
          autoComplete="tel"
          inputMode="tel"
          keyboardType="phone-pad"
          returnKeyType="next"
          onSubmitEditing={() => passwordRef.current?.focus()}
          editable={!submitting}
        />

        <AuthField
          ref={passwordRef}
          label="Password"
          icon="lock-closed-outline"
          hint={`At least ${MIN_PASSWORD} characters.`}
          value={password}
          onChangeText={setPassword}
          placeholder="Create a password"
          autoCapitalize="none"
          autoComplete="password-new"
          isPassword
          returnKeyType="go"
          onSubmitEditing={submit}
          editable={!submitting}
        />

        {error ? <FormMessage tone="error">{error}</FormMessage> : null}

        <PrimaryButton label="Create account" loading={submitting} onPress={submit} />

        <Text style={styles.legal}>
          By creating an account you agree to QLOOQO’s Terms and Privacy Policy.
        </Text>
      </View>
    </AuthLayout>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  form: {
    gap: spacing.base,
  },
  nameRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  legal: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
});
