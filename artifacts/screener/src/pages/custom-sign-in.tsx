/**
 * Custom sign-in page that gates Clerk authentication behind a Circle
 * Space Group membership check.
 *
 * Flow:
 *  1. User enters email → backend calls Circle API to verify membership
 *  2. If not a member → show error, never touch Clerk
 *  3. If member → Clerk sends a 6-digit verification code to that email
 *  4. User enters the code → Clerk creates/resumes the session
 *  5. On subsequent visits, Clerk's session cookie keeps them signed in
 *     automatically (no code needed again until the session expires)
 */

import { useState } from 'react';
import { useSignIn, useSignUp } from '@clerk/react';
import { useLocation } from 'wouter';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

async function preflightCircleCheck(email: string): Promise<boolean> {
  try {
    const res = await fetch(`${window.location.origin}/api/auth/preflight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.authorized === true;
  } catch {
    return false;
  }
}

type Step = 'email' | 'code';

export default function CustomSignInPage() {
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [isNewUser, setIsNewUser] = useState(false);

  const { signIn, setActive: setSignInActive, isLoaded: signInLoaded } = useSignIn();
  const { signUp, setActive: setSignUpActive, isLoaded: signUpLoaded } = useSignUp();
  const [, navigate] = useLocation();

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signInLoaded || !signUpLoaded) return;

    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail) return;

    setLoading(true);
    setError('');

    try {
      // Step 1: Check Circle membership before touching Clerk
      const authorized = await preflightCircleCheck(trimmedEmail);
      if (!authorized) {
        setError(
          "This email isn't authorized. Please use the email address registered in your Circle community.",
        );
        setLoading(false);
        return;
      }

      // Step 2a: Try signing in (existing Clerk user)
      try {
        const result = await signIn!.create({
          strategy: 'email_code',
          identifier: trimmedEmail,
        });
        if (result.status === 'needs_first_factor') {
          setIsNewUser(false);
          setStep('code');
        }
      } catch (signInErr: any) {
        const errCode = signInErr?.errors?.[0]?.code;
        // Step 2b: No Clerk account yet — create one and send verification code
        if (
          errCode === 'form_identifier_not_found' ||
          errCode === 'form_password_incorrect'
        ) {
          await signUp!.create({ emailAddress: trimmedEmail });
          await signUp!.prepareEmailAddressVerification({ strategy: 'email_code' });
          setIsNewUser(true);
          setStep('code');
        } else {
          throw signInErr;
        }
      }
    } catch (err: any) {
      const msg =
        err?.errors?.[0]?.longMessage ||
        err?.errors?.[0]?.message ||
        'Something went wrong. Please try again.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signInLoaded || !signUpLoaded) return;

    setLoading(true);
    setError('');

    try {
      if (isNewUser) {
        const result = await signUp!.attemptEmailAddressVerification({
          code: code.trim(),
        });
        if (result.status === 'complete') {
          await setSignUpActive!({ session: result.createdSessionId });
          navigate('/');
        }
      } else {
        const result = await signIn!.attemptFirstFactor({
          strategy: 'email_code',
          code: code.trim(),
        });
        if (result.status === 'complete') {
          await setSignInActive!({ session: result.createdSessionId });
          navigate('/');
        }
      }
    } catch (err: any) {
      const msg =
        err?.errors?.[0]?.longMessage ||
        err?.errors?.[0]?.message ||
        'Invalid code. Please try again.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4 relative overflow-hidden">
      {/* Grid background */}
      <div className="absolute inset-0 z-0">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]" />
      </div>

      <div className="z-10 flex flex-col items-center gap-3 w-full max-w-sm">
        <p className="text-xs font-mono text-muted-foreground uppercase tracking-widest text-center">
          Please use your Circle email to verify your authorization
        </p>

        <div className="bg-white rounded-xl shadow-lg p-8 w-full">
          <h1 className="text-xl font-bold text-center text-gray-900 mb-6 leading-snug">
            Welcome to
            <br />
            The Earnings Edge Software
          </h1>

          {step === 'email' ? (
            <form onSubmit={handleEmailSubmit} className="flex flex-col gap-4">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Enter your email address"
                required
                disabled={loading}
                autoFocus
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent disabled:opacity-50 text-sm"
              />
              {error && <p className="text-sm text-red-600">{error}</p>}
              <button
                type="submit"
                disabled={loading || !email.trim()}
                className="w-full bg-gray-900 text-white py-2 rounded-md font-medium text-sm hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1"
              >
                {loading ? 'Checking…' : <>Continue &rarr;</>}
              </button>
            </form>
          ) : (
            <form onSubmit={handleCodeSubmit} className="flex flex-col gap-4">
              <p className="text-sm text-gray-600 text-center">
                We sent a 6-digit code to
                <br />
                <span className="font-semibold text-gray-900">{email}</span>
              </p>
              <input
                type="text"
                value={code}
                onChange={(e) =>
                  setCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                }
                placeholder="000000"
                required
                disabled={loading}
                autoFocus
                inputMode="numeric"
                maxLength={6}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 placeholder-gray-400 text-center text-2xl tracking-[0.5em] font-mono focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent disabled:opacity-50"
              />
              {error && <p className="text-sm text-red-600">{error}</p>}
              <button
                type="submit"
                disabled={loading || code.length < 6}
                className="w-full bg-gray-900 text-white py-2 rounded-md font-medium text-sm hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Verifying…' : 'Verify →'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setStep('email');
                  setCode('');
                  setError('');
                }}
                className="text-xs text-gray-400 hover:text-gray-600 underline text-center"
              >
                Use a different email
              </button>
            </form>
          )}

          <p className="text-center text-xs text-gray-400 mt-6">
            Secured by{' '}
            <span className="font-medium">Clerk</span>
          </p>
        </div>
      </div>
    </div>
  );
}
