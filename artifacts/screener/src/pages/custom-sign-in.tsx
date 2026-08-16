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

/**
 * Clerk v6 Future API methods do NOT throw on API errors — they resolve to
 * `{ error: ClerkError | null }`.  A `null` error means success.
 * This helper turns a ClerkError into a user-displayable message.
 */
type ClerkErrorLike = {
  code?: string;
  longMessage?: string;
  message?: string;
  errors?: Array<{ code?: string; longMessage?: string; message?: string }>;
} | null;

function clerkErrorMessage(err: ClerkErrorLike, fallback: string): string {
  // API failures surface as ClerkAPIResponseError: the useful longMessage is
  // nested in err.errors[], while the top-level message is generic.
  const nested = err?.errors?.[0];
  return (
    nested?.longMessage ||
    nested?.message ||
    err?.longMessage ||
    err?.message ||
    fallback
  );
}

/**
 * Collects every error code from a Clerk error. API failures resolve to a
 * ClerkAPIResponseError whose top-level `code` is always the generic
 * "api_response_error" — the specific code (e.g. "form_identifier_not_found")
 * is nested in `error.errors[].code`. Check both.
 */
function clerkErrorCodes(err: ClerkErrorLike): string[] {
  const codes: string[] = [];
  if (err?.code) codes.push(err.code);
  for (const nested of err?.errors ?? []) {
    if (nested?.code) codes.push(nested.code);
  }
  return codes;
}

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

      // Step 2a: Try sending a code for an existing Clerk user.
      // Clerk's Future API resolves to { error } instead of throwing.
      const { error: sendError } = await signIn.emailCode.sendCode({
        emailAddress: trimmedEmail,
      });
      if (!sendError) {
        setIsNewUser(false);
        setStep('code');
        return;
      }

      // Step 2b: No Clerk account yet — create one and send verification code
      if (clerkErrorCodes(sendError).includes('form_identifier_not_found')) {
        const { error: createError } = await signUp.create({
          emailAddress: trimmedEmail,
        });
        if (createError) {
          setError(clerkErrorMessage(createError, 'Could not create your account. Please try again.'));
          return;
        }
        const { error: signUpSendError } = await signUp.verifications.sendEmailCode();
        if (signUpSendError) {
          setError(clerkErrorMessage(signUpSendError, 'Could not send the verification code. Please try again.'));
          return;
        }
        setIsNewUser(true);
        setStep('code');
        return;
      }

      // Any other send failure: stay on the email step and show the error.
      setError(clerkErrorMessage(sendError, 'Could not send the verification code. Please try again.'));
    } catch (err: any) {
      // Unexpected (network/runtime) failure — Future API errors are handled above.
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
        const { error: verifyError } = await signUp.verifications.verifyEmailCode({
          code: code.trim(),
        });
        if (verifyError) {
          setError(clerkErrorMessage(verifyError, 'Invalid code. Please try again.'));
          return;
        }
        if (signUp.status === 'complete') {
          const { error: finalizeError } = await signUp.finalize();
          if (finalizeError) {
            setError(clerkErrorMessage(finalizeError, 'Could not complete sign-up. Please try again.'));
            return;
          }
          navigate('/');
        } else {
          setError('Verification incomplete. Please try again.');
        }
      } else {
        const { error: verifyError } = await signIn.emailCode.verifyCode({
          code: code.trim(),
        });
        if (verifyError) {
          setError(clerkErrorMessage(verifyError, 'Invalid code. Please try again.'));
          return;
        }
        if (signIn.status === 'complete') {
          const { error: finalizeError } = await signIn.finalize();
          if (finalizeError) {
            setError(clerkErrorMessage(finalizeError, 'Could not complete sign-in. Please try again.'));
            return;
          }
          navigate('/');
        } else {
          setError('Verification incomplete. Please try again.');
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
      const { error: resendError } = isNewUser
        ? await signUp.verifications.sendEmailCode()
        : // No params — resends to the identifier already set on the signIn
          await signIn.emailCode.sendCode();
      if (resendError) {
        setResendStatus('idle');
        setError(clerkErrorMessage(resendError, 'Could not resend the code. Please try again.'));
        return;
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
        <img
          src="/ees-hex-logo.png"
          alt="Earnings Edge Software"
          className="h-16 w-16 object-contain"
        />

        <p className="text-xs font-mono text-muted-foreground uppercase tracking-widest text-center">
          Please use your Circle email to verify your authorization
        </p>

        <div className="bg-card rounded-xl shadow-lg p-8 w-full border border-border">
          <h1 className="text-xl font-bold text-center text-card-foreground mb-6 leading-snug">
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
                className="w-full px-3 py-2 border border-input rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent disabled:opacity-50 text-sm bg-background"
              />
              {error && <p className="text-sm text-down">{error}</p>}
              <button
                type="submit"
                disabled={loading || !email.trim() || !clerkReady}
                className="w-full bg-blue-950 text-white py-2 rounded-md font-medium text-sm hover:bg-blue-900 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1"
              >
                {loading ? 'Checking…' : <>Continue &rarr;</>}
              </button>
            </form>
          ) : (
            <form onSubmit={handleCodeSubmit} className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground text-center">
                We sent a 6-digit code to
                <br />
                <span className="font-semibold text-foreground">{email}</span>
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
                className="w-full px-3 py-2 border border-input rounded-md text-foreground placeholder:text-muted-foreground text-center text-2xl tracking-[0.5em] font-mono focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent disabled:opacity-50 bg-background"
              />
              {error && <p className="text-sm text-down">{error}</p>}
              <button
                type="submit"
                disabled={loading || code.length < 6}
                className="w-full bg-blue-950 text-white py-2 rounded-md font-medium text-sm hover:bg-blue-900 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
                      ? 'text-up cursor-default'
                      : resendCooldown > 0 || resendStatus === 'sending'
                        ? 'text-muted-foreground/40 cursor-not-allowed'
                        : 'text-muted-foreground hover:text-foreground underline'
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
                  className="text-muted-foreground/60 hover:text-muted-foreground underline"
                >
                  Use a different email
                </button>
              </div>
            </form>
          )}

          <p className="text-center text-xs text-muted-foreground mt-6">
            Secured by <span className="font-medium">Clerk</span>
          </p>
        </div>
      </div>
    </div>
  );
}
