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
 *
 * Uses Clerk v6's "Future API":
 *   useSignIn() → { signIn, fetchStatus }
 *   signIn.emailCode.sendCode / verifyCode / finalize()
 *   useSignUp() → { signUp, fetchStatus }
 *   signUp.verifications.sendEmailCode / verifyEmailCode / finalize()
 */

import { useState, useEffect, useRef } from 'react';
import { useSignIn, useSignUp } from '@clerk/react';
import { useLocation } from 'wouter';

type PreflightResult = 'authorized' | 'unauthorized' | 'unavailable';

async function preflightCircleCheck(email: string): Promise<PreflightResult> {
  try {
    const res = await fetch(`${window.location.origin}/api/auth/preflight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    // 503 means the Circle API itself was unreachable — not a denial.
    if (res.status === 503) return 'unavailable';
    if (!res.ok) return 'unauthorized';
    const data = await res.json();
    return data.authorized === true ? 'authorized' : 'unauthorized';
  } catch {
    // Network failure reaching our own API — treat as unavailable.
    return 'unavailable';
  }
}

const RESEND_COOLDOWN_S = 30;

type Step = 'email' | 'code';
type ResendStatus = 'idle' | 'sending' | 'sent';

export default function CustomSignInPage() {
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [isNewUser, setIsNewUser] = useState(false);

  // Resend-code state
  const [resendCooldown, setResendCooldown] = useState(0); // seconds remaining
  const [resendStatus, setResendStatus] = useState<ResendStatus>('idle');
  const cooldownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Clerk v6 Future API — hooks return { signIn/signUp, errors, fetchStatus }
  const { signIn, fetchStatus: signInFetchStatus } = useSignIn();
  const { signUp, fetchStatus: signUpFetchStatus } = useSignUp();
  const [, navigate] = useLocation();

  const clerkReady =
    signInFetchStatus !== 'fetching' && signUpFetchStatus !== 'fetching';

  /** Start the 30-second cooldown countdown. */
  function startCooldown() {
    setResendCooldown(RESEND_COOLDOWN_S);
    if (cooldownTimer.current) clearInterval(cooldownTimer.current);
    cooldownTimer.current = setInterval(() => {
      setResendCooldown((prev) => {
        if (prev <= 1) {
          clearInterval(cooldownTimer.current!);
          cooldownTimer.current = null;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }

  // Clear the timer when the component unmounts.
  useEffect(() => {
    return () => {
      if (cooldownTimer.current) clearInterval(cooldownTimer.current);
    };
  }, []);

  // Start the cooldown as soon as the code step is first shown.
  useEffect(() => {
    if (step === 'code') startCooldown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!clerkReady || !signIn || !signUp) return;

    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail) return;

    setLoading(true);
    setError('');

    try {
      // Step 1: Check Circle membership before touching Clerk
      const preflight = await preflightCircleCheck(trimmedEmail);
      if (preflight === 'unavailable') {
        setError(
          "Unable to verify your Circle membership right now — please try again in a moment.",
        );
        setLoading(false);
        return;
      }
      if (preflight === 'unauthorized') {
        setError(
          "This email isn't authorized. Please use the email address registered in your Circle community.",
        );
        setLoading(false);
        return;
      }

      // Step 2a: Try sending a code for an existing Clerk user
      try {
        await signIn.emailCode.sendCode({ emailAddress: trimmedEmail });
        setIsNewUser(false);
        setStep('code');
      } catch (signInErr: any) {
        const errCode = signInErr?.errors?.[0]?.code;
        // Step 2b: No Clerk account yet — create one and send verification code
        if (errCode === 'form_identifier_not_found') {
          await signUp.create({ emailAddress: trimmedEmail });
          await signUp.verifications.sendEmailCode();
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
    if (!clerkReady || !signIn || !signUp) return;

    setLoading(true);
    setError('');

    try {
      if (isNewUser) {
        await signUp.verifications.verifyEmailCode({ code: code.trim() });
        if (signUp.status === 'complete') {
          await signUp.finalize();
          navigate('/');
        }
      } else {
        await signIn.emailCode.verifyCode({ code: code.trim() });
        if (signIn.status === 'complete') {
          await signIn.finalize();
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

  const handleResend = async () => {
    if (!clerkReady || resendCooldown > 0 || !signIn || !signUp) return;

    setResendStatus('sending');
    setError('');

    try {
      if (isNewUser) {
        await signUp.verifications.sendEmailCode();
      } else {
        // No params — resends to the identifier already set on the signIn
        await signIn.emailCode.sendCode();
      }
      setResendStatus('sent');
      startCooldown();
      // Reset confirmation label after 2s
      setTimeout(() => setResendStatus('idle'), 2000);
    } catch (err: any) {
      setResendStatus('idle');
      const msg =
        err?.errors?.[0]?.longMessage ||
        err?.errors?.[0]?.message ||
        'Could not resend the code. Please try again.';
      setError(msg);
    }
  };

  const resendLabel =
    resendStatus === 'sending'
      ? 'Sending…'
      : resendStatus === 'sent'
        ? 'Code resent ✓'
        : resendCooldown > 0
          ? `Resend code (${resendCooldown}s)`
          : 'Resend code';

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
                disabled={loading || !email.trim() || !clerkReady}
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

              {/* Resend + back row */}
              <div className="flex items-center justify-between text-xs">
                <button
                  type="button"
                  onClick={handleResend}
                  disabled={resendCooldown > 0 || resendStatus === 'sending'}
                  className={
                    resendStatus === 'sent'
                      ? 'text-green-600 cursor-default'
                      : resendCooldown > 0 || resendStatus === 'sending'
                        ? 'text-gray-300 cursor-not-allowed'
                        : 'text-gray-500 hover:text-gray-700 underline'
                  }
                >
                  {resendLabel}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setStep('email');
                    setCode('');
                    setError('');
                    setResendStatus('idle');
                    if (cooldownTimer.current) {
                      clearInterval(cooldownTimer.current);
                      cooldownTimer.current = null;
                    }
                    setResendCooldown(0);
                  }}
                  className="text-gray-400 hover:text-gray-600 underline"
                >
                  Use a different email
                </button>
              </div>
            </form>
          )}

          <p className="text-center text-xs text-gray-400 mt-6">
            Secured by <span className="font-medium">Clerk</span>
          </p>
        </div>
      </div>
    </div>
  );
}
